// User-approved additions: adaptive published blend, pick tracker, watch-alerts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeFixture } from './fixture.js';
import { runEngine } from '../src/engine.js';
import { pubBlendWeight } from '../src/pipeline.js';
import { pickTracker } from '../src/research.js';
import { snapshotFromGame } from '../src/grading.js';
import { Archive } from '../server/archive.js';
import { watchAlerts } from '../scripts/watch-alerts.mjs';
import { MODEL_VERSION, DEFAULT_WEIGHTS } from '../src/model.js';
const firstKick = prep => Math.min(...prep.games.filter(g => g.week === prep.week).map(g => Date.parse(g.kickoff)));

test('adaptive published blend: heavier for thin/low-evidence players, caps and team budget still hold', () => {
  assert.equal(pubBlendWeight(0, { games: 0 }), 0);
  assert.ok(pubBlendWeight(1, { games: 1, recentRzLooks: 5 }) > pubBlendWeight(1, { games: 8, recentRzLooks: 5 }), 'thin sample blends more');
  assert.ok(pubBlendWeight(1, { games: 8, recentRzLooks: 0 }) > pubBlendWeight(1, { games: 8, recentRzLooks: 6 }), 'weak red-zone evidence blends more');
  assert.ok(pubBlendWeight(1, { games: 0, recentRzLooks: 0, unverified: true }) <= 1);
  const prep = makeFixture(); const now = firstKick(prep) - 86400e3;
  const on = runEngine(prep, { now, pubTdBlend: 1 }), off = runEngine(prep, { now, pubTdBlend: 0 });
  let blended = 0;
  for (const G of on.games) for (const s of ['away', 'home']) {
    const S = G.sides[s];
    assert.ok(S.teamLambda <= S.tdBudget + 1e-6, 'team budget holds');
    for (const p of S.raw) { assert.ok(p.chance <= (p.ceiling ?? 0.62) + 1e-9 && p.chance <= 0.62 + 1e-9, 'safety ceiling holds'); if (p.pubBlend) blended++; if (!p.proj) assert.equal(p.pubBlend, null); }
  }
  assert.ok(blended > 0, 'blend applied to players with a published projection');
  const a = on.games[0].sides.away.raw.find(p => p.pubBlend), b = off.games[0].sides.away.raw.find(p => p.id === a?.id);
  if (a && b) assert.equal(b.pubBlend, null);
});

test('pick tracker separates prospective and reconstructed, excludes pending from hit rates', () => {
  const row = (o) => ({ id: o.id, name: o.id, team: 'KC', pos: 'RB', chance: 0.4, tdConf: o.conf || 'Med', teamCall: !!o.call, prospective: !!o.pro, actual: o.act });
  const T = pickTracker({ 3: [row({ id: 'a', call: 1, act: { status: 'confirmed', td: 1 } }), row({ id: 'b', call: 1, act: { status: 'confirmed-zero', td: 0 } }), row({ id: 'c', conf: 'High', act: { status: 'confirmed', td: 2 } })],
    4: [row({ id: 'd', call: 1, pro: 1, conf: 'High', act: { status: 'confirmed', td: 1 } }), row({ id: 'e', call: 1, pro: 1, act: { status: 'pending' } })] });
  assert.deepEqual(T.totals.reconstructed.teamCalls, { hits: 1, total: 2 });
  assert.deepEqual(T.totals.reconstructed.highTd, { hits: 1, total: 1 });
  assert.deepEqual(T.totals.prospective.teamCalls, { hits: 1, total: 1 });
  assert.equal(T.weeks.find(w => w.week === 4).groups.prospective.teamCalls.pending, 1);
  assert.equal(T.weeks.find(w => w.week === 4).groups.reconstructed, undefined, 'no mixing');
});

test('watch-alerts: reports injury and status changes vs the latest saved snapshot, read-only', async () => {
  const prep = makeFixture(); const now = firstKick(prep) - 86400e3;
  const a = await Archive.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ez-wa-')), 'a.sqlite'));
  const base = runEngine(prep, { now });
  for (const G of base.games) a.saveSnapshot(snapshotFromGame(G, { modelVersion: MODEL_VERSION, weights: DEFAULT_WEIGHTS }), { now: new Date(now) });
  const G0 = base.games[0]; const q = G0.sides.away.players[0], o = G0.sides.home.players[0];
  const later = makeFixture({ mutate: p => { p.players.find(x => x.id === q.id).injury = 'Questionable'; p.players.find(x => x.id === o.id).injury = 'Out'; } });
  const before = a.snapshots(prep.season, prep.week).length;
  const out = await watchAlerts({ archive: a, prep: later, watch: new Set([q.id]), minChance: 0, now: now + 3600e3 });
  assert.equal(a.snapshots(prep.season, prep.week).length, before, 'nothing saved');
  const aq = out.alerts.find(x => x.id === q.id); assert.ok(aq && aq.reasons.includes('watchlist'));
  assert.ok(aq.changes.some(c => c.field === 'injury' && c.after === 'Questionable'));
  const ao = out.alerts.find(x => x.id === o.id); assert.ok(ao.changes.some(c => c.field === 'status' && /Out/.test(c.after)));
  const quiet = await watchAlerts({ archive: a, prep, watch: new Set(), minChance: 0, now: now + 3600e3 });
  assert.equal(quiet.alerts.length, 0, 'no changes, no alerts');
});
