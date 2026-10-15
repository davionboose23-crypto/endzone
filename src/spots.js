// Yard-line spot conversion engine: disjoint bins 1-5, 6-10, 11-20 (+ outside 20).
import { clamp } from './model.js';
export const BINS = [1, 2, 3];
export const BIN_LABEL = { 1: 'Inside the 5', 2: 'Inside the 10', 3: 'Inside the 20' };
export const BIN_SUB = { 1: 'yards 1–5', 2: 'yards 6–10', 3: 'yards 11–20' };
export const FALLBACK = { r: { 1: 0.48, 2: 0.34, 3: 0.01 }, t: { 1: 0.55, 2: 0.48, 3: 0.07 } };
export const NEIGH = { r: { 1: [0.22, 0.65], 2: [0.27, 0.49], 3: [0.003, 0.035] }, t: { 1: [0.24, 0.70], 2: [0.37, 0.64], 3: [0.045, 0.13] } };
export const FALLBACK_OUTSIDE = { r: 0.009, t: 0.02 };
export const FALLBACK_BINMIX = { r: { 1: 0.33, 2: 0.24, 3: 0.43 }, t: { 1: 0.22, 2: 0.22, 3: 0.56 } };
export const INSIDE20_SHARE = { r: 0.72, t: 0.62 }; // fallback context only
export const binOf = yl => (yl <= 5 ? 1 : yl <= 10 ? 2 : yl <= 20 ? 3 : 0);

// League conversion priors from current-season zone rows before the cutoff.
export function leagueRates(teamZoneRowsAll) {
  const agg = { r: {}, t: {} }; const yl = { r: {}, t: {} };
  for (const p of ['r', 't']) for (const b of [0, 1, 2, 3]) { agg[p][b] = { looks: 0, scores: 0, charted: 0, catchable: 0, endzone: 0, sumYl: 0, sumYtg: 0 }; }
  for (const z of teamZoneRowsAll) {
    if (z.path !== 'r' && z.path !== 't') continue;
    const a = agg[z.path][z.bin]; a.looks += z.looks; a.scores += z.scores; a.charted += z.charted; a.catchable += z.catchable; a.endzone += z.endzone; a.sumYl += z.sumYl; a.sumYtg += (z.sumYtg || 0);
  }
  const rates = { r: {}, t: {} }, outside = {}, binMix = { r: {}, t: {} }, source = {}, avgYl = { r: {}, t: {} }, avgYtg = { r: {}, t: {} }, catchRate = {}, endzoneRate = {};
  for (const p of ['r', 't']) {
    let rz = 0; for (const b of BINS) rz += agg[p][b].looks;
    for (const b of BINS) {
      const a = agg[p][b]; const fb = FALLBACK[p][b];
      let r = a.looks >= 150 ? (a.scores + 100 * fb) / (a.looks + 100) : fb;
      if (b === 2) r *= 1.06;           // 6-10 upward prior correction
      if (b === 3 && p === 'r') r *= 0.7; // crush 11-20 rushing conversion only
      rates[p][b] = clamp(r, ...NEIGH[p][b]);
      binMix[p][b] = rz >= 200 ? (a.looks + 50 * FALLBACK_BINMIX[p][b]) / (rz + 50) : FALLBACK_BINMIX[p][b];
      avgYtg[p][b] = a.looks && a.sumYtg ? a.sumYtg / a.looks : null;
      avgYl[p][b] = a.looks ? a.sumYl / a.looks : (b === 1 ? 3 : b === 2 ? 8 : 15.5);
      source[`${p}${b}`] = a.looks >= 150 ? `league ${a.scores}/${a.looks} this season, shrunk to prior` : 'labeled fallback prior';
    }
    const o = agg[p][0];
    outside[p] = o.looks >= 500 ? clamp(o.scores / o.looks, FALLBACK_OUTSIDE[p] * 0.4, FALLBACK_OUTSIDE[p] * 2.5) : FALLBACK_OUTSIDE[p];
    source[`${p}0`] = o.looks >= 500 ? `league ${o.scores}/${o.looks} outside the 20` : 'labeled fallback prior';
    const ch = BINS.reduce((s, b) => s + agg[p][b].charted, 0); const cc = BINS.reduce((s, b) => s + agg[p][b].catchable, 0);
    catchRate[p] = ch >= 100 ? cc / ch : null;
    endzoneRate[p] = rz ? BINS.reduce((s, b) => s + agg[p][b].endzone, 0) / rz : null;
  }
  return { rates, outside, binMix, source, avgYl, avgYtg, catchRate, endzoneRate, agg };
}

// Beta posterior for one spot: prior strength k around the league prior mean.
export function betaPosterior(looks, scores, prior, k) {
  const a = scores + k * prior, b = (looks - scores) + k * (1 - prior);
  const mean = a / (a + b);
  const sd = Math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)));
  return { a, b, mean, sd, lo: Math.max(0, mean - 1.2816 * sd), hi: Math.min(1, mean + 1.2816 * sd) };
}

/**
 * Safeguarded conversion rate for a player's spot.
 * ev: { looks, scores, recentLooks, recentScores, hot, spike, quality }
 */
export function spotRate(path, bin, ev, league) {
  const prior = league.rates[path][bin];
  const k = ev.hot ? 4 : 10;
  const scores = ev.spike ? ev.scores * 0.72 : ev.scores;
  const post = betaPosterior(ev.looks, Math.min(scores, ev.looks), prior, k);
  const [lo, hi] = NEIGH[path][bin];
  let rate = clamp(post.mean, lo, hi);
  const notes = [];
  let q = 1;
  if (ev.quality) { q = clamp(ev.quality, 0.92, 1.08); rate = clamp(rate * q, lo, hi); }
  let cold = false;
  if (bin === 1 && ((ev.looks >= 4 && ev.scores === 0) || (ev.recentLooks >= 3 && ev.recentScores / ev.recentLooks < 0.2))) {
    cold = true; rate = Math.min(rate * 0.75, path === 'r' ? 0.32 : 0.34);
    notes.push('He has the looks inside the 5 and has not scored on them, so that rate comes down.');
  }
  return { prior, k, posterior: post, rate, cold, quality: q, notes };
}

// Outside-20 conversion: heavy shrinkage; recurring outside scores across games earn trust.
export function outsideRate(path, looks, scores, scoringGames, league) {
  const base = league.outside[path];
  const K = (path === 'r' ? 150 : 100) * (scoringGames >= 2 ? 0.5 : 1);
  const r = (scores + K * base) / (looks + K);
  return { rate: clamp(r, base * 0.5, base * 2.5), K, recurring: scoringGames >= 2, base };
}

// Bounded play-quality multiplier from real measurements only.
export function qualityFactor(path, bin, z, league, charting) {
  if (!z || !z.looks) return { factor: 1, parts: [] };
  const parts = []; let f = 1;
  const avg = z.sumYl / z.looks, lavg = league.avgYl[path][bin]; const width = bin === 1 ? 5 : bin === 2 ? 5 : 10;
  const w = z.looks / (z.looks + 10);
  const yl = clamp((lavg - avg) / width * 0.12, -0.05, 0.05) * w; f *= 1 + yl; parts.push(`avg yard line ${avg.toFixed(1)} vs league ${lavg.toFixed(1)}`);
  // Distance to gain: shorter-than-league distance at the same spot (more goal-to-go/short-yardage) nudges up, bounded ±2%.
  const lytg = league.avgYtg?.[path]?.[bin];
  if (lytg && z.sumYtg) { const ytg = z.sumYtg / z.looks; const d = clamp((lytg - ytg) / Math.max(lytg, 1) * 0.04, -0.02, 0.02) * w; f *= 1 + d; parts.push(`avg distance to gain ${ytg.toFixed(1)} vs league ${lytg.toFixed(1)}`); }
  if (path === 't') {
    if (league.endzoneRate.t != null) { const ez = z.endzone / z.looks; const d = clamp((ez - league.endzoneRate.t) * 0.1, -0.03, 0.03) * w; f *= 1 + d; parts.push(`end-zone target share ${(ez * 100).toFixed(0)}%`); }
    if (charting && z.charted >= 3 && league.catchRate.t != null) { const cr = z.catchable / z.charted; const d = clamp((cr - league.catchRate.t) * 0.1, -0.03, 0.03) * (z.charted / (z.charted + 10)); f *= 1 + d; parts.push(`catchable ${z.catchable}/${z.charted}, contested ${z.contested}`); }
  }
  if (path === 'r' && bin === 1 && charting && z.sneaks > 0) { const d = clamp(z.sneaks / z.looks * 0.06, 0, 0.04); f *= 1 + d; parts.push(`${z.sneaks} QB sneaks`); }
  return { factor: clamp(f, 0.92, 1.08), parts };
}

// Yard-line-specific defense allowance: this defense's TD rate in one spot vs league in that spot,
// shrunk hard (k=60 looks of league rate) and bounded 0.94-1.06 because the position softness
// factor already carries some of the same signal. Neutral (1) with no sample.
export function defenseSpotFactor(dz, lz, opp, path, bin, k = 60) {
  const db = dz?.get?.(opp)?.[path]?.bins?.[bin], lb = lz?.[path]?.bins?.[bin];
  const leagueRate = lb && lb.looks ? lb.scores / lb.looks : null;
  if (!db || !db.looks || !leagueRate) return { factor: 1, looks: db?.looks || 0, scores: db?.scores || 0, leagueRate };
  const shr = (db.scores + k * leagueRate) / (db.looks + k);
  return { factor: clamp(shr / leagueRate, 0.94, 1.06), looks: db.looks, scores: db.scores, leagueRate };
}
