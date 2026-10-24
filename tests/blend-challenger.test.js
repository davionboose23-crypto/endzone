// endzone-4.6.0: 3-way blend challenger (model + Sleeper + nflverse usage leg) and the slice monitor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFixture } from './fixture.js';
import { runEngine } from '../src/engine.js';
import { MODEL_VERSION } from '../src/model.js';
import { promotionDecision } from '../src/validation.js';
import { blendProbability, blendChallenger, blendStatus, usageLookup, monitorReport, sideLines, cll, eta, BLEND_KIND, BLEND_CEILING, TE_GAP_PTS } from '../src/usage-model.js';
import { Archive } from '../server/archive.js';
import { refresh } from '../server/jobs.js';

const EARLY = Date.parse('2030-10-01T12:00:00Z');
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('blend = equal cloglog mean of the legs that exist, with documented fallbacks', () => {
  const all = blendProbability({ chance: 0.3, published: 0.4, usage: 0.2 });
  close(all.p, cll((eta(0.3) + eta(0.4) + eta(0.2)) / 3)); assert.deepEqual(all.legs, ['model', 'sleeper', 'usage']); assert.equal(all.usage, 0.2);
  const noUsage = blendProbability({ chance: 0.3, published: 0.4 });
  close(noUsage.p, cll((eta(0.3) + eta(0.4)) / 2)); assert.deepEqual(noUsage.legs, ['model', 'sleeper']);
  const noSleeper = blendProbability({ chance: 0.3, usage: 0.2 });
  close(noSleeper.p, cll((eta(0.3) + eta(0.2)) / 2)); assert.deepEqual(noSleeper.legs, ['model', 'usage']);
  const alone = blendProbability({ chance: 0.3 }); close(alone.p, 0.3, 1e-6); assert.deepEqual(alone.legs, ['model']);
  assert.equal(blendProbability({ chance: 0 }), null);
  assert.equal(blendProbability({ chance: 0.7, published: 0.8, usage: 0.75 }).p, BLEND_CEILING, 'hard ceiling');
  const mid = blendProbability({ chance: 0.1, published: 0.5 }).p; assert.ok(mid > 0.1 && mid < 0.5);
});

test('usage lookup: gsis or Sleeper id, line coefficients applied around their means', () => {
  const U = { season: 2030, week: 5, players: { '00-1': [ 'A', eta(0.25) ] }, bySleeper: { s1: '00-1' }, lineCoef: { implied: { b: 0.2, mu: 22, sd: 4 }, spread: { b: 0, mu: 0, sd: 6 }, home: { b: 0, mu: 0.5, sd: 0.5 } } };
  const look = usageLookup(U);
  close(look({ gsis: '00-1' }, { implied: 22, spread: 0, home: 0.5 >= 1 }), cll(eta(0.25) + 0.2 * 0 + 0 ), 1e-9);
  assert.ok(look({ id: 's1' }, { implied: 30 }) > look({ id: 's1' }, { implied: 18 }), 'higher implied total -> higher usage probability');
  close(look({ id: 's1' }, {}), 0.25, 1e-9); // missing lines -> coefficient means
  assert.equal(look({ id: 'nobody' }, {}), null);
  assert.equal(usageLookup(null), null);
  const fn = blendChallenger(U); assert.equal(fn.kind, BLEND_KIND); assert.equal(fn.noBudget, true);
  const r = fn({ id: 's1', chance: 0.3, published: { probability: 0.35 } }, { implied: 22 }); assert.deepEqual(r.legs, ['model', 'sleeper', 'usage']);
  const r0 = blendChallenger(null)({ id: 's1', chance: 0.3, published: { probability: 0.35 } }); assert.deepEqual(r0.legs, ['model', 'sleeper'], 'no table -> 50/50');
  assert.equal(blendStatus(U).status, BLEND_KIND); assert.equal(blendStatus(U).usage.players, 1); assert.match(blendStatus(null).reason, /50\/50/);
  assert.deepEqual(sideLines({ homeImplied: 27, awayImplied: 20, homeSpread: -7, awaySpread: 7 }, true), { implied: 27, spread: -7 });
});

test('engine: object challenger is applied after the safety caps, unbudgeted, and does not move the champion', () => {
  const base = runEngine(makeFixture(), { now: EARLY });
  const fn = blendChallenger(null);
  const res = runEngine(makeFixture(), { now: EARLY, challenger: fn });
  const ps = res.games.flatMap(g => [...g.sides.home.players, ...g.sides.away.players]);
  const bs = base.games.flatMap(g => [...g.sides.home.players, ...g.sides.away.players]);
  assert.ok(ps.length > 0);
  for (const p of ps) {
    const b = bs.find(x => x.id === p.id); close(p.chance, b.chance, 1e-12); // shadow: champion unchanged
    if (!(p.chance > 0)) continue;
    const pub = p.published?.probability; const want = blendProbability({ chance: p.chance, published: pub }).p;
    close(p.challenger, want, 1e-3); // engine rounds chance/published for display after the blend assert.ok(Array.isArray(p.challengerLegs) && p.challengerLegs[0] === 'model');
  }
});

test('promotion gate filters on challenger kind and model version', () => {
  const mk = (n, games, kind, mv = MODEL_VERSION) => Array.from({ length: n }, (_, i) => ({ gameId: `g${i % games}`, y: i % 4 === 0 ? 1 : 0, chance: 0.4, challenger: 0.25, prospective: true, modelVersion: mv, challengerKind: kind, teamCall: i % 10 === 1, tdConf: 'Med', contributor: true }));
  assert.equal(promotionDecision(mk(800, 50, BLEND_KIND), { modelVersion: MODEL_VERSION, kind: BLEND_KIND }).promote, true);
  assert.equal(promotionDecision(mk(800, 50, 'logistic'), { modelVersion: MODEL_VERSION, kind: BLEND_KIND }).metrics.paired, 0, 'retired logistic snapshots never count');
  assert.equal(promotionDecision(mk(800, 50, BLEND_KIND, 'endzone-4.5.2'), { modelVersion: MODEL_VERSION, kind: BLEND_KIND }).metrics.paired, 0, 'older versions never count');
  assert.equal(MODEL_VERSION, 'endzone-4.6.0');
});

test('monitor: slices, paired deltas, TE-gap flag', () => {
  const rows = []; for (let g = 0; g < 30; g++) for (let k = 0; k < 10; k++) {
    const te = k < 3; const y = te ? (k === 0 ? 1 : 0) : (k % 5 === 0 ? 1 : 0);
    rows.push({ gameId: `g${g}`, y, pos: te ? 'TE' : k === 9 ? 'QB' : 'WR', role: te ? 'TE1' : 'WR1', chance: te ? 0.15 : 0.2, challenger: te ? 0.17 : 0.2, published: te ? 0.2 : 0.21, implied: g % 2 ? 28 : 20, spread: g % 3 ? -8 : 3, glShare: 0.2, vol: { carries: k === 9 ? 5 : 0 } });
  }
  const m = monitorReport(rows, { label: 't', minTe: 60 });
  assert.equal(m.n, 300); assert.ok(m.slices.implied275.n > 0 && m.slices.fav7.n > 0 && m.slices.gl1535.n === 300 && m.slices.runQb.n === 30);
  assert.equal(m.slices.te1.n, 90); close(m.slices.te1.actual, 1 / 3, 1e-3);
  assert.ok(m.slices.all.vsModel && Array.isArray(m.slices.all.vsModel.dBrierCI));
  assert.equal(m.teGap.flagged, true, m.teGap.reason); assert.ok(m.teGap.gapBlendPts <= -TE_GAP_PTS);
  const closed = monitorReport(rows.map(r => r.role === 'TE1' ? { ...r, challenger: 0.33 } : r));
  assert.equal(closed.teGap.flagged, false);
  assert.equal(monitorReport([]).teGap.flagged, false);
});

test('refresh snapshots carry the blend challenger, its legs and kind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-blend-')); process.env.ENDZONE_USAGE_DIR = path.join(dir, 'usage');
  const a = await Archive.open(path.join(dir, 'a.db'));
  const r = await refresh(a, { prep: makeFixture(), now: () => EARLY }); assert.equal(r.ok, true, JSON.stringify(r.details));
  const s = a.snapshots(2030, 5)[0]; assert.equal(s.modelVersion, MODEL_VERSION); assert.equal(s.challenger.status, BLEND_KIND);
  const withC = s.players.filter(p => p.challenger != null); assert.ok(withC.length > 0);
  assert.ok(withC.every(p => Array.isArray(p.challengerLegs) && p.challengerLegs.includes('model')));
  delete process.env.ENDZONE_USAGE_DIR;
});
