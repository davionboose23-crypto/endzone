// endzone app 4.9.0-4.9.2: game simulator (Drives → Simulator), Drive 1 card, TD scorer patterns, team-style free sim. Research / UI only.
// 4.9.2: the default ('free') sim runs on each team's opponent-adjusted 2026 drives and may disagree with the model; 'anchored' keeps the 4.9.1 pinning to the model λ.
// Inputs are a FROZEN fixture (tests/fixtures/sim-inputs-2026w8-CAR-GB-492.json; 4.9.1 used sim-inputs-2026w8-CAR-GB.json). Until 4.9.1 this file rebuilt them from
// archive/2026/w8/*.json + archive/drives/2026/w8.json, which the scheduled data refresh rewrites, so the calibration
// tolerances below silently depended on whatever the latest refresh wrote (pass on one checkout, fail after a refresh).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSim, summarize, simVsModel, playerDriveTable, pAtLeast, simPatterns, makeRng, SLOTS, RESULTS, driveCard, tdPatterns, pct, poss, driveName } from '../src/sim.js';
import { snapInputs } from '../scripts/sim/snap.mjs';
import { MODEL_VERSION } from '../src/model.js';

const { I } = JSON.parse(fs.readFileSync(new URL('./fixtures/sim-inputs-2026w8-CAR-GB-492.json', import.meta.url)));
const S = runSim(I, { n: 6000, seed: 7 }); const sum = summarize(S, I);
const SA = runSim(I, { n: 6000, seed: 7, mode: 'anchored' }); const sumA = summarize(SA, { ...I, mode: 'anchored' });

test('sim is deterministic by seed and changes with the seed', () => {
  const a = summarize(runSim(I, { n: 800, seed: 3 }), I), b = summarize(runSim(I, { n: 800, seed: 3 }), I), c = summarize(runSim(I, { n: 800, seed: 4 }), I);
  assert.deepEqual(a.win, b.win); assert.deepEqual(a.top, b.top);
  assert.notDeepEqual([a.win, a.team[0].mean, a.team[1].mean], [c.win, c.team[0].mean, c.team[1].mean]); // whole-run fingerprint, not just the 5 most common scores
  const r = makeRng(9), r2 = makeRng(9); for (let i = 0; i < 5; i++) assert.equal(r(), r2());
});

test('free sim: team scoring stays inside 2025-26 history but is not pinned to the model λ', () => {
  assert.equal(I.mode, 'free'); assert.equal(sum.mode, 'free');
  for (const k of [0, 1]) {
    const T = sum.team[k].mean;
    assert.ok(Math.abs(T.drives - I.targetDrives) < 0.6, `drives ${T.drives} vs ${I.targetDrives}`);
    assert.ok(T.pts > 15 && T.pts < 32, `pts ${T.pts}`); assert.ok(T.td > 1.4 && T.td < 3.6, `td ${T.td}`);
  }
  const tot = sum.team[0].mean.pts + sum.team[1].mean.pts; assert.ok(tot > 34 && tot < 60, `total ${tot}`);
  assert.ok(Math.abs(sum.win.away + sum.win.home + sum.win.tie - 1) < 1e-9);
  // 4.13.1: the default is free-running again (no pull to the model's TD budget): identical to disp: false, and the TD count is the sim's own.
  const S0 = summarize(runSim({ ...I, disp: false }, { n: 6000, seed: 7 }), I);
  assert.deepEqual([S0.team[0].mean.td, S0.team[1].mean.td], [sum.team[0].mean.td, sum.team[1].mean.td]);
  assert.ok(Math.abs(S0.team[0].mean.td - I.teams[0].teamLambda) > 0.1 || Math.abs(S0.team[1].mean.td - I.teams[1].teamLambda) > 0.1);
});

test('anchored sim (4.9.1 behaviour) still tracks the model TD budget and player chances', () => {
  for (const k of [0, 1]) { const lam = I.teams[k].teamLambda, td = sumA.team[k].mean.td; assert.ok(Math.abs(td / lam - 1) < 0.05, `${I.teams[k].team} TDs ${td.toFixed(2)} vs λ ${lam.toFixed(2)}`); }
  const big = sumA.players.filter(p => p.model.chance >= 0.10); assert.ok(big.length >= 8);
  for (const p of big) assert.ok(Math.abs(p.anytime - p.model.chance) < 0.035, `${p.name} ${p.anytime} vs ${p.model.chance}`);
  for (const p of sumA.players.filter(p => p.model.rec >= 2)) assert.ok(Math.abs(p.rec.mean / p.model.rec - 1) < 0.08, `${p.name} rec ${p.rec.mean} vs ${p.model.rec}`);
});

test('free sim: who scores follows the model shares (injuries / roles), the team total follows the drives', () => {
  for (const k of [0, 1]) {
    const pl = sum.players.filter(p => p.k === k && !p.history); const lamT = pl.reduce((a, p) => a + p.model.lam, 0); const tdT = pl.reduce((a, p) => a + p.td, 0);
    for (const p of pl.filter(x => x.model.chance >= 0.15)) assert.ok(Math.abs(p.td / tdT - p.model.lam / lamT) < 0.03, `${p.name} share ${(p.td / tdT).toFixed(3)} vs ${(p.model.lam / lamT).toFixed(3)}`);
  }
  for (const p of sum.players) assert.ok(p.twoPlus <= p.anytime);
});

test('4.9.2 Top 4 TD scorers, team profiles and sim vs model', () => {
  const v = sum.vs; assert.equal(v.top4.length, 4);
  for (let i = 1; i < 4; i++) assert.ok(v.top4[i].anytime <= v.top4[i - 1].anytime);
  const best = Math.max(...sum.players.map(p => p.anytime)); assert.equal(v.top4[0].anytime, best);
  for (const p of v.top4) { assert.ok(p.twoPlus <= p.anytime && p.first <= p.anytime && Math.abs(p.diff - (p.anytime - p.model)) < 1e-9); assert.ok(p.line.includes(p.name) && p.line.length > 60); }
  assert.ok(new Set(v.top4.map(p => p.team)).size >= 1 && v.top4.every(p => [I.away, I.home].includes(p.team) || I.teams.some(t => t.team === p.team)));
  for (const t of v.teams) { assert.ok(t.off.lines.length >= 4 && t.def.lines.length >= 3); assert.ok(Math.abs(t.diffTd - (t.simTd - t.modelTd)) < 1e-9); }
  for (let i = 1; i < v.gaps.length; i++) assert.ok(Math.abs(v.gaps[i].diff) <= Math.abs(v.gaps[i - 1].diff));
  assert.deepEqual(simVsModel(sum, I).vs.top4.map(p => p.j), v.top4.map(p => p.j));
});

test('per-drive tables, thresholds and patterns are coherent', () => {
  const p = sum.players.find(x => x.model.rec >= 3); const rows = playerDriveTable(S, p.j, 'rec', 1, 14);
  assert.ok(rows.length >= 9 && rows.length <= SLOTS); assert.equal(rows[0].happen, 1);
  for (const r of rows) { assert.ok(r.pHit <= r.happen + 1e-9); assert.ok(r.pHitGiven >= 0 && r.pHitGiven <= 1); }
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].happen <= rows[i - 1].happen + 1e-9);
  assert.equal(pAtLeast(new Int16Array([0, 1, 2, 3]), 2), 0.5);
  const pats = simPatterns(S, sum, { max: 8 }); assert.ok(pats.length > 0 && pats.every(t => t.p > 0 && t.p <= 1 && t.drive >= 1 && t.name));
  assert.ok(sum.firstTd.length > 0 && sum.firstTd[0].p > 0.05);
});

test('the simulator is display-only: no model version change', () => {
  assert.equal(MODEL_VERSION, 'endzone-4.6.0');
});

test('live archive snapshots still build simulator inputs (smoke only; tolerances use the frozen fixture)', () => {
  const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w8.json', import.meta.url)));
  const r = snapInputs(new URL('../archive/2026/w8/2026_08_CAR_GB.json', import.meta.url).pathname, D);
  assert.ok(r && r.I.teams.length === 2 && r.I.teams.every(t => t.players.length > 0));
});

test('4.9.1 drive card: results add up, drive 1 always happens, player TD shares fit inside the TD rate', () => {
  assert.equal(sum.drive1.length, 2);
  for (const c of sum.drive1) {
    assert.equal(c.happen, 1); assert.equal(c.dname, 'opening drive');
    const tot = RESULTS.reduce((a, r) => a + (c.res[r] || 0), 0); assert.ok(Math.abs(tot - 1) < 1e-6, `results sum ${tot}`);
    assert.ok(c.plays > 2 && c.plays < 12 && c.yds > 5 && c.yds < 60, `plays ${c.plays} yds ${c.yds}`);
    assert.ok(c.scoresFirst > 0.2 && c.scoresFirst < 0.8);
    const tdNamed = c.players.reduce((a, p) => a + p.pTd, 0); assert.ok(tdNamed <= c.res.TD + 1e-9);
    for (const p of c.players) {
      assert.ok(p.pRec2 <= p.pRec1 + 1e-9 && p.pRec1 <= p.pTgt + 1e-9 && p.pCar2 <= p.pCar1 + 1e-9 && p.pRush10 <= p.pCar1 + 1e-9 && p.pRecYd10 <= p.pRec1 + 1e-9);
    }
    assert.ok(c.scorers.length > 0 && c.headline.length >= 2 && c.headline.every(h => typeof h === 'string' && h.length > 20));
    assert.ok(Math.abs(c.recvKick - 0.5) < 0.03, 'opening kickoff is a coin flip');
  }
  const later = driveCard(S, sum, 0, 3); assert.ok(later.happen > 0.5 && later.happen <= 1 && later.res && /fourth drive/.test(later.dname));
});

test('4.9.1 TD scorer patterns: first-TD shares, anytime ladder, rush/rec split, ranked key list', () => {
  const t = tdPatterns(S, sum); const ft = t.firstTeam;
  assert.equal(ft.length, 2);
  for (const p of t.players) {
    assert.ok(p.threePlus <= p.twoPlus + 1e-9 && p.twoPlus <= p.anytime + 1e-9 && p.first <= p.anytime + 1e-9 && p.first <= p.firstTeam + 1e-9);
    assert.ok(Math.abs(p.rush + p.recv - 1) < 1e-6, `${p.name} rush+rec ${p.rush + p.recv}`);
    assert.ok(p.half1 >= 0 && p.half1 <= 1 && p.d13 >= 0 && p.d13 <= 1);
  }
  const firstSum = t.players.reduce((a, p) => a + p.first, 0); assert.ok(firstSum < 1 + 1e-9);
  assert.ok(t.key.length >= 3 && t.key.every(s => typeof s === 'string' && s.length > 20));
  assert.equal(pct(0.004), '<1%'); assert.equal(pct(0.996), '>99%'); assert.equal(pct(0.5), '50%');
  assert.equal(poss('Josh Jacobs'), "Josh Jacobs'"); assert.equal(poss('Chuba Hubbard'), "Chuba Hubbard's"); assert.equal(driveName(1), 'second drive');
});
