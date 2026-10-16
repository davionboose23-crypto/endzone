// endzone-4.4 trends agent: bounded effects, no leakage, caps/budget hold, status tracking, snapshots carry effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './fixture.js';
import { runEngine } from '../src/engine.js';
import { snapshotFromGame } from '../src/grading.js';
import { trendMultipliers, PER_TREND, PER_PLAYER, playerTrends, playerTrendsWithStatus, defenseTrends, defenseTrendsWithStatus, shippedTrendWeights, componentMult } from '../src/trends.js';
import { chooseWeight } from '../scripts/trend-gate.mjs';
const firstKick = prep => Math.min(...prep.games.filter(g => g.week === prep.week).map(g => Date.parse(g.kickoff)));
const BIG = { snap: 5, usage: 5, redzone: 5, qbRush: 5, streak: 5, defense: 5, miss: 5 };
const eff = ['share', 'rzshare', 'rshare', 'spot', 'def'];

test('trend multipliers are bounded per trend and per player, even with extreme weights', () => {
  const trends = eff.flatMap(() => ['snap', 'usage', 'redzone', 'streak', 'defense', 'qbRush', 'miss'].map((f, i) => ({ id: `${f}:${i}`, family: f, strength: i % 2 ? 1 : -1 })));
  for (const w of [BIG, Object.fromEntries(Object.keys(BIG).map(k => [k, -5]))]) {
    const { m, applied } = trendMultipliers(trends, w);
    for (const a of applied) assert.ok(a.mult >= PER_TREND[0] - 1e-12 && a.mult <= PER_TREND[1] + 1e-12);
    for (const k of eff) assert.ok(m[k] >= PER_PLAYER[0] && m[k] <= PER_PLAYER[1], k);
    for (const p of ['r', 't']) for (const b of [0, 1, 2, 3]) { const x = componentMult(m, p, b); assert.ok(x >= PER_PLAYER[0] && x <= PER_PLAYER[1]); }
  }
  const z = trendMultipliers(trends, {}); for (const k of eff) assert.equal(z.m[k], 1);
  assert.ok(z.applied.every(a => a.mult === 1), 'weight 0 = tracked at ×1');
  assert.ok(Object.values(shippedTrendWeights()).every(w => typeof w === 'number'));
});

test('safety caps and team TD budget still hold with trends at extreme weights; weight 0 changes nothing', () => {
  const prep = makeFixture(); const now = firstKick(prep) - 86400e3;
  const on = runEngine(prep, { now, trendWeights: BIG }), off = runEngine(prep, { now, trendWeights: {} }), shipped = runEngine(prep, { now });
  let moved = 0;
  for (const [i, G] of on.games.entries()) for (const s of ['away', 'home']) {
    const S = G.sides[s]; assert.ok(S.teamLambda <= S.tdBudget + 1e-6, 'team budget holds');
    for (const p of S.raw) { if (p.ceiling != null) assert.ok(p.chance <= p.ceiling + 1e-9, `${p.name} under ceiling`); if (p.trendEffect && Math.abs(p.trendEffect.after - p.trendEffect.before) > 1e-6) moved++; }
    const offP = off.games[i].sides[s].players, shP = shipped.games[i].sides[s].players;
    offP.forEach((p, j) => { assert.equal(p.chance, shP[j].chance, 'shipped weights are all 0 → identical'); for (const it of p.trendEffect?.items || []) assert.equal(it.pp, 0); });
  }
  assert.ok(moved > 0, 'extreme weights do move some pre-cap chances');
});

test('no leakage: trends ignore games, rows and graded history from the forecast week or later', () => {
  const games = [1, 2, 3, 4].map(w => ({ week: w, offPct: w > 2 ? 0.9 : 0.4, carries: 5, targets: 3, teamCarries: 25, teamTargets: 35, td: 0, rzRush: 1, rzTgt: 0 }));
  const p = { id: 'x', name: 'X', pos: 'RB', team: 'KC', f: { games } };
  const hist = [1, 2, 3, 4].map(w => ({ id: 'x', week: w, chance: 0.5, y: 0 }));
  const a = playerTrends(p, { history: hist, week: 5 });
  const b = playerTrends(p, { history: [...hist, ...[5, 6, 7].map(w => ({ id: 'x', week: w, chance: 0.01, y: 1 }))], week: 5 });
  assert.deepEqual(a, b, 'future graded rows ignored');
  assert.ok(a.some(t => t.family === 'snap' && t.direction === 'up'));
  const rows = []; for (const w of [1, 2, 3, 4, 5]) rows.push({ opp: 'BUF', week: w, gameId: `g${w}`, pos: 'WR', td: w >= 3 ? 2 : 0 });
  const d1 = defenseTrends(rows, 'BUF', 5); const d2 = defenseTrends([...rows, { opp: 'BUF', week: 5, gameId: 'g5b', pos: 'WR', td: 9 }, { opp: 'BUF', week: 6, gameId: 'g6', pos: 'WR', td: 9 }], 'BUF', 5);
  assert.deepEqual(d1, d2);
});

test('status tracking: new, continuing (with first-detected week) and faded, reproducible from earlier data', () => {
  const g = (w, off) => ({ week: w, offPct: off, carries: 5, targets: 3, teamCarries: 25, teamTargets: 35, td: 0 });
  const p = games => ({ id: 'x', name: 'X', pos: 'WR', team: 'KC', f: { games } });
  const fresh = playerTrendsWithStatus(p([g(1, .4), g(2, .4), g(3, .4), g(4, .9)]), { history: [], week: 5 }).find(t => t.family === 'snap');
  assert.equal(fresh.status, 'new'); assert.equal(fresh.firstDetectedWeek, 5);
  const cont = playerTrendsWithStatus(p([g(1, .4), g(2, .4), g(3, .4), g(4, .9), g(5, .9)]), { history: [], week: 6 }).find(t => t.family === 'snap');
  assert.equal(cont.status, 'continuing'); assert.equal(cont.firstDetectedWeek, 5);
  const faded = playerTrendsWithStatus(p([g(1, .4), g(2, .4), g(3, .4), g(4, .9), g(5, .9), g(6, .9), g(7, .9), g(8, .9)]), { history: [], week: 9 }).find(t => t.family === 'snap');
  assert.equal(faded.status, 'faded'); assert.equal(faded.strength, 0);
  assert.equal(trendMultipliers([faded], BIG).applied.length, 0, 'faded trends carry no effect');
  const rows = []; for (const w of [1, 2, 3, 4, 5, 6]) rows.push({ opp: 'BUF', week: w, gameId: `g${w}`, pos: 'WR', td: w >= 3 ? 2 : 0 });
  const d = defenseTrendsWithStatus(rows, 'BUF', 7).find(t => t.entity.pos === 'WR' && t.status !== 'faded');
  assert.ok(d && d.status === 'continuing' && d.firstDetectedWeek === 6, JSON.stringify(d));
});

test('frozen snapshots carry trend tags and the trend effect', () => {
  const prep = makeFixture(); const now = firstKick(prep) - 86400e3;
  const res = runEngine(prep, { now, trendWeights: { usage: 0.3, snap: 0.3, redzone: 0.3, streak: 0.3, defense: 0.3 } });
  const snaps = res.games.map(G => snapshotFromGame(G, { modelVersion: 'x', weights: {} }));
  const ps = snaps.flatMap(s => s.players);
  assert.ok(ps.every(p => 'trendTags' in p && 'trendEffect' in p));
  assert.ok(ps.some(p => p.trendEffect && p.trendEffect.items.length));
});

test('gate weight choice uses only weeks before the evaluated week (never the test week)', () => {
  const row = (y, c) => ({ y, chance: c });
  const base = { 1: [row(1, .3)], 2: [row(1, .3)], 3: [row(1, .3)] };
  const cur = { 0.1: { 1: [row(1, .3)], 2: [row(1, .3)], 3: [row(1, .9)] } };
  assert.equal(chooseWeight({ n: 0, dLogLoss: {} }, 'snap', [0.1], cur, base, 3), 0, 'week 3 advantage invisible when choosing for week 3');
  assert.equal(chooseWeight({ n: 0, dLogLoss: {} }, 'snap', [0.1], cur, base, 4), 0.1, 'visible once week 3 is in the past');
  assert.equal(chooseWeight({ n: 100, dLogLoss: { snap: { 0.1: 0.01 } } }, 'snap', [0.1], cur, base, 2), 0, 'prior-season harm counts');
});
