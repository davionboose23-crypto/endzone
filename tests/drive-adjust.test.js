// endzone app 4.8.0: drive-pattern adjustment (bounded, reliability-shrunk, weight fitted walk-forward) + Drives section data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { driveAdjustFor, driveMultiplier, applyToChance, pLead, expectedDrives, DRIVE_CAP, DRIVES_KIND, REL_WEIGHT } from '../src/drive-adjust.js';
import { blendChallenger } from '../src/usage-model.js';
import { pairedBoot } from '../src/drive-score.js';

const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w8.json', import.meta.url)));
const withPat = Object.entries(D.players).filter(([, r]) => (r.patterns || []).length);
const sample = ([gsis, r]) => ({ gsis, team: r.team, pos: r.pos, id: 'x' + gsis });

test('weekly drive file carries league, defense, offense, teams and the walk-forward fit', () => {
  assert.ok(D.league.dpg > 8 && D.league.dpg < 13);
  assert.equal(Object.keys(D.defense).length, 32); assert.equal(Object.keys(D.offense).length, 32);
  assert.ok(D.teams.DET.games.length >= 5); assert.ok(D.teams.DET.people.length > 3);
  assert.ok(D.fit && D.fit.weight && 'blend' in D.fit.weight && 'model' in D.fit.weight);
  for (const t of Object.values(D.defense)) for (const k of ['rzPer', 'tdPer', 'rzTd', 'gtgTd', 'openTd']) assert.ok(t.q[k] >= 0 && t.q[k] <= 1);
});

test('weight 0 computes the adjustment but moves the chance by exactly 0', () => {
  assert.ok(withPat.length > 10);
  let nonzero = 0;
  for (const e of withPat) { const a = driveAdjustFor(D, sample(e), { opp: 'MIN', spread: -3, weight: 0 }); assert.equal(a.logm, 0); assert.equal(a.mult, 1); if (Math.abs(a.raw) > 1e-6) nonzero++; }
  assert.ok(nonzero > 5, 'signal exists at full weight');
  assert.equal(applyToChance(0.3, 0), 0.3);
});

test('adjustment is capped at +-10% of the intensity whatever the weight', () => {
  for (const e of withPat) { const a = driveAdjustFor(D, sample(e), { opp: 'DET', spread: 7, weight: 50 }); assert.ok(Math.abs(a.logm) <= DRIVE_CAP + 1e-12); }
  const m = driveMultiplier({ raw: 5, items: [{ raw: 5 }] }, 1); assert.ok(m.capped && Math.abs(m.mult - 1.1) < 1e-9);
});

test('"worth watching" items never enter the adjustment; only strong / moderate patterns do', () => {
  for (const e of withPat) { const a = driveAdjustFor(D, sample(e), { weight: 1 }); for (const x of a.items) assert.ok(x.rel in REL_WEIGHT); }
});

test('context: spread drives P(lead); expected drives average offense and defense', () => {
  assert.ok(pLead(-7) > 0.6 && pLead(7) < 0.4 && Math.abs(pLead(0) - 0.5) < 1e-9);
  const x = expectedDrives({ dpg: 11 }, { dpg: 10 }, { dpg: 10.6 }); assert.ok(x > 10 && x < 11);
});

test('blend + drives challenger equals the blend at weight 0 and records the adjustment', () => {
  const D0 = { ...D, fit: { ...D.fit, weight: { blend: 0, model: 0 } } };
  const fn = blendChallenger(null, D0); const [gsis, r] = withPat[0];
  const out = fn({ ...sample([gsis, r]), chance: 0.3, published: 0.32 }, { opp: 'MIN', spread: -3 });
  assert.ok(out && out.drives); assert.equal(out.drives.after, out.p); assert.ok(out.drives.adj && Array.isArray(out.drives.adj.items));
  const D1 = { ...D, fit: { ...D.fit, weight: { blend: 1, model: 0 } } };
  const o1 = blendChallenger(null, D1)({ ...sample([gsis, r]), chance: 0.3, published: 0.32 }, { opp: 'MIN', spread: -3 });
  assert.ok(Math.abs(Math.log(-Math.log(1 - o1.drives.after)) - Math.log(-Math.log(1 - o1.p))) <= DRIVE_CAP + 1e-9);
  assert.equal(DRIVES_KIND, 'blend3+drives');
});

test('live scoreboard bootstrap: identical forecasts give exactly 0', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ gameId: 'g' + (i % 8), y: i % 3 === 0 ? 1 : 0, a: 0.3, b: 0.3 }));
  const r = pairedBoot(rows, 'a', 'b'); assert.equal(r.dBrier, 0); assert.equal(r.dLogLoss, 0); assert.equal(r.games, 8);
});
