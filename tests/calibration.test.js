// endzone-4.2 held-out calibration: walk-forward fits, budget, volume bands; caps and budget invariants still hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import FITS from '../src/calibration-fits.json' with { type: 'json' };
import { fitFor, applyVolCal, fitBudget } from '../src/calibration.js';
import { makeFixture } from './fixture.js';
import { runEngine } from '../src/engine.js';
import { MODEL_VERSION } from '../src/model.js';

test('model version bumped to 4.2', () => assert.equal(MODEL_VERSION, 'endzone-4.2.0'));

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
