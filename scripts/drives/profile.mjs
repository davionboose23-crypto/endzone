// Team / defense drive profiles for the Drives section and the drive-pattern adjustment (pre-game: drives before week w).
//   league:  drives per game, share of offensive TDs scored on each kind of drive (tdShare per subset), TD rates,
//            position shares of red-zone / goal-to-go TDs.               (seasons s-1 + s before w)
//   defense: per team, what it ALLOWED this season: red-zone trips / TDs per drive, TDs per red-zone trip, per goal-to-go
//            drive, opening-script TD rate, drives faced per game, which positions score against it in the red zone and
//            goal to go. Rates are shrunk toward the league (20 pseudo-drives; 10 pseudo-trips) -> idx = shrunk / league.
//            Each rate is tested against the league with an exact binomial, Benjamini-Hochberg across all 32 x 5 tests;
//            ranks are descriptive and only "significant" ones are called out as more than a ranking.
//   offense: per team, drives per game, plays per drive, red-zone reach rate, TD rate, run/pass mix by phase.
//   teams:   this season's games drive by drive with every player's line (for the drive grid).
import { SUBSETS, PHASES, DRIVE_FLAGS, binomTwoSided, bhQ } from '../../src/drive-patterns.js';
const isTD = d => d.result === 'Touchdown';
const RES = { Touchdown: 'TD', 'Field goal': 'FG', 'Missed field goal': 'MFG', Punt: 'Punt', Turnover: 'TO', 'Turnover on downs': 'Downs', 'End of half': 'Half', 'Opp touchdown': 'TO', Safety: 'Safety' };
const r3 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000;
const POS = ['RB', 'WR', 'TE', 'QB'];
const ph = Object.fromEntries(PHASES.map(([k, , f]) => [k, f]));
// per drive player rows: Map(gameKey -> Map(n -> [{pid,...row}]))
function driveRows(I) {
  const out = new Map();
  for (const [pid, pm] of I.byP) for (const [gk, m] of pm) { if (!out.has(gk)) out.set(gk, new Map()); const g = out.get(gk); for (const [n, o] of m) { if (!g.has(n)) g.set(n, []); g.get(n).push({ ...o, pid }); } }
  return out;
}
const rankDesc = (teams, f) => { const L = teams.filter(t => f(t) != null).sort((a, b) => f(b) - f(a)); const R = {}; L.forEach((t, i) => { R[t.team] = i + 1; }); return R; };
export function profiles(I, s, w) {
  const DR = driveRows(I); const G = [...I.games.values()];
  const posOf = pid => I.people[pid]?.pos || null;
  const tdPos = (g, d) => (DR.get(g.key)?.get(d.n) || []).filter(o => o.td > 0).map(o => posOf(o.pid)).filter(Boolean);
  // ---- league (s-1 + s window)
  const lg = { games: G.length, drives: 0, tds: 0, rz: 0, rzTd: 0, gtg: 0, gtgTd: 0, open: 0, openTd: 0, sub: {}, pos: { rz: {}, gtg: {} } };
  for (const S of SUBSETS) lg.sub[S.key] = 0;
  for (const g of G) for (const d of g.drives) {
    lg.drives++; const td = isTD(d); if (td) { lg.tds++; for (const S of SUBSETS) if (S.f(d)) lg.sub[S.key]++; }
    if (ph.rz(d)) { lg.rz++; if (td) { lg.rzTd++; for (const p of tdPos(g, d)) lg.pos.rz[p] = (lg.pos.rz[p] || 0) + 1; } }
    if (ph.gtg(d)) { lg.gtg++; if (td) { lg.gtgTd++; for (const p of tdPos(g, d)) lg.pos.gtg[p] = (lg.pos.gtg[p] || 0) + 1; } }
    if (d.n <= 2) { lg.open++; if (td) lg.openTd++; }
  }
  const tot = o => Object.values(o).reduce((a, b) => a + b, 0);
  const league = { window: `${s - 1} + ${s} before week ${w}`, games: lg.games, dpg: r3(lg.drives / Math.max(1, lg.games)), tdPerDrive: r3(lg.tds / lg.drives), rzPerDrive: r3(lg.rz / lg.drives),
    rzTd: r3(lg.rzTd / lg.rz), gtgTd: r3(lg.gtgTd / lg.gtg), openTd: r3(lg.openTd / lg.open),
    tdShare: Object.fromEntries(Object.entries(lg.sub).map(([k, v]) => [k, r3(v / Math.max(1, lg.tds))])),
    posShare: { rz: Object.fromEntries(POS.map(p => [p, r3((lg.pos.rz[p] || 0) / Math.max(1, tot(lg.pos.rz)))])), gtg: Object.fromEntries(POS.map(p => [p, r3((lg.pos.gtg[p] || 0) / Math.max(1, tot(lg.pos.gtg)))])) } };
  // ---- this season, per offense and per defense
  const cur = G.filter(g => g.season === s); const teams = [...new Set(cur.flatMap(g => [g.team, g.opp]))].sort();
  const acc = () => ({ games: 0, drives: 0, plays: 0, tds: 0, rz: 0, rzTd: 0, gtg: 0, gtgTd: 0, open: 0, openTd: 0, pos: { rz: {}, gtg: {} } });
  const O = {}, Dd = {}; for (const t of teams) { O[t] = acc(); Dd[t] = acc(); }
  for (const g of cur) for (const A of [O[g.team], Dd[g.opp]]) { if (!A) continue; A.games++;
    for (const d of g.drives) { A.drives++; A.plays += d.plays || 0; const td = isTD(d); if (td) A.tds++;
      if (ph.rz(d)) { A.rz++; if (td) { A.rzTd++; for (const p of tdPos(g, d)) A.pos.rz[p] = (A.pos.rz[p] || 0) + 1; } }
      if (ph.gtg(d)) { A.gtg++; if (td) { A.gtgTd++; for (const p of tdPos(g, d)) A.pos.gtg[p] = (A.pos.gtg[p] || 0) + 1; } }
      if (d.n <= 2) { A.open++; if (td) A.openTd++; } } }
  const K = { rzPer: 20, tdPer: 20, rzTd: 10, gtgTd: 10, openTd: 20 };
  const L0 = { rzPer: league.rzPerDrive, tdPer: league.tdPerDrive, rzTd: league.rzTd, gtgTd: league.gtgTd, openTd: league.openTd };
  const kn = A => ({ rzPer: [A.rz, A.drives], tdPer: [A.tds, A.drives], rzTd: [A.rzTd, A.rz], gtgTd: [A.gtgTd, A.gtg], openTd: [A.openTd, A.open] });
  const tests = [];
  const defense = {};
  for (const t of teams) { const A = Dd[t]; if (!A.games) continue; const idx = {}, rate = {}, n = {}, shr = {};
    for (const [k, [x, m]] of Object.entries(kn(A))) { const b = L0[k]; rate[k] = m ? r3(x / m) : null; n[k] = [x, m]; const sh = (x + K[k] * b) / (m + K[k]); shr[k] = r3(sh); idx[k] = r3(sh / b); tests.push({ team: t, key: k, p: binomTwoSided(x, m, b) }); }
    const posIdx = {}, posShare = {};
    for (const z of ['rz', 'gtg']) { const T = tot(A.pos[z]); posIdx[z] = {}; posShare[z] = {}; for (const p of POS) { const lsh = league.posShare[z][p] || 0.01; posShare[z][p] = T ? r3((A.pos[z][p] || 0) / T) : null; posIdx[z][p] = r3(((A.pos[z][p] || 0) + 5 * lsh) / (T + 5) / lsh); } posIdx[z].tds = T; }
    defense[t] = { games: A.games, drives: A.drives, dpg: r3(A.drives / A.games), rate, n, shrunk: shr, idx: { rzPer: idx.rzPer, tdPer: idx.tdPer, rzTd: idx.rzTd, gtgTd: idx.gtgTd, openTd: idx.openTd }, posIdx, posShare, posTds: A.pos };
  }
  const q = bhQ(tests.map(x => x.p)); tests.forEach((x, i) => { const D = defense[x.team]; (D.q || (D.q = {}))[x.key] = +q[i].toPrecision(2); (D.p || (D.p = {}))[x.key] = +x.p.toPrecision(2); });
  const DL = Object.entries(defense).map(([team, v]) => ({ team, ...v }));
  for (const k of ['rzPer', 'tdPer', 'rzTd', 'gtgTd', 'openTd']) { const R = rankDesc(DL, x => x.shrunk[k]); for (const x of DL) (defense[x.team].rank || (defense[x.team].rank = {}))[k] = R[x.team] ?? null; }
  for (const z of ['rz', 'gtg']) for (const p of POS) { const R = rankDesc(DL.filter(x => x.posIdx[z].tds > 0), x => x.posShare[z][p]); for (const x of DL) { const rk = defense[x.team].rank; (rk.pos || (rk.pos = {}))[`${z}${p}`] = R[x.team] ?? null; } }
  const offense = {};
  for (const t of teams) { const A = O[t]; if (!A.games) continue; offense[t] = { games: A.games, drives: A.drives, dpg: r3(A.drives / A.games), playsPerDrive: r3(A.plays / A.drives), rzPerDrive: r3(A.rz / A.drives), tdPerDrive: r3(A.tds / A.drives), rzTd: A.rz ? r3(A.rzTd / A.rz) : null, openTd: A.open ? r3(A.openTd / A.open) : null }; }
  // ---- drive grids (this season), players indexed per team
  const tm = {};
  for (const g of cur.slice().sort((a, b) => a.week - b.week)) { const T = tm[g.team] || (tm[g.team] = { people: [], idx: {}, games: [] });
    const pi = pid => { if (T.idx[pid] == null) { const pe = I.people[pid] || {}; T.idx[pid] = T.people.length; T.people.push([pid, pe.name || pid, pe.pos || null, pe.sleeper || null]); } return T.idx[pid]; };
    T.games.push({ w: g.week, opp: g.opp, d: g.drives.map(d => [d.n, d.half, d.sd, d.flags, d.plays, RES[d.result] || d.result, d.tgt, d.car,
      (DR.get(g.key)?.get(d.n) || []).filter(o => o.tgt || o.car).map(o => [pi(o.pid), o.tgt, o.rec, o.recYd, o.car, o.rushYd, o.rz, o.td])]) }); }
  for (const T of Object.values(tm)) delete T.idx;
  return { league, defense, offense, teams: tm, defenseMethod: 'Allowed this season; rates shrunk toward the league (20 pseudo-drives, 10 pseudo-trips for per-trip rates); exact binomial vs league with Benjamini-Hochberg across all teams and rates; rank 1 = most allowed. Only q <= 0.10 is called a real difference; other ranks are descriptive.' };
}
