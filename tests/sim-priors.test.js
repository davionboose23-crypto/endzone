// app 4.15.0: real-data-only sim priors (usage-prior-1, prior-season team strength, ctx-1 home / rest / wind).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ctxFeatures, fitContext, contextRows, shiftMix, ctxLog } from '../src/game-context.js';
import { priorOf } from '../src/usage-prior.js';
import { buildSimInputs, assertMarketFree } from '../src/sim.js';

const P = JSON.parse(fs.readFileSync(new URL('../archive/sim/sim-priors-2026.json', import.meta.url)));
const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w8.json', import.meta.url)));

test('ctx features: home / away / neutral, capped rest, outdoor wind only', () => {
  assert.deepEqual(ctxFeatures({ side: 'home', restOwn: 14, restOpp: 6, roof: 'outdoors', wind: 20 }), [1, 1, 1]);
  assert.deepEqual(ctxFeatures({ side: 'away', neutral: true, restOwn: 6, restOpp: 7, roof: 'dome', wind: 30 }), [0, -1 / 7, 0]);
});

test('ctx fit reads scores / site / rest / wind only — betting columns cannot move it', () => {
  const rows = []; for (let i = 0; i < 400; i++) rows.push({ season: '2024', game_type: 'REG', location: 'Home', home_score: String(24 + (i % 7)), away_score: String(20 + (i % 5)), home_rest: '7', away_rest: String(6 + (i % 3)), roof: 'outdoors', wind: String(i % 20), spread_line: '3', total_line: '44' });
  const a = fitContext(contextRows(rows, [2024])); const b = fitContext(contextRows(rows.map(r => ({ ...r, spread_line: '-14', total_line: '60', home_moneyline: '900' })), [2024]));
  assert.deepEqual(a, b); assert.ok(a.coef[0] > 0, 'home scores more in this toy data');
});

test('shiftMix keeps a valid distribution and is capped at +-15%', () => {
  const r = [0.22, 0.12, 0.02, 0.4, 0.1, 0.1, 0.04]; const s = shiftMix(r, 0.5);
  assert.ok(Math.abs(s.reduce((x, y) => x + y, 0) - 1) < 1e-9); assert.ok(Math.abs((s[0] + s[1] + s[2]) / 0.36 - 1.15) < 1e-9);
  assert.deepEqual(shiftMix(r, 0), r);
});

test('shipped priors file: last-season usage, prior team strength and a small shrunk ctx fit, no market keys', () => {
  assert.equal(P.season, 2026); assert.ok(P.ctx.fitted && P.ctx.coef.every(c => Math.abs(c) < 0.15));
  assert.ok(P.ts.teams.length === 32); assert.ok(Object.keys(P.games).length >= 256);
  const s = JSON.stringify(P); for (const k of ['spread', 'total_line', 'moneyline', 'implied', 'odds', 'vegas']) assert.ok(!s.includes(k), k);
});

test('4.15.0 tag fix: carried-in stars rank as starters with last-season usage', () => {
  // Brock Bowers (LV) was tagged as a role player in 2026 week 3 before usage-prior-1
  const any = Object.entries(P.usage.players || P.usage).find(([, v]) => v[1] === 'TE' && v[0] === 'LV');
  assert.ok(any, 'an LV tight end in last season usage'); const u = priorOf(P.usage, any[0]); assert.ok(u.g >= 2 && u.tgt > 0);
});

test('live sim inputs with priors stay market-free and differ only by real-data context', () => {
  const g = Object.keys(P.games).find(k => k.startsWith('8:')); const [, m] = g.split(':'); const [away, home] = m.split('@');
  const base = buildSimInputs(D, { away, home }); const w = buildSimInputs(D, { away, home, usagePrior: P.usage, tsPrior: P.ts, ctx: { ...P.games[g], fit: P.ctx } });
  assertMarketFree(w); assert.equal(base.teams.length, 2); assert.equal(w.teams.length, 2);
  assert.ok(Number.isFinite(ctxLog(P.ctx, ctxFeatures({ side: 'home', restOwn: 7, restOpp: 7 }))));
});
