// Advanced evidence: Beta conversion posteriors, workload trend, volatility,
// and an explicit register of advanced inputs that are NOT available.
import { BINS } from './spots.js';
export const UNAVAILABLE_INPUTS = ['Route participation', 'Coverage shells', 'Separation / tracking', 'Offensive-line grades', 'Pressure data'];
export function advancedEvidence(p, W) {
  const posterior = [];
  for (const path of ['r', 't']) for (const b of BINS) {
    const s = p.spots[`${path}${b}`];
    posterior.push({ path: path === 'r' ? 'Rush' : 'Target', bin: b, looks: s.looks, scores: s.scores, prior: s.prior, k: s.k, mean: s.posterior.mean, lo: s.posterior.lo, hi: s.posterior.hi, used: s.rate, cold: s.cold,
      note: s.cold ? 'Cold inside-5 safeguard applied after the posterior.' : (Math.abs(s.rate - s.posterior.mean) > 0.001 ? 'Bounded to the normal neighborhood / quality adjusted.' : '') + (s.defenseSpot && s.defenseSpot.factor !== 1 ? ` Opponent allows ${s.defenseSpot.scores}/${s.defenseSpot.looks} here (league ${(s.defenseSpot.leagueRate * 100).toFixed(1)}%): ×${s.defenseSpot.factor.toFixed(3)}.` : s.defenseSpot?.blocked ? ' Opponent spot lift withheld (no recent red-zone looks).' : '') });
  }
  const opp = p.f.last5.map(g => g.carries + g.targets);
  const m = opp.length ? opp.reduce((a, b) => a + b, 0) / opp.length : 0;
  const vol = opp.length >= 2 && m > 0 ? Math.sqrt(opp.reduce((a, b) => a + (b - m) ** 2, 0) / (opp.length - 1)) / m : null;
  const i10 = (p.components.r1 || 0) + (p.components.r2 || 0) + (p.components.t1 || 0) + (p.components.t2 || 0);
  return {
    posterior, coverage: { gamesThisSeason: p.f.n, zoneKnownGames: p.f.zoneKnownGames, zoneFeed: !!W.ix.prep.zones, charting: !!W.ix.prep.charting },
    trend: p.f.trend, inside10Fraction: p.lambda > 0 ? i10 / p.lambda : 0, volatility: vol, workload: { roleFactor: p.roleFactor, availability: p.avail.factor, replacing: p.replacing || null, inheritedShare: p.inheritedShare || 0 },
    sigmaLog: p.sigma, unavailable: UNAVAILABLE_INPUTS,
    playQuality: Object.fromEntries(Object.entries(p.spots).filter(([k, s]) => s.quality).map(([k, s]) => [k, { factor: s.quality.factor, parts: s.quality.parts }])),
  };
}
