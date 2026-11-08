// Board-only display estimates. Never written back to a slate player or the engine.
import { firstDriveForecast, prepareFirstDriveContext } from './first-drive.js';
export const DRIVE_CONFIDENCE_RULE = 'High: 7+ recorded games, 2+ hits, last-three vs prior-three hit rates within 25 percentage points, and estimate within 10 points of the raw rate. Medium: 4+ games, 1+ hit, recent vs prior rates within 50 points, and estimate within 20 points. Otherwise Low. TDs additionally need 10+ games / 3+ hits for High or 6+ games / 1+ hit for Medium, plus offense and opponent samples of 7+ / 4+ opening drives respectively. Confidence measures support for the estimate, not the chance of the event; it is exploratory, not validated model confidence.';
const cache = new WeakMap();
const rate = (a, hit) => a.reduce((s, g) => s + +hit(g), 0) / a.length;
export function driveEstimateConfidence(F, hit, probability, td = false) {
  const games = F.games, n = games.length;
  if (!n || !Number.isFinite(probability)) return { level: 'Low', games: n, hits: 0, shift: 1, shrinkage: 1 };
  const hits = games.reduce((s, g) => s + +hit(g), 0);
  const recent = games.slice(-3), previous = games.slice(-6, -3);
  const shift = previous.length ? Math.abs(rate(recent, hit) - rate(previous, hit)) : 1;
  const shrinkage = Math.abs(probability - hits / n);
  const high = n >= (td ? 10 : 7) && hits >= (td ? 3 : 2) && previous.length === 3 && shift <= .25 && shrinkage <= .10 && (!td || (F.offense.n >= 7 && F.defense.n >= 7));
  const medium = n >= (td ? 6 : 4) && hits >= 1 && previous.length >= 1 && shift <= .50 && shrinkage <= .20 && (!td || (F.offense.n >= 4 && F.defense.n >= 4));
  return { level: high ? 'High' : medium ? 'Med' : 'Low', games: n, hits, shift, shrinkage };
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
          metrics[key] = { probability, confidence: driveEstimateConfidence(F, hit, probability, td) };
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
