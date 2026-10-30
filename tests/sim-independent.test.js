// endzone app 4.13.1: "Make the sim fully independent from the model again." The default sim inputs (both the drive sim and the
// play-by-play sim run on them) must not depend on ANY model number: no TD budget, no team or player lambdas, chances, volumes or scenarios.
// Proof: build the inputs twice with wildly different model rows; everything the engines read must be identical, and so must the sims.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSimInputs, runSim, summarize, dataPlayers } from '../src/sim.js';
import { buildPbpInputs, runPbp } from '../src/sim-pbp.js';
import { MODEL_VERSION } from '../src/model.js';

const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w8.json', import.meta.url)));
const { I: F } = JSON.parse(fs.readFileSync(new URL('./fixtures/sim-inputs-2026w8-CAR-GB-492.json', import.meta.url)));
const PP = JSON.parse(fs.readFileSync(new URL('./fixtures/pbp-params-2026w8-v2.json', import.meta.url)));
const TDS = JSON.parse(fs.readFileSync(new URL('./fixtures/td-share-2026w8.json', import.meta.url)));
const rows = (k, f) => F.teams[k].players.map(p => ({ id: p.id, gsis: p.gsis, name: p.name, pos: p.pos, lambda: p.lam * f, chance: 1 - Math.exp(-p.lam * f), vol: { targets: p.tgt * f, carries: p.car * f }, volume: {}, passTd: { attemptShare: f > 1 ? 1 : 0 } }));
const side = f => t => { const k = t === 'CAR' ? 0 : 1; return { players: rows(k, f), opp: k ? 'CAR' : 'GB', teamLambda: 2.5 * f, tdBudget: 2.4 * f }; };
const strip = I => JSON.parse(JSON.stringify(I.teams.map(t => ({ ...t, modelTeamLambda: null, players: t.players.map(p => ({ ...p, modelChance: null })) }))));

test('default sim inputs carry no model numbers (data players, no TD budget, anchor off)', () => {
  assert.equal(MODEL_VERSION, 'endzone-4.6.0');
  const a = buildSimInputs(D, { away: 'CAR', home: 'GB', sideFor: side(1), gameId: 'x', tdShare: TDS }), b = buildSimInputs(D, { away: 'CAR', home: 'GB', sideFor: side(7), gameId: 'x', tdShare: TDS });
  assert.equal(a.source, 'data'); assert.equal(a.mode, 'free');
  for (const t of a.teams) { assert.equal(t.tdBudget, null); assert.equal(t.pfModel, null); assert.ok(t.players.length >= 6, `${t.team} players ${t.players.length}`); assert.ok(t.players.every(p => p.history)); }
  assert.deepEqual(strip(a), strip(b)); // 7x the model's numbers change nothing the engines read
  assert.ok(a.teams[0].players.some(p => p.modelChance != null)); // the model's chance is still joined for the side-by-side display
  const qb = a.teams.map(t => t.players.filter(p => p.passShare > 0)); assert.ok(qb.some(q => q.length) && qb.every(q => !q.length || Math.abs(q.reduce((s, p) => s + p.passShare, 0) - 1) < 0.01)); // QB from his recent appearances (a QB with no carries in the drive file is not listed)
  const s1 = summarize(runSim(a, { n: 600, seed: 5 }), a), s2 = summarize(runSim(b, { n: 600, seed: 5 }), b);
  assert.deepEqual(s1.players.map(p => p.anytime), s2.players.map(p => p.anytime));
  const p1 = runPbp(buildPbpInputs(a, PP), { n: 300, seed: 5 }), p2 = runPbp(buildPbpInputs(b, PP), { n: 300, seed: 5 });
  assert.deepEqual(Array.from(p1.G.td), Array.from(p2.G.td));
});

test('data players: injury report / roster drops players, research "model" source still available', () => {
  const pl = dataPlayers(D, 'GB'); const top = pl.slice().sort((x, y) => (y.tgt + y.car) - (x.tgt + x.car))[0];
  const out = dataPlayers(D, 'GB', { [top.gsis]: [null, 'Out', 'DNP', null] }); assert.ok(!out.some(p => p.gsis === top.gsis));
  const moved = dataPlayers(D, 'GB', { [top.gsis]: ['CAR', null, '', null] }); assert.ok(!moved.some(p => p.gsis === top.gsis));
  const m = buildSimInputs(D, { away: 'CAR', home: 'GB', sideFor: side(1), gameId: 'x', source: 'model' }); assert.equal(m.source, 'model'); assert.equal(m.teams[0].tdBudget, 2.4);
});
