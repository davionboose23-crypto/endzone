// endzone app 4.12.0: td-share-1 — who scores a team's touchdowns in the simulators (src/td-share.js). Sim-only: the board,
// MODEL_VERSION and the challenger gate do not move. Inputs are FROZEN fixtures (week-8 td block + the 4.9.2 CAR @ GB sim inputs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tdShareFor, blendShares, fitBlend, TD_BLEND, TD_SHARE_VERSION } from '../src/td-share.js';
import { buildPbpInputs, calibratePbp, simulatePbp, summarizePbp } from '../src/sim-pbp.js';
import { MODEL_VERSION } from '../src/model.js';

const TD = JSON.parse(fs.readFileSync(new URL('./fixtures/td-share-2026w8.json', import.meta.url)));
const { I: I0 } = JSON.parse(fs.readFileSync(new URL('./fixtures/sim-inputs-2026w8-CAR-GB-492.json', import.meta.url)));
const PP = JSON.parse(fs.readFileSync(new URL('./fixtures/pbp-params-2026w8-v2.json', import.meta.url)));
const team = t => I0.teams.find(x => x.team === t);

test('td-share block is walk-forward (week 8 sees weeks 1-7 only) and the model is untouched', () => {
  assert.equal(TD.version, TD_SHARE_VERSION); assert.equal(TD.before, 8); assert.ok(TD.through < 8 && TD.through >= 7);
  assert.equal(MODEL_VERSION, 'endzone-4.6.0');
  assert.ok(Object.keys(TD.players).length > 300);
});

test('shares sum to 1 per team, injured players get none, Jacobs leads GB', () => {
  const pl = team('GB').players; const s = tdShareFor(TD, pl.map(p => ({ ...p, avail: 1 })), 'CAR');
  assert.ok(Math.abs(s.reduce((a, x) => a + x.share, 0) - 1) < 1e-9);
  const top = pl[s.indexOf(s.reduce((a, b) => b.share > a.share ? b : a))]; assert.equal(top.name, 'Josh Jacobs');
  const j = pl.findIndex(p => p.name === 'Josh Jacobs'); const s2 = tdShareFor(TD, pl.map((p, i) => ({ ...p, avail: i === j ? 0 : 1 })), 'CAR');
  assert.equal(s2[j].share, 0); assert.ok(Math.abs(s2.reduce((a, x) => a + x.share, 0) - 1) < 1e-9);
});

test('blend keeps the team total, alpha 0 = the model split, the TE offset raises TEs', () => {
  for (const t of ['CAR', 'GB']) { const pl = team(t).players; const lt = pl.reduce((a, p) => a + p.lam, 0);
    const b0 = blendShares(pl, TD, 'x', { alpha: 0, beta: {} }); pl.forEach((p, i) => assert.ok(Math.abs(b0[i].share - p.lam / lt) < 1e-9));
    const b = blendShares(pl, TD, 'x', TD_BLEND); assert.ok(Math.abs(b.reduce((a, x) => a + x.share, 0) - 1) < 1e-9);
    const te = B => blendShares(pl, TD, 'x', B).reduce((a, x, i) => a + (pl[i].pos === 'TE' ? x.share : 0), 0);
    assert.ok(te({ alpha: TD_BLEND.alpha, beta: { TE: 0.3 } }) > te({ alpha: TD_BLEND.alpha, beta: { TE: 0 } })); }
});

test('fitBlend: no fit below 150 TDs, recovers a TE bias when TEs score more than the model says', () => {
  assert.equal(fitBlend([{ tds: 10, c: [['RB', 0.5, 0.5, 5], ['TE', 0.5, 0.5, 5]] }]).fitted, false);
  const teams = []; for (let k = 0; k < 100; k++) teams.push({ tds: 2, c: [['RB', 0.4, 0.4, k % 5 < 2 ? 1 : 0], ['WR', 0.4, 0.4, k % 5 < 2 ? 1 : 0], ['TE', 0.2, 0.2, k % 5 >= 2 ? 1 : 0]] }); // TE scores ~1/3 > 0.2
  const B = fitBlend(teams); assert.ok(B.fitted && B.beta.TE > 0);
});

test('play-by-play TD pilots move simulated TD shares toward the blended split', () => {
  const I1 = JSON.parse(JSON.stringify(I0)); // tilt GB to its TE so the target differs clearly from the usage split
  for (const t of I1.teams) { const lt = t.players.reduce((a, p) => a + p.lam, 0); const b = blendShares(t.players, TD, t.opp, { alpha: 0.3, beta: { TE: 0.6 } });
    t.players.forEach((p, i) => { p.lam = lt * b[i].share; }); t.tdShare = { version: TD_SHARE_VERSION, alpha: 0.3 }; }
  const I = buildPbpInputs(I1, PP); const want = I.teams.map(t => { const lt = t.players.reduce((a, p) => a + p.lam, 0); return Object.fromEntries(t.players.map(p => [p.id, p.lam / lt])); });
  const err = (tdPilots, seed) => { const { E } = calibratePbp(I, { seed: 21, tdPilots }); const s = summarizePbp(simulatePbp(I, { n: 2500, seed, E }), I);
    let e = 0; I.teams.forEach((t, k) => { const tot = s.players.filter(p => p.team === t.team).reduce((a, p) => a + p.td, 0); for (const p of s.players.filter(p => p.team === t.team)) e += Math.abs(p.td / tot - (want[k][p.id] || 0)); }); return e; };
  assert.ok(err(2, 5) < err(0, 5), 'TD pilots should reduce the share error');
});

// app 4.12.0: history-fallback players are checked against the current Sleeper roster / injury list
import { rosterCheck } from '../src/sim.js';
test('rosterCheck drops departed and out / IR players, scales questionable ones, leaves unknowns alone', () => {
  const p = { gsis: 'G1', id: '1', lam: 0.3, chance: 0.26, tgt: 6, car: 0, rec: 4, recYd: 50, rushYd: 0 };
  const R = { G1: ['GB', null, null, 'Active'] };
  assert.equal(rosterCheck(p, 'GB', R), p);
  assert.equal(rosterCheck(p, 'GB', { G1: ['HOU', null, null, 'Active'] }), null);
  assert.equal(rosterCheck(p, 'GB', { G1: ['GB', 'IR', null, 'Inactive'] }), null);
  assert.equal(rosterCheck(p, 'GB', { G1: ['GB', 'Out', null, 'Active'] }), null);
  const q = rosterCheck(p, 'GB', { 1: ['GB', 'Questionable', null, 'Active'] }); assert.ok(q.lam < p.lam && q.lam > 0 && q.tgt < p.tgt);
  assert.equal(rosterCheck(p, 'GB', {}), p); assert.equal(rosterCheck(p, 'GB', null), p);
});
