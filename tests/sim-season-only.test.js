// endzone app 4.18.0: "Only look at 2026 season data so far to predict future touchdowns." The default sims (drive and play-by-play)
// read this season's games before the target week only: no last-season usage / star tags, no prior-season team strength, no prior-season
// lines, td-share / red-zone shares, pbp params, game-context fit or drive patterns. Proof: inject 2025 data everywhere; the inputs the
// engines read must not change, and assertSeasonOnly must pass (and throw on prior-season pbp params).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSimInputs, assertSeasonOnly, assertMarketFree, seasonOnlyD, DATA_OPTS, runSim, summarize } from '../src/sim.js';
import { buildPbpInputs } from '../src/sim-pbp.js';
import { MODEL_VERSION } from '../src/model.js';

const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w8.json', import.meta.url)));
const OLD_PP = JSON.parse(fs.readFileSync(new URL('./fixtures/pbp-params-2026w8-v2.json', import.meta.url))); // 4.17: fit with 2025 plays
const OLD_TD = JSON.parse(fs.readFileSync(new URL('./fixtures/td-share-2026w8.json', import.meta.url)));
const PP = JSON.parse(fs.readFileSync(new URL('../archive/pbp/2026/w9.json', import.meta.url)));
// the same drive file with a fake 2025 game added to every team (a 3-TD game for everyone in it)
const D25 = { ...D, teams: Object.fromEntries(Object.entries(D.teams).map(([t, T]) => { const g = T.games[0]; if (!g) return [t, T];
  const fake = { ...g, season: 2025, w: 17, d: g.d.map(d => [...d.slice(0, 5), 'TD', ...d.slice(6, 8), d[8].map(x => { const y = [...x]; y[7] = 3; y[1] += 5; return y; }), ...d.slice(9)]) };
  return [t, { ...T, games: [fake, ...T.games] }]; })) };
const fakeUP = { season: 2026, players: new Proxy({}, { get: () => ({ g: 17, tgt: 9, car: 20, td: 1.5, rz: 5 }) }) };
const fakeTS = { season: 2025, teams: new Proxy({}, { get: () => ({ off: 1, def: 1 }) }) };
const pick = I => JSON.parse(JSON.stringify(I.teams.map(t => t.players.map(p => ({ ...p, modelChance: null })))));
const args = { away: 'CAR', home: 'GB', gameId: 't' };

test('season-only is the default; prior-season drives / usage / team strength / ctx / td-share do not reach the sim inputs', () => {
  assert.equal(MODEL_VERSION, 'endzone-4.6.0'); assert.equal(DATA_OPTS.seasonOnly, true); assert.equal(DATA_OPTS.priorK, 0); assert.equal(DATA_OPTS.ts.priorF, 0);
  const A = buildSimInputs(D, { ...args });
  const B = buildSimInputs(D25, { ...args, usagePrior: fakeUP, tsPrior: fakeTS, tdShare: OLD_TD, ctx: { neutral: false, fit: { fitted: true, coef: [0.5, 0.5, 0.5], base: 30, seasons: [2023, 2024, 2025] } } });
  assert.deepEqual(pick(B), pick(A)); assert.deepEqual(B.ts, A.ts);
  for (const I of [A, B]) { assertSeasonOnly(I); assertMarketFree(I); assert.equal(I.seasonOnly.season, 2026); assert.equal(I.seasonOnly.usagePrior, false); assert.equal(I.seasonOnly.tdShare, null); assert.equal(I.seasonOnly.ctx, null); }
  for (const t of B.teams) for (const p of t.players) assert.deepEqual(p.pats, []);
  assert.equal(seasonOnlyD(D), D); for (const T of Object.values(seasonOnlyD(D25).teams)) for (const g of T.games) assert.notEqual(g.season, 2025);
  const s1 = summarize(runSim(A, { n: 300, seed: 5, mode: 'free' }), A), s2 = summarize(runSim(B, { n: 300, seed: 5, mode: 'free' }), B);
  assert.deepEqual(s2.players.map(p => p.anytime), s1.players.map(p => p.anytime));
});

test('play-by-play sim: shipped params are this season only; prior-season params are rejected', () => {
  assert.deepEqual(PP.prior, []); assert.equal(PP.season, 2026); assert.equal(PP.td.opts.seasonOnly, true); assert.deepEqual(PP.td.seasons, [2026]);
  const I = buildSimInputs(D, { ...args, tdShare: PP.td }); assert.deepEqual(I.seasonOnly.tdShare, [2026]); assertSeasonOnly(I);
  assertSeasonOnly(buildPbpInputs(I, PP));
  assert.throws(() => assertSeasonOnly(buildPbpInputs(I, OLD_PP)), /pre-season data/);
});
