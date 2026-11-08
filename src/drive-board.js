// Board-only display estimates. Never written back to a slate player or the engine.
import { firstDriveForecast, prepareFirstDriveContext } from './first-drive.js';
export const DRIVE_CONFIDENCE_RULE = 'Outcome-relative research tiers, not probability guarantees. For 5+ rushing/receiving yards, High requires 5+ recorded games, 3+ hits, and a central 90% Beta(hits+1, misses+1) interval lower bound above the 2026 same-position first-drive base rate by 10 percentage points (rush) or 5 points (receiving), with a forecast also above that threshold, plus opportunity involvement ≥60%, ≥0.75 targets/carries per first drive, ≥18% team target/carry share and ≥40% touch rate. A genuine recent/prior three-game shift subtracts at most 3 points from the lower bound. No quota and no automatic top-N promotions. High means stronger positive evidence relative to this outcome/position, NOT a 75% chance or a narrowly estimated absolute rate. Medium: 4+ games, an adjusted 90% interval width ≤75 points, ≥35% opportunity involvement, and ≥0.4 opportunities/drive or ≥12% volume share. Otherwise Low. Touch keeps the absolute-width High rule: 6+ games, 2+ hits, width ≤40 points and strong involvement. TD keeps stricter 10-game/3-hit High and 6-game/1-hit Medium minimums, with offense/defense samples ≥7/4 respectively. Receiving uses targets; rushing uses carries. Genuine shifts require non-overlapping 80% ranges and only mildly widen uncertainty. No first-drive route/snap data are available. Tiers are exploratory and outcome-specific, not calibrated anytime-model confidence.';
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
  const absoluteHigh = n >= (td ? 10 : 6) && hits >= (td ? 3 : 2) && adjustedWidth <= .40 && strongRole && (!td || (F.offense.n >= 7 && F.defense.n >= 7));
  const relative = metric === 'rush5' || metric === 'rec5';
  const baseline = relative ? F.yardage?.outcomes?.find(o => o.key === metric)?.prior : null;
  const requiredEdge = metric === 'rush5' ? .10 : .05;
  const relativeLower = Math.max(0, interval.lo - (genuineShift ? .03 * shift : 0));
  const relativeHigh = n >= 5 && hits >= 3 && strongRole && Number.isFinite(baseline) && probability >= baseline + requiredEdge && relativeLower >= baseline + requiredEdge;
  const high = relative ? relativeHigh : absoluteHigh;
  const medium = n >= (td ? 6 : 4) && adjustedWidth <= .75 && supported && (!td || (hits >= 1 && F.offense.n >= 4 && F.defense.n >= 4));
  return { level: high ? 'High' : medium ? 'Med' : 'Low', games: n, hits, shift, genuineShift, shrinkage, interval, adjustedWidth, volume, basis: relative ? 'outcome-relative' : 'absolute-width', baseline, relativeLower, requiredEdge: relative ? requiredEdge : null };
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
