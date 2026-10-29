// endzone app 4.9.0: game simulator (Drives → Simulator). Research / UI only — must stay calibrated to the model it re-plays.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSim, summarize, playerDriveTable, pAtLeast, simPatterns, makeRng, SLOTS } from '../src/sim.js';
import { snapInputs } from '../scripts/sim/snap.mjs';
import { MODEL_VERSION } from '../src/model.js';

const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w8.json', import.meta.url)));
const { I } = snapInputs(new URL('../archive/2026/w8/2026_08_CAR_GB.json', import.meta.url).pathname, D);
const S = runSim(I, { n: 6000, seed: 7 }); const sum = summarize(S, I);

test('sim is deterministic by seed and changes with the seed', () => {
  const a = summarize(runSim(I, { n: 800, seed: 3 }), I), b = summarize(runSim(I, { n: 800, seed: 3 }), I), c = summarize(runSim(I, { n: 800, seed: 4 }), I);
  assert.deepEqual(a.win, b.win); assert.deepEqual(a.top, b.top); assert.notDeepEqual(a.top, c.top);
  const r = makeRng(9), r2 = makeRng(9); for (let i = 0; i < 5; i++) assert.equal(r(), r2());
});

test('team TDs track the model TD budget (λ) and drives track history', () => {
  for (const k of [0, 1]) {
    const lam = I.teams[k].teamLambda, td = sum.team[k].mean.td;
    assert.ok(Math.abs(td / lam - 1) < 0.05, `${I.teams[k].team} TDs ${td.toFixed(2)} vs λ ${lam.toFixed(2)}`);
    assert.ok(Math.abs(sum.team[k].mean.drives - I.targetDrives) < 0.5, `drives ${sum.team[k].mean.drives}`);
    assert.ok(sum.team[k].mean.pts > 15 && sum.team[k].mean.pts < 32, `pts ${sum.team[k].mean.pts}`);
  }
  assert.ok(Math.abs(sum.win.away + sum.win.home + sum.win.tie - 1) < 1e-9);
});

test('per-player anytime TD and volume match the model inputs', () => {
  const big = sum.players.filter(p => p.model.chance >= 0.10); assert.ok(big.length >= 8);
  for (const p of big) assert.ok(Math.abs(p.anytime - p.model.chance) < 0.035, `${p.name} ${p.anytime} vs ${p.model.chance}`);
  for (const p of sum.players.filter(p => p.model.rec >= 2)) assert.ok(Math.abs(p.rec.mean / p.model.rec - 1) < 0.08, `${p.name} rec ${p.rec.mean} vs ${p.model.rec}`);
  for (const p of sum.players.filter(p => p.model.rushYd >= 30)) assert.ok(Math.abs(p.rushYd.mean / p.model.rushYd - 1) < 0.08, `${p.name} rush ${p.rushYd.mean} vs ${p.model.rushYd}`);
  for (const p of sum.players) assert.ok(p.twoPlus <= p.anytime);
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
