// endzone app 4.9.2: opponent-adjusted team strength behind the simulator (src/team-strength.js). Research / UI only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { teamStrength, matchup, profileLines, MIX } from '../src/team-strength.js';
import { buildSimInputs } from '../src/sim.js';

// synthetic league: X only ever faces the strong defense S, Y only the weak defense W, and both score a TD on 25% of
// drives. M1 / M2 face both S and W, which reveals S as strong (10%) and W as weak (40%).
function drive(n, res, plays = 6) { return [n, n <= 6 ? 1 : 2, 0, res === 'TD' && plays <= 4 ? 4 : 0, plays, res, 3, 3, [], n <= 6 ? 1 : 3, 70]; }
function game(w, opp, tdRate, nd = 20) { const td = Math.round(tdRate * nd); return { w, opp, game: `g${w}${opp}`, d: Array.from({ length: nd }, (_, i) => drive(i + 1, i < td ? 'TD' : i % 2 ? 'Punt' : 'FG')) }; }
function league(weeks = 6, extra = null) {
  const T = { X: [], Y: [], M1: [], M2: [], S: [], W: [] };
  for (let w = 1; w <= weeks; w++) {
    T.X.push(game(w, 'S', 0.25)); T.Y.push(game(w, 'W', 0.25));
    T.M1.push(game(w, w % 2 ? 'S' : 'W', w % 2 ? 0.1 : 0.4)); T.M2.push(game(w, w % 2 ? 'W' : 'S', w % 2 ? 0.4 : 0.1));
    T.S.push(game(w, w % 2 ? 'M2' : 'M1', 0.2)); T.W.push(game(w, w % 2 ? 'M1' : 'M2', 0.2));
  }
  if (extra) extra(T);
  return { teams: Object.fromEntries(Object.entries(T).map(([k, g]) => [k, { people: {}, games: g }])) };
}
const tdOf = (TS, a, b) => matchup(TS, a, b).mix.reduce((s, m) => s + m[0], 0) / 4;

test('opponent adjustment: an offense that faced a strong defense rates above one with the same raw rate vs a weak defense', () => {
  const TS = teamStrength(league(), { halfLife: null });
  const x = TS.profiles.X.off.td, y = TS.profiles.Y.off.td;
  assert.ok(x > y + 0.03, `X ${x.toFixed(3)} vs Y ${y.toFixed(3)}`);
  assert.ok(Math.abs(TS.profiles.X.raw.off.td - TS.profiles.Y.raw.off.td) < 1e-9, 'same raw TD rate');
  assert.ok(TS.profiles.S.def.td < TS.profiles.W.def.td - 0.05, 'S defense rated stronger than W');
  // and the matchup combines both sides: X vs the weak defense scores more than X vs the strong one
  assert.ok(tdOf(TS, 'X', 'W') > tdOf(TS, 'X', 'S') + 0.05);
  assert.ok(TS.mix && MIX.length === 5);
});

test('no leakage: the fit for week W ignores week W and later', () => {
  const base = league(6); const plus = league(6, T => { T.X.push(game(6.5, 'S', 0.9)); T.X.push(game(7, 'S', 0.9)); T.Y.push(game(8, 'W', 0)); });
  const a = teamStrength(base, { before: 6 }), b = teamStrength(plus, { before: 6 });
  assert.equal(a.nDrives, b.nDrives); assert.equal(a.maxW, 5);
  assert.deepEqual(matchup(a, 'X', 'S'), matchup(b, 'X', 'S')); assert.deepEqual(matchup(a, 'Y', 'W'), matchup(b, 'Y', 'W'));
  // while the unrestricted fit does move
  assert.notDeepEqual(matchup(teamStrength(plus), 'X', 'S').mix, matchup(a, 'X', 'S').mix);
});

test('real 2026 drives: team identity survives into the sim inputs (no washing out)', () => {
  const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w8.json', import.meta.url)));
  const TS = teamStrength(D); const teams = TS.teams; assert.equal(teams.length, 32);
  const td = teams.map(t => TS.profiles[t].off.td), pass = teams.map(t => TS.profiles[t].off.pass);
  const sd = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
  const rawTd = teams.map(t => TS.profiles[t].raw.off.td);
  assert.ok(sd(td) > 0.012 && sd(td) > 0.25 * sd(rawTd), `offense TD-rate spread ${sd(td)} vs raw ${sd(rawTd)}`); assert.ok(sd(pass) > 0.02, `pass-rate spread ${sd(pass)}`);
  // inputs carry each side's own fit and the free sim does not pin TDs back to the model
  const side = t => ({ players: [], opp: t === 'CAR' ? 'GB' : 'CAR', teamLambda: 2.5, tdBudget: null });
  const I = buildSimInputs(D, { away: 'CAR', home: 'GB', sideFor: side, gameId: 'x' });
  assert.equal(I.mode, 'free'); assert.notDeepEqual(I.teams[0].mix, I.teams[1].mix);
  assert.deepEqual(I.teams[0].mix, matchup(TS, 'CAR', 'GB').mix);
  const L = profileLines(TS.profiles.GB); assert.ok(L.off.length >= 4 && L.def.length >= 3 && [...L.off, ...L.def].every(s => /GB|%/.test(s) && s.length > 30));
});
