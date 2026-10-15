// Core touchdown model math: one Poisson intensity per player, distribution,
// first-TD share, display transforms, safety calibration, and coherent scaling.
export const MODEL_VERSION = 'endzone-4.2.0';
export const DEFAULT_WEIGHTS = Object.freeze({ recentBlend: 0.40, publishedBlend: 0.35, script: 1, redZone: 1, shrinkGames: 3, tePremium: 1, goalLine: 1.12, defenseTrust: 1 });
export const WEIGHT_RANGES = { recentBlend: [0, 0.8], publishedBlend: [0, 0.7], script: [0, 1.5], redZone: [0.5, 1.5], shrinkGames: [1, 8], tePremium: [0.7, 1.3], goalLine: [0.8, 1.4], defenseTrust: [0, 1.5] };
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export function sanitizeWeights(w = {}) {
  const out = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(DEFAULT_WEIGHTS)) if (Number.isFinite(+w[k])) out[k] = clamp(+w[k], ...WEIGHT_RANGES[k]);
  return out;
}

export function distribution(lambda) {
  const l = Math.max(0, Number.isFinite(lambda) ? lambda : 0);
  const e = Math.exp(-l);
  const p0 = e, p1 = l * e, p2 = l * l * e / 2;
  const p3 = Math.max(0, 1 - p0 - p1 - p2);
  return { lambda: l, p0, p1, p2, p3plus: p3, anytime: 1 - p0, twoPlus: Math.max(0, 1 - p0 - p1) };
}
export const anytimeFromLambda = l => 1 - Math.exp(-Math.max(0, l));
export const lambdaFromChance = p => -Math.log(1 - clamp(p, 0, 0.999999));
export function firstTd(playerLambda, gameLambda) {
  if (!(gameLambda > 0) || !(playerLambda > 0)) return 0;
  return (1 - Math.exp(-gameLambda)) * playerLambda / gameLambda;
}
export function publishedProbability(expectedTd) {
  if (expectedTd == null || !Number.isFinite(+expectedTd)) return null;
  return 1 - Math.exp(-Math.max(0, +expectedTd));
}
export function edgePts(chance, published) { return published == null || chance == null ? null : (chance - published) * 100; }
export function americanFair(p) {
  if (!(p > 0) || !Number.isFinite(p)) return null;
  if (p >= 1) return null;
  if (p < 0.5) return Math.round(100 * (1 - p) / p);
  return -Math.round(100 * p / (1 - p));
}
export function fmtAmerican(p) { const v = americanFair(p); return v == null ? '—' : (v > 0 ? `+${v}` : `${v}`); }

// Poisson central 80% count interval (10th..90th percentile).
export function poissonInterval(lambda, lo = 0.1, hi = 0.9) {
  const l = Math.max(0, lambda); let k = 0, cdf = Math.exp(-l), pk = cdf, a = null;
  if (cdf >= lo) a = 0;
  while (cdf < hi && k < 60) { k++; pk = pk * l / k; cdf += pk; if (a == null && cdf >= lo) a = k; }
  return [a ?? 0, k];
}

// Scale every component of a player's intensity coherently by f.
export function scaleComponents(comp, f) {
  const out = {};
  for (const [k, v] of Object.entries(comp)) out[k] = typeof v === 'number' ? v * f : v;
  return out;
}
export const sumComponents = c => Object.values(c).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);

/**
 * Section 11 safety calibration on the anytime chance.
 * ctx: { insideFinisher, recentFinisher, coldGoal }
 */
export function safetyCalibrate(p, ctx) {
  const notes = []; let q = p;
  if (!ctx.insideFinisher && q >= 0.35 && q <= 0.50) { const n = 0.28 + 0.35 * (q - 0.28); notes.push(`A ${pct(q)} chance without an inside-10 finishing role is pulled toward 28% (now ${pct(n)}).`); q = n; }
  if (q > 0.50) {
    if (ctx.recentFinisher) { if (q > 0.62) { notes.push('Even a real recent finisher tops out at 62%.'); q = 0.62; } }
    else { const cap = ctx.coldGoal ? 0.46 : 0.50; if (q > cap) { notes.push(`Held near ${pct(cap)}: no recent inside-10 finishing run${ctx.coldGoal ? ' and his goal line is cold' : ''}.`); q = cap; } }
  }
  if (q > 0.62) { q = 0.62; notes.push('Ceiling 62%.'); }
  return { chance: q, notes, ceiling: ctx.recentFinisher ? 0.62 : (ctx.coldGoal ? 0.46 : 0.50) };
}
export function pct(x, d = 0) { return x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`; }

// ~80% band for the probability from log-intensity uncertainty.
export function chanceBand(lambda, sigmaLog) {
  const z = 1.2816; const s = Math.max(0.05, sigmaLog || 0);
  return [anytimeFromLambda(lambda * Math.exp(-z * s)), anytimeFromLambda(lambda * Math.exp(z * s))];
}
