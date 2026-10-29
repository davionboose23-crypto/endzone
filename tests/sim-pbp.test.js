// endzone app 4.10.0: play-by-play simulator (Drives → Simulator → "Play-by-play (beta)"). Research / UI only; never feeds the
// board, the model or the challenger gate. Inputs are FROZEN fixtures (sim inputs from 4.9.2 + the week-8 pbp params), so the
// scheduled refresh rewriting archive/pbp/ cannot move these tolerances.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPbpInputs, calibratePbp, simulatePbp, replayGame, summarizePbp, runPbp, pbpRunner, pbpPartial, finish, SIM_PBP_TUNE } from '../src/sim-pbp.js';
import { MODEL_VERSION } from '../src/model.js';

const { I: I0 } = JSON.parse(fs.readFileSync(new URL('./fixtures/sim-inputs-2026w8-CAR-GB-492.json', import.meta.url)));
const PP = JSON.parse(fs.readFileSync(new URL('./fixtures/pbp-params-2026w8.json', import.meta.url)));
const I = buildPbpInputs(I0, PP);
const { E } = calibratePbp(I, { seed: 21 });
const S = simulatePbp(I, { n: 3000, seed: 5, E });
const PTS = { td: 6 };

test('pbp inputs build for CAR @ GB and stay research-only', () => {
  assert.ok(I && I.mode === 'pbp' && I.pbp.side.length === 2);
  assert.equal(MODEL_VERSION, 'endzone-4.6.0');
  assert.equal(SIM_PBP_TUNE.spread, 4); // tuned on 2025 only (scripts/sim/validate-pbp.mjs)
});

test('down and distance: every snap follows from the one before', () => {
  let checked = 0;
  for (let g = 0; g < 60; g++) {
    const L = replayGame(E, 5, g); let prev = null;
    for (const e of L) {
      if (e.t === 'drive' || e.t === 'ko' || e.t === 'punt' || e.t === 'fg' || e.t === 'pat' || (e.t === 'note' && !/^Timeout|^Two-minute/.test(e.txt))) { prev = null; continue; }
      if (e.t === 'pen') { prev = null; continue; }
      if (e.t !== 'play') continue;
      assert.ok(e.down >= 1 && e.down <= 4, `down ${e.down}`); assert.ok(e.yl >= 1 && e.yl <= 99, `yl ${e.yl}`); assert.ok(e.togo >= 1 && e.togo <= e.yl, `togo ${e.togo} at ${e.yl}`);
      if (e.yl <= 10 && e.down === 1) assert.ok(e.togo === e.yl || e.togo <= 10);
      if (prev && prev.k === e.k && !prev.td && !prev.to) {
        const yl = prev.yl - prev.yds; assert.equal(e.yl, yl, 'ball spotted where the last play ended');
        if (prev.yds >= prev.togo) { assert.equal(e.down, 1); assert.equal(e.togo, Math.min(10, yl)); }
        else { assert.equal(e.down, prev.down + 1); assert.equal(e.togo, prev.togo - prev.yds); }
        checked++;
      }
      prev = e.td || e.to || e.safety ? null : e;
    }
  }
  assert.ok(checked > 3000, `checked ${checked}`);
});

test('scoring: points in the play log add up to the final score, and the log matches the run', () => {
  for (let g = 0; g < 80; g++) {
    const L = replayGame(E, 5, g); const sc = [0, 0];
    for (const e of L) {
      if (e.t === 'play' && e.td) sc[e.k] += PTS.td;
      else if (e.t === 'play' && e.safety) sc[1 - e.k] += 2;
      else if (e.t === 'fg' && e.good) sc[e.k] += 3;
      else if (e.t === 'pat' && e.ok) sc[e.k] += e.two ? 2 : 1;
      else if (e.t === 'punt' && e.td) sc[1 - e.k] += 6;
      else if (e.t === 'ko' && e.td) sc[e.ret] += 6;
      else if (e.t === 'note' && /returns it for a touchdown/.test(e.txt)) { /* defensive TD: counted from the score delta below */ }
    }
    const fin = L.at(-1).sc; const dts = fin[0] + fin[1] - sc[0] - sc[1];
    assert.ok(dts === 0 || dts % 6 === 0, `game ${g}: unexplained ${dts} points`);
    assert.deepEqual([fin[0], fin[1]], [S.score[2 * g], S.score[2 * g + 1]], `game ${g} replays to the same final score`);
  }
});

test('field position: kickoffs, punts and drive starts land on the field; average start near real NFL', () => {
  let n = 0, st = 0;
  for (let g = 0; g < 200; g++) for (const e of replayGame(E, 5, g)) {
    if (e.t === 'drive') { assert.ok(e.yl >= 1 && e.yl <= 99); n++; st += e.yl; }
    if (e.t === 'punt' && !e.td) assert.ok(e.ny >= 1 && e.ny <= 99);
    if (e.t === 'ko' && e.yl != null) assert.ok(e.yl >= 1 && e.yl <= 99);
  }
  const avg = st / n; assert.ok(avg > 62 && avg < 76, `average start ${avg.toFixed(1)} yards from goal`);
  const sum = summarizePbp(S, I); for (const t of sum.pbp.team) { assert.ok(t.rzTrips > 2 && t.rzTrips < 5.5, `rz ${t.rzTrips}`); assert.ok(t.rzTdPct > 0.4 && t.rzTdPct < 0.75); }
  assert.ok(sum.pbp.rzPatterns.length >= 4 && sum.pbp.rzPatterns.every(p => typeof p.text === 'string'));
  assert.equal(sum.vs.top4.length, 4);
});

test('determinism by seed, chunked runs equal one-shot runs', () => {
  const a = simulatePbp(I, { n: 400, seed: 99, E }), b = simulatePbp(I, { n: 400, seed: 99, E }), c = simulatePbp(I, { n: 400, seed: 100, E });
  assert.deepEqual(Array.from(a.score), Array.from(b.score)); assert.notDeepEqual(Array.from(a.score), Array.from(c.score));
  const R = pbpRunner(I, { n: 400, seed: 99, E }); let parts = 0; while (!R.run(150)) { parts++; const p = pbpPartial(R.W, I); assert.equal(p.done, R.W.done); assert.equal(p.top4.length, 4); }
  assert.ok(parts >= 2); assert.deepEqual(Array.from(finish(R.W, R.E).score), Array.from(a.score));
  const r1 = runPbp(I, { n: 200, seed: 3 }), r2 = runPbp(I, { n: 200, seed: 3 }); assert.deepEqual(Array.from(r1.score), Array.from(r2.score));
});

test('calibration to history: a league-average matchup scores like the real NFL', () => {
  const L = structuredClone(I); const M = PP.M;
  for (const s of L.pbp.side) { s.pass = M.pass.icept; s.passRz = 0; for (const k of ['sack', 'scr', 'int', 'cmp', 'expP', 'expR', 'rzTd']) s[k] = M[k].icept; s.pace = 1; s.ydsR = 0; s.ydsC = 0; }
  const { E: EL } = calibratePbp(L, { seed: 4 }); const X = simulatePbp(L, { n: 3000, seed: 8, E: EL });
  let pts = 0, td = 0, ru = 0, pa = 0; for (let g = 0; g < X.n; g++) { pts += X.score[2 * g] + X.score[2 * g + 1]; td += X.tds[2 * g] + X.tds[2 * g + 1]; }
  for (const k of [0, 1]) { ru += X.tdSrc[k * 4]; pa += X.tdSrc[k * 4 + 1]; }
  const ppg = pts / (2 * X.n), tpg = td / (2 * X.n), rush = ru / (ru + pa);
  assert.ok(ppg > 21.5 && ppg < 25, `points per team ${ppg.toFixed(2)} (2025 real ≈ 22.9)`);
  assert.ok(tpg > 2.15 && tpg < 2.7, `offensive TDs per team ${tpg.toFixed(2)} (2025 real ≈ 2.4)`);
  assert.ok(rush > 0.33 && rush < 0.44, `rushing share of TDs ${rush.toFixed(3)} (2025 real .386)`);
});

test('no leakage: week-8 params use only weeks before 8; archive params agree', () => {
  assert.equal(PP.week, 8); assert.ok(PP.through < PP.week, `through ${PP.through}`);
  for (const f of fs.existsSync(new URL('../archive/pbp/2026/', import.meta.url)) ? fs.readdirSync(new URL('../archive/pbp/2026/', import.meta.url)) : []) {
    const P = JSON.parse(fs.readFileSync(new URL(`../archive/pbp/2026/${f}`, import.meta.url))); assert.ok(P.through < P.week, `${f}: through ${P.through} week ${P.week}`); }
  const V = JSON.parse(fs.readFileSync(new URL('../archive/sim/pbp-validation-2026.json', import.meta.url)));
  assert.ok(V.leakage?.ok !== false);
});

test('UI: the Run button renders in both sim modes (it lives outside the mode-specific header)', () => {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function paintSim()'), src.indexOf('function renderDrives()'));
  const ctl = fn.match(/const ctl = `[^\n]*/)?.[0] || '';
  assert.ok(ctl.includes('data-act="simrun"'), 'run button is in the shared controls');
  assert.ok(!/const head = [^\n]*data-act="simrun"/.test(fn), 'not tied to one mode');
  assert.ok(fn.includes('${head}${ctl}'), 'controls render after either header');
});
