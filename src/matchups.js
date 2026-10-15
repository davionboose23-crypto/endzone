// Offense-defense position connection: what each defense allows each position,
// shrunk toward that defense overall and then the league, with role inheritance.
import { clamp } from './model.js';
export const POS = ['QB', 'RB', 'WR', 'TE'];
export const LEAGUE_SHARE = {
  QB: { rushYd: 0.12, rushTd: 0.18, rec: 0, recYd: 0, recTd: 0 },
  RB: { rushYd: 0.76, rushTd: 0.76, rec: 0.20, recYd: 0.15, recTd: 0.16 },
  WR: { rushYd: 0.06, rushTd: 0.03, rec: 0.56, recYd: 0.62, recTd: 0.55 },
  TE: { rushYd: 0.01, rushTd: 0.03, rec: 0.23, recYd: 0.225, recTd: 0.28 },
};
// Normalize priors so shares across QB/RB/WR/TE sum to 1 for each stat.
export function normalizedShares() {
  const out = {}; for (const p of POS) out[p] = {};
  for (const s of ['rushYd', 'rushTd', 'rec', 'recYd', 'recTd']) { const t = POS.reduce((a, p) => a + LEAGUE_SHARE[p][s], 0); for (const p of POS) out[p][s] = t ? LEAGUE_SHARE[p][s] / t : 0; }
  return out;
}
const posKey = p => (p === 'FB' ? 'RB' : p);
const blank = () => ({ carries: 0, rushYd: 0, rushTd: 0, targets: 0, rec: 0, recYd: 0, recTd: 0, games: new Set(), byGame: new Map() });

export function buildMatchupTables(rows, zones) {
  const def = new Map(), off = new Map(), league = {}; const teamGames = new Map();
  for (const p of POS) league[p] = blank();
  const leagueAll = blank();
  const get = (m, t, p) => { if (!m.has(t)) m.set(t, Object.fromEntries([...POS, 'ALL'].map(x => [x, blank()]))); return m.get(t)[p]; };
  for (const r of rows) {
    const p = posKey(r.pos); if (!POS.includes(p) || !r.opp) continue;
    for (const tgt of [get(def, r.opp, p), get(def, r.opp, 'ALL'), get(off, r.team, p), get(off, r.team, 'ALL'), league[p], leagueAll]) {
      tgt.carries += r.carries; tgt.rushYd += r.rushYd; tgt.rushTd += r.rushTd; tgt.targets += r.targets; tgt.rec += r.rec; tgt.recYd += r.recYd; tgt.recTd += r.recTd;
      tgt.games.add(r.gameId);
      const g = tgt.byGame.get(r.gameId) || { week: r.week, td: 0, rushTd: 0, recTd: 0 }; g.td += r.rushTd + r.recTd; g.rushTd += r.rushTd; g.recTd += r.recTd; tgt.byGame.set(r.gameId, g);
    }
  }
  // red-zone conversion allowed by defense from zones
  const dz = new Map(); const lz = { r: { looks: 0, scores: 0, bins: {} }, t: { looks: 0, scores: 0, bins: {} } };
  for (const z of zones || []) {
    if (z.bin === 0 || (z.path !== 'r' && z.path !== 't')) continue;
    if (!dz.has(z.opp)) dz.set(z.opp, { r: { looks: 0, scores: 0, bins: {} }, t: { looks: 0, scores: 0, bins: {} }, games: new Set() });
    const d = dz.get(z.opp); d.games.add(z.gameId);
    for (const t of [d[z.path], lz[z.path]]) { t.looks += z.looks; t.scores += z.scores; const b = t.bins[z.bin] || (t.bins[z.bin] = { looks: 0, scores: 0 }); b.looks += z.looks; b.scores += z.scores; }
  }
  return { def, off, league, leagueAll, dz, lz };
}

const rate = (n, d) => (d > 0 ? n / d : null);
// Position matchup for one offensive player's position.
export function positionMatchup(T, defense, offense, pos, { trust = 1 } = {}) {
  const p = posKey(pos);
  if (!POS.includes(p)) return null;
  const L = T.league[p], LA = T.leagueAll;
  const D = T.def.get(defense)?.[p] || blank(), DA = T.def.get(defense)?.ALL || blank();
  const lgRushTd = rate(L.rushTd, L.carries) ?? 0, lgRecTd = rate(L.recTd, L.targets) ?? 0;
  // expected TDs vs this defense at league rates
  const expD = D.carries * lgRushTd + D.targets * lgRecTd; const tdD = D.rushTd + D.recTd;
  const lgAllRate = c => ({ r: rate(LA.rushTd, LA.carries) ?? 0, t: rate(LA.recTd, LA.targets) ?? 0 });
  const la = lgAllRate();
  const expA = DA.carries * la.r + DA.targets * la.t; const tdA = DA.rushTd + DA.recTd;
  const overall = (tdA + 4) / (expA + 4);
  const softness = (tdD + 3 * overall) / (expD + 3);
  // offense role ratio: share of this team's TD/yard production by position vs league prior
  const O = T.off.get(offense)?.[p] || blank(), OA = T.off.get(offense)?.ALL || blank();
  const shares = normalizedShares()[p];
  const offShare = (O.rushYd + O.recYd) / Math.max(1, OA.rushYd + OA.recYd);
  const lgShare = (L.rushYd + L.recYd) / Math.max(1, LA.rushYd + LA.recYd) || ((shares.rushYd + shares.recYd) / 2);
  const nOff = OA.games.size;
  const roleRatio = nOff ? ((offShare * nOff + lgShare * 2) / (nOff + 2)) / lgShare : 1;
  const inherit = roleRatio >= 1.08 ? 1 : roleRatio <= 0.92 ? 0.5 : 0.5 + 0.5 * (roleRatio - 0.92) / 0.16;
  const factor = clamp(1 + trust * inherit * (softness - 1), 0.75, 1.32);
  const games = [...D.byGame.values()].sort((a, b) => b.week - a.week);
  const last3 = games.slice(0, 3);
  const last3Games = last3.filter(g => g.td > 0).length, last3Tds = last3.reduce((s, g) => s + g.td, 0);
  // concrete per-play rates
  const pathRates = {
    rush: { allowed: rate(D.rushTd, D.carries), league: lgRushTd, plays: D.carries, tds: D.rushTd },
    target: { allowed: rate(D.recTd, D.targets), league: lgRecTd, plays: D.targets, tds: D.recTd },
  };
  const eff = {
    ypc: { allowed: rate(D.rushYd, D.carries), league: rate(L.rushYd, L.carries), n: D.carries },
    catchRate: { allowed: rate(D.rec, D.targets), league: rate(L.rec, L.targets), n: D.targets },
    ypt: { allowed: rate(D.recYd, D.targets), league: rate(L.recYd, L.targets), n: D.targets },
    rushYdPg: { allowed: D.games.size ? D.rushYd / D.games.size : null, league: L.games.size ? L.rushYd / L.games.size : null },
    recYdPg: { allowed: D.games.size ? D.recYd / D.games.size : null },
    tdPg: { allowed: D.games.size ? tdD / D.games.size : null },
  };
  const dz = T.dz.get(defense);
  const rz = dz ? { rush: { looks: dz.r.looks, scores: dz.r.scores, rate: rate(dz.r.scores, dz.r.looks), league: rate(T.lz.r.scores, T.lz.r.looks), bins: dz.r.bins }, target: { looks: dz.t.looks, scores: dz.t.scores, rate: rate(dz.t.scores, dz.t.looks), league: rate(T.lz.t.scores, T.lz.t.looks), bins: dz.t.bins } } : null;
  return { pos: p, defense, softness, overall, factor, roleRatio, inherit, featured: roleRatio >= 1.08 ? 'features' : roleRatio <= 0.92 ? 'underuses' : 'uses normally',
    games: D.games.size, tdsAllowed: tdD, expectedAtLeague: expD, last3: last3.map(g => g.td), last3Games, last3Tds, supportive: last3Games >= 2, soft: softness >= 1.12, pathRates, eff, rz };
}
// Shrunk efficiency factor for a volume metric vs league (e.g. ypc allowed / league ypc).
export function efficiencyFactor(m, key, k, { trust = 1 } = {}) {
  const e = m?.eff?.[key]; if (!e || e.allowed == null || !e.league) return { factor: 1, allowed: e?.allowed ?? null, league: e?.league ?? null, n: e?.n || 0 };
  const shr = (e.allowed * e.n + e.league * k) / (e.n + k);
  return { factor: clamp(1 + trust * (shr / e.league - 1), 0.8, 1.2), allowed: e.allowed, league: e.league, n: e.n };
}
export function matchupSentence(m, oppName) {
  if (!m) return 'Fullback: modeled with conservative priors; no positional defense split.';
  const r = m.pathRates[m.pos === 'WR' || m.pos === 'TE' ? 'target' : 'rush'];
  const plays = m.pos === 'WR' || m.pos === 'TE' ? 'targets' : 'carries';
  if (r.allowed == null) return `${oppName} has no ${m.pos} sample yet this season; league rate used.`;
  return `${oppName} allows ${m.pos}s a touchdown on ${(r.allowed * 100).toFixed(1)}% of ${plays} (${r.tds} of ${r.plays}), versus ${(r.league * 100).toFixed(1)}% league; the chance uses that rate, shrunk to ${(m.softness).toFixed(2)}× league.`;
}
