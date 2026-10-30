// endzone app 4.11.0: sim-pbp-2 realism checks (Drives → Simulator → play-by-play). Research / UI only; never feeds the board,
// the model or the challenger gate. FROZEN fixtures: 4.9.2 sim inputs for CAR @ GB + week-8 params refit with the X2 terms
// (fitted on 2025 + 2026 weeks 1-7 only), so the scheduled refresh rewriting archive/pbp/ cannot move these tolerances.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPbpInputs, calibratePbp, simulatePbp, summarizePbp, runPbp, replayGame, SIM_PBP_TUNE, SIM_PBP_VERSION } from '../src/sim-pbp.js';
import { MODEL_VERSION } from '../src/model.js';

const { I: I0 } = JSON.parse(fs.readFileSync(new URL('./fixtures/sim-inputs-2026w8-CAR-GB-492.json', import.meta.url)));
const PP = JSON.parse(fs.readFileSync(new URL('./fixtures/pbp-params-2026w8-v2.json', import.meta.url)));
const I = buildPbpInputs(I0, PP);
const { E } = calibratePbp(I, { seed: 21 });
const S = simulatePbp(I, { n: 3000, seed: 5, E });
const sum = summarizePbp(S, I);
const marginSd = X => { let m = 0, v = 0; for (let g = 0; g < X.n; g++) m += X.score[2 * g] - X.score[2 * g + 1]; m /= X.n; for (let g = 0; g < X.n; g++) v += (X.score[2 * g] - X.score[2 * g + 1] - m) ** 2; return Math.sqrt(v / X.n); };

test('sim-pbp-2 is research-only and versioned', () => {
  assert.equal(MODEL_VERSION, 'endzone-4.6.0');
  assert.equal(SIM_PBP_VERSION, 'sim-pbp-2'); assert.equal(sum.pbp.version, 'sim-pbp-2'); assert.equal(sum.pbp.v2, true);
  assert.ok(SIM_PBP_TUNE.form > 0 && SIM_PBP_TUNE.form < 0.5, 'game-day form tuned on 2025 only');
  assert.ok(PP.X2 && PP.X2.v === 2 && PP.through < PP.week, 'v2 terms fitted on earlier weeks only');
});

test('legacy switch reproduces sim-pbp-1 exactly (params without X2 run the old engine)', () => {
  const P1 = { ...PP }; delete P1.X2;
  const a = runPbp(buildPbpInputs(I0, PP, { legacy: true }), { n: 300, seed: 3 }), b = runPbp(buildPbpInputs(I0, P1), { n: 300, seed: 3 });
  assert.deepEqual(Array.from(a.score), Array.from(b.score)); assert.equal(a.eng.version, 'sim-pbp-1');
});

test('situations: 3rd/4th downs, kicking, sneaks, spikes and penalties land in real NFL ranges', () => {
  for (const t of sum.pbp.sit) {
    const c3 = t.d3c / t.d3; assert.ok(c3 > 0.3 && c3 < 0.48, `3rd-down conversion ${c3.toFixed(3)}`);
    assert.ok(t.d4 > 0.5 && t.d4 < 2.5, `4th-down tries ${t.d4.toFixed(2)}`); const c4 = t.d4c / t.d4; assert.ok(c4 > 0.4 && c4 < 0.7, `4th-down conversion ${c4.toFixed(3)}`);
    const fg = t.fgm / t.fga; assert.ok(fg > 0.75 && fg < 0.93, `FG ${fg.toFixed(3)}`); assert.ok(t.punt > 2.5 && t.punt < 6);
    assert.ok(t.sneak > 0.1 && t.sneak < 0.6, `sneaks ${t.sneak.toFixed(2)}`); const sc = t.sneakC / t.sneak; assert.ok(sc > 0.6 && sc < 0.9, `sneak conversion ${sc.toFixed(3)}`);
    assert.ok(t.spike < 0.4, `spikes ${t.spike.toFixed(2)} per game`); assert.ok(t.sack > 1 && t.sack < 4.5); assert.ok(t.int > 0.4 && t.int < 1.3);
    assert.ok(t.pen > 2 && t.pen < 8, `penalties ${t.pen.toFixed(2)}`); assert.ok(t.plays > 52 && t.plays < 72); assert.ok(t.yds > 280 && t.yds < 440);
  }
});

test('drive mix: TD share near the real 23%', () => {
  let tds = 0, drives = 0; for (let i = 0; i < S.n * 2; i++) { tds += S.tds[i]; drives += S.drives[i]; }
  const share = tds / drives; assert.ok(share > 0.19 && share < 0.27, `TD per drive ${share.toFixed(3)}`);
});

test('sneaks gain no more than the field, spikes are rare, both show in the game log', () => {
  let sn = 0, sp = 0;
  for (let g = 0; g < 150; g++) for (const e of replayGame(E, 5, g)) { if (e.t === 'play' && e.sneak) { sn++; assert.ok(e.yds <= e.yl); } if (e.t === 'spike') sp++; }
  assert.ok(sn > 20, `sneaks ${sn}`); assert.ok(sp > 0 && sp < 150, `spikes ${sp}`);
});

test('game-day form widens the spread of results; home-field terms are fitted and small', () => {
  const f0 = SIM_PBP_TUNE.form; SIM_PBP_TUNE.form = 0;
  try { const I2 = buildPbpInputs(I0, PP); const { E: E2 } = calibratePbp(I2, { seed: 21 }); const X = simulatePbp(I2, { n: 3000, seed: 5, E: E2 }); assert.ok(marginSd(S) > marginSd(X) + 0.5, `${marginSd(S).toFixed(2)} vs ${marginSd(X).toFixed(2)}`); }
  finally { SIM_PBP_TUNE.form = f0; }
  for (const [k, m] of Object.entries(PP.X2.M)) if (m.home) { assert.equal(m.home.length, 2, k); for (const v of m.home) assert.ok(Math.abs(v) < 0.2, `${k} home ${v}`); }
  let h = 0, a = 0; for (let g = 0; g < S.n; g++) { a += S.score[2 * g]; h += S.score[2 * g + 1]; } assert.ok(Number.isFinite(h / S.n - a / S.n));
});
