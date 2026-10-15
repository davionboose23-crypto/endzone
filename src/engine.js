// Engine entry shared by the Web Worker and the server job: identity -> forecasts -> slate.
import { buildIndex } from './stats-index.js';
import { buildIdentity } from './roster.js';
import { forecastWeek, compactPrediction } from './pipeline.js';
import { weeklyPick, bestRiser, compareDefault } from './ranking.js';
import { MODEL_VERSION } from './model.js';

export function identityFor(ix, prep) {
  const recentByGsis = new Map(), recentBySleeper = new Map();
  for (const [g, rows] of ix.logsByGsis) recentByGsis.set(g, rows.filter(r => r.season === prep.season).map(r => ({ week: r.week, team: r.team })));
  for (const [w, wk] of Object.entries(ix.weekly)) for (const id of Object.keys(wk.stats || {})) { if (!recentBySleeper.has(id)) recentBySleeper.set(id, []); }
  // Sleeper-only participation (player's current team for that week's stats)
  const teamOf = new Map(prep.players.map(p => [p.id, p.team]));
  for (const [w, wk] of Object.entries(ix.weekly)) for (const [id, s] of Object.entries(wk.stats || {})) if ((s.rush_att || 0) + (s.rec_tgt || 0) + (s.pass_att || 0) > 0 || s.off_snp) recentBySleeper.get(id).push({ week: +w, team: teamOf.get(id) });
  return buildIdentity({ players: prep.players, roster: prep.roster, idmap: prep.idmap, recentByGsis, recentBySleeper, currentWeek: prep.currentWeek });
}

export function runEngine(prep, { weights, lessons = null, lessonsUnplayed = null, now = Date.now(), week = prep.week, errorModel = null, coverage = null, challenger = null, ix = null, identity = null, pubTdBlend } = {}) {
  ix = ix || buildIndex(prep);
  identity = identity || identityFor(ix, prep);
  const fw = forecastWeek(ix, identity, { season: prep.season, week, weights, lessons, lessonsUnplayed, now, errorModel, coverage, pubTdBlend });
  const games = fw.games.map(G => {
    const sides = {};
    for (const s of ['away', 'home']) {
      const S = G.sides[s];
      const players = S.players.slice().sort(compareDefault);
      if (challenger) {
        for (const p of players) p.challenger = challenger(p);
        // reapply the shared team scoring budget to the shadow probabilities
        const lam = players.reduce((a, p) => a + (p.challenger != null ? -Math.log(1 - Math.min(0.999, p.challenger)) : 0), 0);
        if (lam > S.tdBudget && lam > 0) for (const p of players) if (p.challenger != null) p.challenger = 1 - Math.exp(Math.log(1 - Math.min(0.999, p.challenger)) * S.tdBudget / lam);
      }
      sides[s] = { ...S, players: players.map(p => compactPrediction(p, s)).sort(compareDefault), raw: players, budget: { ...S.budget } };
    }
    return { ...G, sides };
  });
  const all = games.flatMap(g => ['away', 'home'].flatMap(s => g.sides[s].raw));
  const pick = weeklyPick(all), riser = bestRiser(all);
  return { ix, identity, W: fw.W, games, weeklyPickId: pick?.id || null, riserId: riser?.id || null, modelVersion: MODEL_VERSION, weights: fw.weights };
}
