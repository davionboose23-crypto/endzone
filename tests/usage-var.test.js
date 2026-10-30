// endzone app 4.13.0: usage-var-1 — "it's not always the favourite who scores" (src/usage-var.js). Sim-only: the board,
// MODEL_VERSION and the challenger gate do not move. Inputs are FROZEN fixtures (the 4.9.2 CAR @ GB sim inputs + week-8 pbp params).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { temper, anchorFor, dispFor, surprise, DISP_DEFAULT } from '../src/usage-var.js';
import { runSim, summarize } from '../src/sim.js';
import { buildPbpInputs, calibratePbp, simulatePbp, summarizePbp } from '../src/sim-pbp.js';
import { MODEL_VERSION } from '../src/model.js';

const { I: I0 } = JSON.parse(fs.readFileSync(new URL('./fixtures/sim-inputs-2026w8-CAR-GB-492.json', import.meta.url)));
const PP = JSON.parse(fs.readFileSync(new URL('./fixtures/pbp-params-2026w8-v2.json', import.meta.url)));

test('defaults: anchor on, tempering and per-game usage noise off (walk-forward picked them), model untouched', () => {
  assert.equal(MODEL_VERSION, 'endzone-4.6.0');
  assert.equal(anchorFor({}, 'drive'), 1); assert.equal(anchorFor({}, 'pbp'), 1); assert.equal(anchorFor({ disp: false }, 'drive'), 0);
  assert.equal(anchorFor({ disp: { drive: { anchor: 0.5 } } }, 'drive'), 0.5);
  assert.equal(dispFor({}, 'drive').tau, DISP_DEFAULT.drive.tau); assert.equal(dispFor({}, 'drive').tau, 1); assert.equal(dispFor({}, 'pbp').kappa, Infinity);
});

test('temper keeps the total, tau 1 is the identity, tau < 1 flattens toward the depth chart', () => {
  const w = [0.5, 0.3, 0.15, 0.05]; assert.deepEqual(temper(w, 1).map(x => +x.toFixed(12)), w);
  const f = temper(w, 0.6); assert.ok(Math.abs(f.reduce((a, x) => a + x, 0) - 1) < 1e-9); assert.ok(f[0] < w[0] && f[3] > w[3]);
});

const tdErr = s => s.team.reduce((a, t, k) => a + Math.abs(t.mean.td - I0.teams[k].tdBudget), 0);
test('drive sim: the TD-level anchor pulls each team toward the model TD budget', () => {
  const off = summarize(runSim({ ...I0, disp: false }, { n: 2500, seed: 3 }), I0), on = summarize(runSim(I0, { n: 2500, seed: 3 }), I0);
  assert.ok(tdErr(on) < tdErr(off), `anchored ${tdErr(on)} vs free ${tdErr(off)}`); assert.ok(tdErr(on) < 0.35);
});

test('play-by-play sim: the TD-level anchor pulls each team toward the model TD budget', () => {
  const run = I1 => { const I = buildPbpInputs(I1, PP); const { E } = calibratePbp(I, { seed: 21 }); return summarizePbp(simulatePbp(I, { n: 2000, seed: 5, E }), I); };
  const off = run({ ...I0, disp: false }), on = run(I0); assert.ok(tdErr(on) < tdErr(off), `anchored ${tdErr(on)} vs free ${tdErr(off)}`); assert.ok(tdErr(on) < 0.5);
});

test('surprise: chance a TD comes from outside the top 4, longshots ranked just below them', () => {
  const s = summarize(runSim(I0, { n: 2000, seed: 9 }), I0); const u = s.surprise; assert.ok(u && u.top === 4);
  assert.ok(u.pOutside > 0.3 && u.pOutside < 0.99, String(u.pOutside)); assert.ok(u.shareOutside > 0.15 && u.shareOutside < 0.8);
  const ord = [...s.players].sort((a, b) => b.anytime - a.anytime); assert.equal(u.longshots.length, 3);
  assert.deepEqual(u.longshots.map(x => x.name), ord.slice(4, 7).map(p => p.name));
  // a tiny hand-made case: one game, the 5th-ranked player scores
  const S = { n: 1, NP: 5, G: { td: [0, 0, 0, 0, 1] } }; const pl = [0.5, 0.4, 0.3, 0.2, 0.1].map((a, j) => ({ j, anytime: a, name: 'p' + j }));
  assert.deepEqual([surprise(S, pl).pOutside, surprise(S, pl).shareOutside], [1, 1]);
});
