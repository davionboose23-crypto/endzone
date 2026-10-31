// app 4.20.0 — team pass-rush pressure from Pro Football Reference advanced passing (per QB per game), as republished weekly by nflverse:
// https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats/advstats_week_pass_<season>.csv (public, no login, no betting data).
// Rows are game-level (season, week, team, opponent), so a fit for week W reads weeks < W only (walk-forward, no leakage).
export function parsePressure(text) {
  const [h, ...ls] = text.trim().split(/\r?\n/); const c = h.split(','); const ix = k => c.indexOf(k);
  const iS = ix('season'), iW = ix('week'), iT = ix('team'), iO = ix('opponent'), iP = ix('times_pressured'), iR = ix('times_pressured_pct'), iG = ix('game_type');
  const agg = new Map();
  for (const l of ls) { const a = l.split(','); if (iG >= 0 && a[iG] && a[iG] !== 'REG') continue; const p = +a[iP], r = +a[iR]; if (!Number.isFinite(p)) continue;
    const db = r > 0 ? p / r : null; const k = `${a[iS]}|${a[iW]}|${a[iT]}`; const g = agg.get(k) || { season: +a[iS], week: +a[iW], team: a[iT], opp: a[iO], prs: 0, db: 0, nodb: 0 };
    g.prs += p; if (db != null) g.db += db; else g.nodb++; agg.set(k, g); }
  return [...agg.values()].map(g => ({ ...g, db: Math.round(g.db + g.nodb * 8) })).filter(g => g.db > 0);
}
// opponent-adjusted logit pressure rate: offense allowed + defense generated, ridge-shrunk toward league (k dropbacks of prior weight)
export function fitPressure(rows, teams, { before, k = 120 } = {}) {
  const R = rows.filter(r => r.week < before); if (!R.length) return null; const ti = new Map(teams.map((t, i) => [t, i])); const NT = teams.length;
  const P = R.reduce((a, r) => a + r.prs, 0), N = R.reduce((a, r) => a + r.db, 0); const base = Math.log(P / (N - P));
  const off = new Float64Array(NT), def = new Float64Array(NT); const sig = x => 1 / (1 + Math.exp(-x));
  for (let it = 0; it < 15; it++) for (const [B, key] of [[off, 'team'], [def, 'opp']]) { const G = new Float64Array(NT), H = new Float64Array(NT);
    for (const r of R) { const o = ti.get(r.team), d = ti.get(r.opp); if (o == null || d == null) continue; const p = sig(base + off[o] + def[d]); const j = key === 'team' ? o : d; G[j] += r.prs - r.db * p; H[j] += r.db * p * (1 - p); }
    for (let j = 0; j < NT; j++) B[j] += (G[j] - k * 0.22 * B[j]) / (H[j] + k * 0.22); }
  const r3 = x => Math.round(x * 1000) / 1000;
  return { src: 'pfr_advstats', through: R.reduce((m, r) => Math.max(m, r.week), 0), rate: r3(P / N), base: r3(base), off: Array.from(off, r3), def: Array.from(def, r3), n: R.length };
}
// outcome shifts implied by a matchup pressure rate vs league: mix of pressured / clean conditional rates (public PFR-era splits, documented, not fitted)
const COND = { sack: [0.19, 0.005], scr: [0.10, 0.025], cmp: [0.50, 0.70], int: [0.035, 0.02] };
export function pressureShifts(F, o, d, w = 1) {
  if (!F || o < 0 || d < 0) return null; const sig = x => 1 / (1 + Math.exp(-x)); const lg = q => Math.log(q / (1 - q));
  const pL = F.rate, pM = sig(F.base + F.off[o] + F.def[d]); const out = {};
  for (const [k, [a, b]] of Object.entries(COND)) out[k] = Math.round(w * (lg(pM * a + (1 - pM) * b) - lg(pL * a + (1 - pL) * b)) * 1e4) / 1e4;
  return out;
}
