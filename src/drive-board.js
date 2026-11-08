// Board-only display estimates. Never written back to a slate player or the engine.
import { firstDriveForecast, prepareFirstDriveContext } from './first-drive.js';
export const DRIVE_CONFIDENCE_RULE = 'Estimate reliability, not event likelihood. Every interval is the central 90% Beta(hits+1, misses+1) posterior range. High: 6+ recorded games, 2+ hits, adjusted interval width ≤40 percentage points, opportunity involvement in ≥60% of first drives, ≥0.75 opportunities/drive, ≥18% share of the team volume, and ≥40% touch rate. Medium: 4+ games, interval width ≤75 points, ≥35% opportunity involvement, and ≥0.4 opportunities/drive or ≥12% volume share. Otherwise Low. Receiving uses targets/team targets; rushing uses carries/team carries; touch/TD use targets+carries/team opportunities. Genuine recent/prior three-game shifts (non-overlapping 80% ranges) add at most 3 points to interval width, not a hard veto; The range is widened to include the forecast if it lies outside the posterior interval. TD additionally requires 10+ games/3+ hits and offense/defense samples ≥7 for High, or 6+ games/1+ hit and samples ≥4 for Medium. Zero/one-hit long shots cannot earn High just because a near-zero interval is narrow. No first-drive route/snap data are available here. Research tiers, not validated or calibrated model-confidence grades.';
const cache = new WeakMap();
const intervals = new Map();
const rate = (a, hit) => a.reduce((s, g) => s + +hit(g), 0) / a.length;
// For integer a,b, I_x(a,b) is a finite binomial tail. With the explicit
// uniform Beta(1,1) prior, a=hits+1,b=misses+1, so no special-function dependency.
export function drivePosteriorInterval(hits, n, coverage = .9) {
  const key = `${hits}/${n}/${coverage}`; if (intervals.has(key)) return intervals.get(key);
  const a = hits + 1, m = n + 1;
  const cdf = x => {
    let total = 0, choose = 1;
    for (let j = 0; j <= m; j++) {
      if (j >= a) total += choose * x ** j * (1 - x) ** (m - j);
      choose *= (m - j) / (j + 1);
    }
    return total;
  };
  const quantile = q => { let lo = 0, hi = 1; for (let i = 0; i < 45; i++) { const mid = (lo + hi) / 2; if (cdf(mid) < q) lo = mid; else hi = mid; } return (lo + hi) / 2; };
  const tail = (1 - coverage) / 2, lo = quantile(tail), hi = quantile(1 - tail);
  const result = { lo, hi, width: hi - lo, coverage };
  intervals.set(key, result); return result;
}
function volumeSupport(F, metric) {
  const games = F.games, n = games.length;
  const receiving = metric === 'rec5', rushing = metric === 'rush5';
  const playerOpp = g => receiving ? g.targets : rushing ? g.carries : g.targets + g.carries;
  const teamOpp = g => receiving ? g.teamTargets : rushing ? g.opportunities - g.teamTargets : g.opportunities;
  const opportunities = games.reduce((s, g) => s + playerOpp(g), 0);
  const teamVolume = games.reduce((s, g) => s + teamOpp(g), 0);
  return { involvement: games.filter(g => playerOpp(g) > 0).length / n,
    perDrive: opportunities / n, share: teamVolume > 0 ? opportunities / teamVolume : 0,
    touchRate: games.filter(g => g.touches > 0).length / n };
}
export function driveEstimateConfidence(F, hit, probability, td = false, metric = 'touch') {
  const games = F.games, n = games.length;
  if (!n || !Number.isFinite(probability)) return { level: 'Low', games: n, hits: 0, shift: 0, shrinkage: 0, interval: drivePosteriorInterval(0, 0), adjustedWidth: 1, volume: { involvement: 0, perDrive: 0, share: 0, touchRate: 0 } };
  const hits = games.reduce((s, g) => s + +hit(g), 0), interval = drivePosteriorInterval(hits, n);
  const recent = games.slice(-3), previous = games.slice(-6, -3);
  const shift = previous.length ? Math.abs(rate(recent, hit) - rate(previous, hit)) : 0;
  let genuineShift = false;
  if (recent.length === 3 && previous.length === 3) {
    const R = drivePosteriorInterval(recent.filter(hit).length, 3, .8), P = drivePosteriorInterval(previous.filter(hit).length, 3, .8);
    genuineShift = R.lo > P.hi || P.lo > R.hi;
  }
  const shrinkage = Math.abs(probability - hits / n);
  const adjustedWidth = Math.max(interval.hi, probability) - Math.min(interval.lo, probability) + (genuineShift ? .03 * shift : 0);
  const volume = volumeSupport(F, metric);
  const supported = volume.involvement >= .35 && (volume.perDrive >= .4 || volume.share >= .12);
  const strongRole = volume.involvement >= .6 && volume.perDrive >= .75 && volume.share >= .18 && volume.touchRate >= .4;
  const high = n >= (td ? 10 : 6) && hits >= (td ? 3 : 2) && adjustedWidth <= .40 && strongRole && (!td || (F.offense.n >= 7 && F.defense.n >= 7));
  const medium = n >= (td ? 6 : 4) && adjustedWidth <= .75 && supported && (!td || (hits >= 1 && F.offense.n >= 4 && F.defense.n >= 4));
  return { level: high ? 'High' : medium ? 'Med' : 'Low', games: n, hits, shift, genuineShift, shrinkage, interval, adjustedWidth, volume };
}
export function attachDrivePatterns(D, players) {
  if (D?.season !== 2026 || !D.teams) return players.map(p => ({ ...p, drivePatterns: {} }));
  // Slate drive files are replaced (not mutated) on refresh. Key by their object
  // identity so changing weeks/data invalidates both context and player estimates.
  let C = cache.get(D);
  if (!C) { C = { context: prepareFirstDriveContext(D), players: new Map() }; cache.set(D, C); }
  return players.map(p => {
    const key = JSON.stringify([p.gsis, p.id, p.team, p.opp, p.pos]);
    if (!C.players.has(key)) {
      const F = firstDriveForecast(D, p, p.opp, C.context);
      const metrics = {};
      if (F?.games.length) {
        const add = (key, probability, hit, td = false) => {
          metrics[key] = { probability, confidence: driveEstimateConfidence(F, hit, probability, td, key) };
        };
        add('touch', F.prediction.touch, g => g.touches > 0);
        add('rush5', F.yardage.outcomes.find(o => o.key === 'rush5').probability, g => g.rushYards >= 5);
        add('rec5', F.yardage.outcomes.find(o => o.key === 'rec5').probability, g => g.recYards >= 5);
        add('td', F.prediction.playerTd, g => g.playerTd > 0, true);
      }
      C.players.set(key, metrics);
    }
    return { ...p, drivePatterns: C.players.get(key) };
  });
}
