// app 4.14.0 research lab (fast, no sims): walk-forward test of the data-player universe, scorer split and depth calibration
// behind the sim's top-4 picks. Poisson proxy: anytime_i = 1 - exp(-share_i * tdData) (tdData = the drive sim's opponent-adjusted TD level).
// Scoring pool = the PRE-GAME roster (nflverse weekly roster: team players at QB/RB/WR/TE/FB not on IR / practice squad / cut),
// so late scratches and players the sim never listed count (as misses / near-zero chances).
//   TAG=x UNIV='{"carry":true,...}' ROSTER=full|inj node scripts/sim/top4-lab.mjs     VARIANTS='{"name":{floor,depthCal,...}}'
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { loadTable, tableToD } from './table.mjs';
import { buildSimInputs, depthSlots, DATA_OPTS } from '../../src/sim.js';
import { tallyGames, buildTdShare } from '../../src/td-share.js';
import { loadPbpSeason } from '../pbp/lib.mjs';
import { rosterWeek, poolOf } from './roster-week.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const splitCsv = l => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
const csv = txt => { const L = txt.trim().split('\n'); const H = splitCsv(L[0]); return L.slice(1).map(l => { const a = splitCsv(l); return Object.fromEntries(H.map((h, i) => [h, a[i]])); }); };
const Gm = new Map(); for (const o of csv(fs.readFileSync('/tmp/nflverse-games.csv', 'utf8'))) { if (+o.season < 2025 || o.game_type !== 'REG' || o.away_score === '') continue; Gm.set(o.game_id, { season: +o.season, week: +o.week, away: o.away_team, home: o.home_team }); }
const TAB = {}; for (const s of [2024, 2025, 2026]) TAB[s] = await loadPbpSeason(s);
const tallies = Object.values(TAB).flatMap(tallyGames);
const tdOf = (S, W, team) => { const T = tallies.find(x => x.season === S && x.week === W && x.off === team); const m = new Map(); if (T) for (const x of T.pl.values()) if (x.v[7] > 0) m.set(x.id, x.v[7]); return m; };
const clampP = p => Math.min(0.995, Math.max(0.005, p));
const UNIV = JSON.parse(process.env.UNIV || '{}'); const ROSTER = process.env.ROSTER || 'full';
async function collect(S, weeks) {
  const T = loadTable(ROOT, S); const out = [];
  for (const W of weeks) {
    const D = W > 1 ? tableToD(T, { before: W }) : fs.existsSync(path.join(ROOT, 'archive', 'drives', String(S - 1), 'table.json')) ? tableToD(loadTable(ROOT, S - 1)) : null; if (!D) continue;
    const td = buildTdShare([TAB[S - 1], TAB[S]], { season: S, before: W }); const R = rosterWeek(S, W, ROSTER === 'full');
    for (const [gid, gm] of Gm) { if (gm.season !== S || gm.week !== W) continue;
      const I = buildSimInputs(D, { away: gm.away, home: gm.home, gameId: gid, tdShare: td, rosterNow: R, dataOpts: { ...DATA_OPTS, floor: 0, depthCal: null, ...UNIV } });
      const teams = I.teams.map(t => { const act = tdOf(S, W, t.team); const slot = depthSlots(t.players); const lt = t.players.reduce((a, p) => a + p.lam, 0) || 1;
        const sim = new Map(t.players.map((p, i) => [p.gsis, { sh: p.lam / lt, slot: slot[i], nc: p.newcomer || null }]));
        const pool = poolOf(S, W, t.team); for (const g of act.keys()) if (!pool.has(g)) pool.set(g, { pos: '?', name: g, late: true });
        const pl = [...pool.entries()].map(([g, r]) => { const x = sim.get(g); return { gsis: g, name: r.name, pos: r.pos, sh: x ? x.sh : 0, slot: x?.slot || null, nc: x?.nc || null, listed: !!x, y: act.get(g) || 0 }; });
        const lost = [...sim.keys()].filter(g => !pool.has(g)).reduce((a, g) => a + sim.get(g).sh, 0); // sim TD share on players NOT on the pre-game roster
        return { team: t.team, tdData: t.tdData, pl, lost, actTot: [...act.values()].reduce((a, b) => a + b, 0) }; });
      out.push({ S, W, gid, teams }); }
    process.stderr.write(`${S}w${W} `);
  }
  return out;
}
const wk = S => [...new Set([...Gm.values()].filter(g => g.season === S).map(g => g.week))].sort((a, b) => a - b);
const cacheF = `/tmp/top4-lab2-${process.env.TAG || 'base'}.json`;
let DATA; if (fs.existsSync(cacheF) && !process.env.FRESH) DATA = JSON.parse(fs.readFileSync(cacheF, 'utf8'));
else { DATA = { 2026: await collect(2026, wk(2026)), 2025: await collect(2025, wk(2025)) }; fs.writeFileSync(cacheF, JSON.stringify(DATA)); }
// star = a QB1 or one of the team's top-3 skill players by recent touches in the sim's list; everyone else (incl. unlisted) = role
const isRole = p => !p.slot || (p.slot === 'QB2') || (!/^QB/.test(p.slot) && !/^(RB1|WR1|WR2|TE1)$/.test(p.slot));
function depthTable(prior, k = 10) { const A = {}; for (const g of prior) for (const t of g.teams) for (const p of t.pl) { if (!p.slot) continue; const a = A[p.slot] = A[p.slot] || [0, 0]; a[0] += p.y; a[1] += p.sh * t.tdData; }
  return Object.fromEntries(Object.entries(A).map(([d, [y, l]]) => [d, (y + k) / (l + k)])); }
function evalV(games, { floor = 0, depthCal = false, depthK = 10, lvlK = 1 } = {}, prior0 = []) {
  const DT = {}; if (depthCal) for (const W of new Set(games.map(g => g.W))) DT[W] = depthTable([...prior0, ...games.filter(g => g.W < W)], depthK);
  const hits = []; let ge1 = 0, ge2 = 0, rolePicks = 0, roleHits = 0, roleSc = 0, roleScIn = 0, sc = 0, lowSc = 0, lostSum = 0, tg = 0; const ll = {}, br = {}, n = {}; const topK = {};
  for (const g of games) { const cand = [];
    for (const t of g.teams) { let v = t.pl.map(p => p.listed ? p.sh * (depthCal && p.slot ? (DT[g.W][p.slot] ?? 1) : 1) : 0); const Z0 = v.reduce((a, b) => a + b, 0) + t.lost || 1; v = v.map(x => x / Z0);
      if (floor > 0) { v = v.map((x, i) => t.pl[i].listed ? Math.max(x, floor) : x); const z = v.reduce((a, b) => a + b, 0) + t.lost / Z0; v = v.map(x => x / z); }
      lostSum += t.lost; tg++;
      t.pl.forEach((p, i) => cand.push({ p, pr: 1 - Math.exp(-v[i] * t.tdData * lvlK), role: isRole(p) })); }
    for (const c of cand) { const k = c.p.pos === 'FB' ? 'RB' : c.p.pos; const y = c.p.y > 0 ? 1 : 0; for (const kk of ['all', k]) { const pr = clampP(c.pr); ll[kk] = (ll[kk] || 0) - (y ? Math.log(pr) : Math.log(1 - pr)); br[kk] = (br[kk] || 0) + (c.pr - y) ** 2; n[kk] = (n[kk] || 0) + 1; }
      if (y) { sc++; if (c.role) roleSc++; if (c.pr < 0.01) lowSc++; } }
    const srt = cand.sort((a, b) => b.pr - a.pr); for (let K = 1; K <= 8; K++) topK[K] = (topK[K] || 0) + srt.slice(0, K).filter(c => c.p.y > 0).length;
    const top = srt.slice(0, 4); const h = top.filter(c => c.p.y > 0).length; hits.push(h); if (h >= 1) ge1++; if (h >= 2) ge2++;
    for (const c of top) if (c.role) { rolePicks++; if (c.p.y > 0) { roleHits++; roleScIn++; } } }
  const G = games.length; const m = hits.reduce((a, b) => a + b, 0) / G; const se = Math.sqrt(hits.reduce((a, x) => a + (x - m) ** 2, 0) / G / G);
  return { games: G, hitsPerGame: +m.toFixed(3), se: +se.toFixed(3), ge1: +(ge1 / G).toFixed(3), ge2: +(ge2 / G).toFixed(3), topK: Object.values(topK).map(v => +(v / G).toFixed(2)), rolePicksPerGame: +(rolePicks / G).toFixed(2), roleHitRate: rolePicks ? +(roleHits / rolePicks).toFixed(3) : null,
    roleScorerShare: +(roleSc / sc).toFixed(3), roleScorersInTop4: +(roleScIn / Math.max(1, roleSc)).toFixed(3), scorersUnder1pct: +(lowSc / sc).toFixed(3), simShareOffRoster: +(lostSum / tg).toFixed(3),
    logLoss: Object.fromEntries(Object.keys(ll).map(k => [k, +(ll[k] / n[k]).toFixed(4)])), brier: Object.fromEntries(Object.keys(br).map(k => [k, +(br[k] / n[k]).toFixed(4)])), perGame: hits };
}
const V = JSON.parse(process.env.VARIANTS || '{"base":{}}'); const res = {}; let first = null;
for (const [name, o] of Object.entries(V)) { res[name] = { 2026: evalV(DATA[2026], o, DATA[2025]), 2025: evalV(DATA[2025], o) }; if (!first) first = res[name];
  for (const s of ['2026', '2025']) { const d = res[name][s].perGame.map((x, i) => x - first[s].perGame[i]); const mm = d.reduce((a, b) => a + b, 0) / d.length; res[name][s].pairedVsFirst = [+mm.toFixed(3), +Math.sqrt(d.reduce((a, x) => a + (x - mm) ** 2, 0) / d.length / d.length).toFixed(3)]; } }
for (const r of Object.values(res)) for (const s of ['2026', '2025']) delete r[s].perGame;
if (process.env.SHOWDT) console.error(JSON.stringify(depthTable([...DATA[2025], ...DATA[2026]]), (k, v) => typeof v === 'number' ? +v.toFixed(3) : v));
console.log(JSON.stringify(res));
