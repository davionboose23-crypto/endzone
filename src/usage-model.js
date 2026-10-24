// Usage model leg (endzone-4.6): a cloglog GLM on nflverse PRE-GAME usage only (EB-shrunk, recency-weighted
// shares of carries / inside-5 / inside-10 / targets / end-zone targets / red-zone air yards, QB designed runs
// and sneaks, snap share and trend, TD history, opponent TDs allowed by position, pace) plus the game lines.
// It never sees our model's output, in-game info, inactives posted after the forecast, or weather.
// Built weekly by scripts/usage/build.mjs (GitHub Actions), shipped as archive/usage/<season>/w<week>.json.
// This file is the browser-safe part: the shipped table -> per-player probability, and the 3-way blend.
export const USAGE_FEATURES = ['def_pos', 'home', 'implied', 'isQB', 'isRB', 'isTE', 'l_c10', 'l_c5', 'l_ezt', 'l_pace', 'l_rzay', 'l_t10', 'qb_dr', 'qb_dr5', 'qb_sneak', 'snap', 'snap_trend', 'spread', 'tdh', 'l_t', 'l_c'];
export const LINE_FEATURES = ['implied', 'spread', 'home'];
export const BLEND_KIND = 'blend3';
export const BLEND_CEILING = 0.62; // spec hard ceiling (FIXED_CAPS.fin); the blend itself is applied after the safety caps
const EPS = 1e-4;
export const cll = e => 1 - Math.exp(-Math.exp(Math.max(-12, Math.min(3, e))));
export const eta = p => Math.log(-Math.log(1 - Math.min(0.999, Math.max(EPS, p))));

// Shipped table -> lookup. Players keyed by gsis; bySleeper maps Sleeper id -> gsis.
export function usageLookup(U) {
  if (!U?.players || !U?.lineCoef) return null;
  return (p, { implied = null, spread = null, home = false } = {}) => {
    const g = p.gsis && U.players[p.gsis] ? p.gsis : (U.bySleeper?.[p.id] || null);
    const row = g ? U.players[g] : null; if (!row) return null;
    const x = { implied, spread, home: home ? 1 : 0 }; let e = row[1];
    for (const k of LINE_FEATURES) { const c = U.lineCoef[k]; if (!c) continue; const v = Number.isFinite(x[k]) ? x[k] : c.mu; e += c.b * (v - c.mu) / (c.sd || 1); }
    return cll(e);
  };
}

// Equal-weight blend of log-intensity (cloglog) across the legs that exist for this player.
// Model always; Sleeper's published probability when present; the usage model when the player is in the table.
// Fallbacks: no usage -> 50/50 model + Sleeper; no Sleeper -> model + usage (or the model alone).
export function blendProbability({ chance, published = null, usage = null }) {
  if (!(chance > 0)) return null;
  const legs = [['model', chance]]; if (published > 0) legs.push(['sleeper', published]); if (usage > 0) legs.push(['usage', usage]);
  const p = cll(legs.reduce((a, [, v]) => a + eta(v), 0) / legs.length);
  return { p: Math.min(BLEND_CEILING, p), legs: legs.map(l => l[0]), usage: usage ?? null };
}
const pubProb = p => (p.published && typeof p.published === 'object' ? p.published.probability : (typeof p.published === 'number' ? p.published : null));
// Engine challenger: called with the player's FINAL (post-safety-cap, post-budget) chance.
export function blendChallenger(U) {
  const look = usageLookup(U);
  const fn = (p, ctx = {}) => blendProbability({ chance: p.chance, published: pubProb(p), usage: look ? look(p, ctx) : null });
  fn.kind = BLEND_KIND; fn.noBudget = true; return fn;
}

// Challenger status object shared by the server, the auto-run, the Pages export and the browser.
export function blendStatus(U, { season = null, week = null } = {}) {
  const usage = U?.players ? { season: U.season, week: U.week, trainedOn: U.trainedOn || null, trainRows: U.trainRows || null, players: Object.keys(U.players).length, builtAt: U.builtAt || null, version: U.version || 1 } : null;
  return { kind: BLEND_KIND, status: BLEND_KIND, fit: null, usage, cutoff: { season, week, rule: 'usage leg fit on player-games strictly before the target week; blend uses the final (post-cap) model chance and Sleeper as published' },
    reason: usage ? null : 'No usage table for this week: challenger = 50/50 model + Sleeper (model alone when Sleeper has no number).' };
}
// Team-perspective lines from a snapshot's game lines.
export function sideLines(lines, isHome) {
  if (!lines) return { implied: null, spread: null };
  return { implied: isHome ? lines.homeImplied ?? null : lines.awayImplied ?? null, spread: isHome ? lines.homeSpread ?? null : lines.awaySpread ?? null };
}

// ---- Monitoring: model vs challenger vs Sleeper on the slices where the model lost to Sleeper (research, Oct 2026).
const clp = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
const ll = (p, y) => -(y ? Math.log(clp(p)) : Math.log(1 - clp(p)));
export const RUNNING_QB_CARRIES = 3.5; // projected carries per game (incl. scrambles) that marks a running QB
export const MONITOR_SLICES = [
  ['all', 'All players', () => true],
  ['implied275', 'Implied team total 27.5+', r => r.implied >= 27.5],
  ['fav7', 'Favored by 7+', r => r.spread != null && r.spread <= -7],
  ['gl1535', 'Goal-line share 15–35%', r => r.glShare >= 0.15 && r.glShare <= 0.35],
  ['te1', 'TE1s', r => r.role === 'TE1'],
  ['runQb', `Running QBs (${RUNNING_QB_CARRIES}+ projected carries)`, r => r.pos === 'QB' && (r.vol?.carries ?? r.carries ?? 0) >= RUNNING_QB_CARRIES],
];
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
// Paired challenger-minus-other difference (x1000), resampling whole games (95% interval).
function pairedGames(R, a, b, B = 400) {
  const G = new Map(); for (const r of R) { const g = G.get(r.gameId) || { n: 0, db: 0, dl: 0 }; g.n++; g.db += (r[a] - r.y) ** 2 - (r[b] - r.y) ** 2; g.dl += ll(r[a], r.y) - ll(r[b], r.y); G.set(r.gameId, g); }
  const gs = [...G.values()]; const n = gs.reduce((s, g) => s + g.n, 0); if (!n) return null;
  const R1 = rng(7); const bs = [], ls = [];
  for (let i = 0; i < B; i++) { let m = 0, db = 0, dl = 0; for (let j = 0; j < gs.length; j++) { const g = gs[(R1() * gs.length) | 0]; m += g.n; db += g.db; dl += g.dl; } bs.push(db / m); ls.push(dl / m); }
  const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
  const k = x => Math.round(x * 1e5) / 100;
  return { dBrier: k(gs.reduce((s, g) => s + g.db, 0) / n), dBrierCI: [k(q(bs, .025)), k(q(bs, .975))], dLogLoss: k(gs.reduce((s, g) => s + g.dl, 0) / n), dLogLossCI: [k(q(ls, .025)), k(q(ls, .975))] };
}
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);
function scoreSet(R) {
  const one = k => ({ brier: r4(R.reduce((s, r) => s + (r[k] - r.y) ** 2, 0) / R.length), logLoss: r4(R.reduce((s, r) => s + ll(r[k], r.y), 0) / R.length), mean: r4(R.reduce((s, r) => s + r[k], 0) / R.length) });
  return { n: R.length, games: new Set(R.map(r => r.gameId)).size, actual: r4(R.reduce((s, r) => s + r.y, 0) / R.length), model: one('chance'), challenger: one('challenger'), sleeper: one('published'),
    vsModel: pairedGames(R, 'challenger', 'chance'), vsSleeper: pairedGames(R, 'challenger', 'published') };
}
export const TE_GAP_PTS = 2; // flag when the blended TE1 forecast is still >= 2 points under the actual TE1 rate
// rows: graded {chance, challenger, published, y, gameId, pos, role, glShare, implied, spread, vol}; only rows with all three numbers count.
export function monitorReport(rows, { label = '', minTe = 60 } = {}) {
  const R = rows.filter(r => r.chance > 0 && r.challenger > 0 && r.published > 0 && (r.y === 0 || r.y === 1));
  const slices = {};
  for (const [id, name, f] of MONITOR_SLICES) { const S = R.filter(f); slices[id] = S.length ? { name, ...scoreSet(S) } : { name, n: 0 }; }
  const te = slices.te1; let teGap = { flagged: false, reason: 'no TE1 rows yet' };
  if (te.n) {
    const gapModel = r4((te.model.mean - te.actual) * 100), gapBlend = r4((te.challenger.mean - te.actual) * 100);
    const persists = gapBlend <= -TE_GAP_PTS && gapBlend <= gapModel / 2;
    teGap = { flagged: persists, provisional: te.n < minTe, n: te.n, gapModelPts: gapModel, gapBlendPts: gapBlend, gapSleeperPts: r4((te.sleeper.mean - te.actual) * 100),
      reason: persists ? `TE gap persists after the blend: TE1 forecast ${gapBlend} pts vs actual (model ${gapModel})${te.n < minTe ? ` — provisional, n=${te.n}` : ''}` : `TE1 gap closed or small: blend ${gapBlend} pts vs actual (model ${gapModel})` };
  }
  return { label, n: R.length, slices, teGap };
}
