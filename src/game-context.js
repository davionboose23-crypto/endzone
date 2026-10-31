// app 4.15.0 ctx-1: small, shrunk game-context terms for the model-free drive sim, from real game results only
// (nflverse schedule: final scores, home / neutral site, days of rest, roof, wind). NO betting-market columns (spread, total,
// moneyline, odds) are read. Fit: Poisson regression of each team's points on [home, rest difference, wind], ridge-penalised
// toward 0 (no effect), on seasons BEFORE the one being simulated. Applied as a multiplier on the drive's TD and FG chances.
export const CTX_VERSION = 'ctx-1';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// features for one team in one game: home (+1 home, -1 away, 0 neutral), rest diff (own - opp days, capped +-7, /7), wind (mph over 10, /10, outdoors)
export function ctxFeatures({ side, neutral = false, restOwn = null, restOpp = null, roof = null, wind = null }) {
  const h = neutral ? 0 : side === 'home' ? 1 : -1; const r = restOwn != null && restOpp != null && Number.isFinite(restOwn - restOpp) ? clamp(restOwn - restOpp, -7, 7) / 7 : 0;
  const indoor = roof === 'dome' || roof === 'closed'; const w = !indoor && wind != null && Number.isFinite(+wind) ? Math.max(0, +wind - 10) / 10 : 0;
  return [h, r, w]; }
// rows: [{ y: points, x: [h, r, w] }]; ridge k per coefficient (in points-games units)
export function fitContext(rows, { k = [400, 400, 200], iters = 25 } = {}) {
  const n = rows.length; if (n < 200) return { version: CTX_VERSION, n, coef: [0, 0, 0], fitted: false };
  let a = Math.log(rows.reduce((s, r) => s + r.y, 0) / n); const b = [0, 0, 0];
  for (let it = 0; it < iters; it++) { // Newton on [a, b] with ridge on b only (diagonal Hessian approx per coordinate)
    let ga = 0, ha = 0; const g = [0, 0, 0], h = [0, 0, 0];
    for (const r of rows) { const mu = Math.exp(a + b[0] * r.x[0] + b[1] * r.x[1] + b[2] * r.x[2]); const e = r.y - mu; ga += e; ha += mu; for (let j = 0; j < 3; j++) { g[j] += e * r.x[j]; h[j] += mu * r.x[j] * r.x[j]; } }
    a += ga / ha; for (let j = 0; j < 3; j++) b[j] += (g[j] - k[j] * b[j]) / (h[j] + k[j]); }
  return { version: CTX_VERSION, n, coef: b.map(v => +v.toFixed(4)), base: +Math.exp(a).toFixed(2), fitted: true }; }
// games: nflverse games.csv rows (objects); seasons: which seasons to fit on (all must be before the simulated one)
export function contextRows(games, seasons) { const out = []; const S = new Set(seasons);
  for (const o of games) { if (!S.has(+o.season) || o.game_type !== 'REG' || o.away_score === '' || o.home_score === '') continue; const neutral = o.location === 'Neutral';
    const base = { neutral, roof: o.roof, wind: o.wind === '' || o.wind === 'NA' ? null : +o.wind };
    out.push({ y: +o.home_score, x: ctxFeatures({ ...base, side: 'home', restOwn: +o.home_rest, restOpp: +o.away_rest }) });
    out.push({ y: +o.away_score, x: ctxFeatures({ ...base, side: 'away', restOwn: +o.away_rest, restOpp: +o.home_rest }) }); }
  return out; }
// log multiplier on scoring for one side
export const ctxLog = (fit, x) => fit?.coef ? fit.coef[0] * x[0] + fit.coef[1] * x[1] + fit.coef[2] * x[2] : 0;
// scale a drive-result row's TD and FG/MFG chances by exp(d) (capped +-15%), the rest renormalised (RESULTS order TD, FG, MFG, ...)
export function shiftMix(row, d) { const m = clamp(Math.exp(d), 0.85, 1.15); if (m === 1) return row; const p = row.slice(); const sc = p[0] + p[1] + p[2]; const nsc = clamp(sc * m, 0, 0.95);
  const f = sc > 0 ? nsc / sc : 1, g = 1 - sc > 0 ? (1 - nsc) / (1 - sc) : 1; return p.map((v, i) => i <= 2 ? v * f : v * g); }
