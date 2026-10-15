// endzone-4.2 held-out calibration: walk-forward fits, budget, volume bands; caps and budget invariants still hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import FITS from '../src/calibration-fits.json' with { type: 'json' };
import { fitFor, applyVolCal, fitBudget } from '../src/calibration.js';
import { makeFixture } from './fixture.js';
import { runEngine } from '../src/engine.js';
import { MODEL_VERSION } from '../src/model.js';

test('model version bumped to 4.2.2', () => assert.equal(MODEL_VERSION, 'endzone-4.2.2'));

test('shipped fits are walk-forward: entry for week w is only usable at week >= w', () => {
  for (const f of FITS.fits) { assert.equal(fitFor(f.season, f.week).id, `${f.season}-w${f.week}`); if (f.week > 1) assert.notEqual(fitFor(f.season, f.week - 1).id, `${f.season}-w${f.week}`); }
  assert.equal(fitFor(2025, 18), null, 'no fit for weeks before the first shipped cutoff');
  for (const f of FITS.fits) { assert.ok(f.budget.b > 0.05 && f.budget.b < 0.3, 'budget slope sane'); assert.ok(f.budget.n >= 100); }
});

test('budget fit recovers a known line; volume recalibration keeps lo <= mean <= hi and lo >= 0', () => {
  const rows = []; for (let g = 0; g < 200; g++) { const imp = 15 + (g % 20); rows.push({ gameId: 'g' + g, side: 'home', implied: imp, td: 0.15 * imp - 1 }); }
  const b = fitBudget(rows); assert.ok(Math.abs(b.b - 0.15) < 1e-9 && Math.abs(b.a + 1) < 1e-9);
  const cal = FITS.fits.at(-1).volcal;
  for (const m of ['rushYd', 'rec', 'recYd', 'passYd']) for (const mean of [0, 1, 10, 40, 80, 250]) {
    const v = applyVolCal(cal, m, { mean, lo: Math.max(0, mean * 0.4), hi: mean * 1.7 + 1 });
    assert.ok(v.lo >= 0 && v.lo <= v.mean + 1e-9 && v.mean <= v.hi + 1e-9, `${m} ${mean}`);
  }
});

test('engine with fits still respects safety caps and team TD budget; fits can be disabled', () => {
  const prep = makeFixture();
  const bf = { a: -1, b: 0.155, n: 999, id: 'test' };
  const on = runEngine(prep, { budgetFit: bf }), off = runEngine(prep, { budgetFit: false, volCal: false });
  for (const G of on.games) for (const s of ['away', 'home']) { const S = G.sides[s];
    assert.ok(S.teamLambda <= S.tdBudget + 1e-6); assert.ok(Math.abs(S.tdBudget - Math.max(0.4, -1 + 0.155 * S.implied)) < 1e-9);
    for (const p of S.raw) assert.ok(p.chance <= 0.62 + 1e-9); }
  for (const G of off.games) for (const s of ['away', 'home']) assert.ok(Math.abs(G.sides[s].tdBudget - G.sides[s].implied * 0.7 / 6.9) < 1e-9);
});

test('4.2.1 experiment hooks are off by default and never relax caps unless explicitly requested', () => {
  const prep = makeFixture();
  const a = runEngine(prep, {}), b = runEngine(prep, { exp: {} });
  const ch = r => r.games.flatMap(G => ['away', 'home'].flatMap(s => G.sides[s].raw.map(p => p.chance)));
  assert.deepEqual(ch(a), ch(b));
  for (const G of a.games) for (const s of ['away', 'home']) for (const p of G.sides[s].raw) { assert.ok(p.chance <= 0.62 + 1e-9); if (p.preSafety != null && !p.recentFinisher) assert.ok(p.chance <= 0.5 + 1e-9); }
});

test('data-fit caps (user-approved override, off by default): bounded, ordered, gated by role, and binding after lessons', async () => {
  const { safetyCalibrate, sanitizeCaps, FIXED_CAPS, CAP_LIMITS } = await import('../src/model.js');
  const { fitCaps } = await import('../src/calibration.js');
  const wild = sanitizeCaps({ pullT: 0.9, pullS: 5, ceil: 0.99, cold: 0.99, fin: 0.99, floor: 0.5 });
  for (const [k, [lo, hi]] of Object.entries(CAP_LIMITS)) assert.ok(wild[k] >= lo && wild[k] <= hi, k);
  assert.ok(wild.fin <= 0.75 && wild.cold <= wild.ceil && wild.fin >= wild.ceil);
  const C = { pullT: 0.4, pullS: 0.2, ceil: 0.55, cold: 0.48, fin: 0.61, floor: 0.15 };
  assert.equal(safetyCalibrate(0.7, { insideFinisher: true }, C).chance, 0.55);
  assert.equal(safetyCalibrate(0.7, { insideFinisher: true, coldGoal: true }, C).chance, 0.48);
  assert.equal(safetyCalibrate(0.9, { insideFinisher: true, recentFinisher: true }, C).chance, 0.61);
  assert.ok(safetyCalibrate(0.45, { insideFinisher: false }, C).chance <= 0.45);
  assert.equal(safetyCalibrate(0.45, { insideFinisher: true }, C).chance, 0.45, 'pull only for players without an inside-10 role');
  assert.deepEqual(safetyCalibrate(0.7, { insideFinisher: true }), safetyCalibrate(0.7, { insideFinisher: true }, null), 'default = fixed spec values');
  assert.equal(safetyCalibrate(0.7, { insideFinisher: true }).chance, FIXED_CAPS.ceil);
  assert.equal(fitCaps([]), null, 'small samples fall back to fixed values');
  // engine: fitted ceilings bind even with an aggressive lesson scale
  const prep = makeFixture();
  const res = runEngine(prep, { caps: C, lessons: { spot: Object.fromEntries(['r1', 'r2', 'r3', 't1', 't2', 't3'].map(k => [k, 3])) } });
  for (const G of res.games) for (const s of ['away', 'home']) { const S = G.sides[s]; assert.ok(S.teamLambda <= S.tdBudget + 1e-6);
    for (const p of S.raw) assert.ok(p.chance <= (p.ceiling ?? C.fin) + 1e-9 && p.chance <= C.fin + 1e-9, `${p.name} ${p.chance} > fitted ceiling`); }
});
