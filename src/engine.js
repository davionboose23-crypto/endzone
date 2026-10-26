// Engine entry shared by the Web Worker and the server job: identity -> forecasts -> slate.
import { buildIndex } from './stats-index.js';
import { buildIdentity } from './roster.js';
import { forecastWeek, compactPrediction } from './pipeline.js';
import { weeklyPick, bestRiser, compareDefault } from './ranking.js';
import { MODEL_VERSION } from './model.js';

// asOfWeek: only participation from weeks before the forecast week counts (no future leakage in reconstruction).
export function identityFor(ix, prep, asOfWeek = null) {
  const cut = w => asOfWeek == null || w < asOfWeek;
  const recentByGsis = new Map(), recentBySleeper = new Map();
  for (const [g, rows] of ix.logsByGsis) recentByGsis.set(g, rows.filter(r => r.season === prep.season && cut(r.week)).map(r => ({ week: r.week, team: r.team })));
  for (const [w, wk] of Object.entries(ix.weekly)) for (const id of Object.keys(wk.stats || {})) { if (!recentBySleeper.has(id)) recentBySleeper.set(id, []); }
  // Sleeper-only participation (player's current team for that week's stats)
  const teamOf = new Map(prep.players.map(p => [p.id, p.team]));
  for (const [w, wk] of Object.entries(ix.weekly)) if (cut(+w)) for (const [id, s] of Object.entries(wk.stats || {})) if ((s.rush_att || 0) + (s.rec_tgt || 0) + (s.pass_att || 0) > 0 || s.off_snp) recentBySleeper.get(id).push({ week: +w, team: teamOf.get(id) });
  return buildIdentity({ players: prep.players, roster: prep.roster, idmap: prep.idmap, recentByGsis, recentBySleeper, currentWeek: asOfWeek != null ? Math.min(prep.currentWeek ?? 18, asOfWeek) : prep.currentWeek });
}

import { driveAdjustFor } from './drive-adjust.js';
export function runEngine(prep, { weights, lessons = null, lessonsUnplayed = null, now = Date.now(), week = prep.week, errorModel = null, coverage = null, challenger = null, ix = null, identity = null, pubTdBlend, stackFit, budgetFit, volCal, exp, caps, useChallenger = false, trendWeights, trendHistory, drives = null, useDrives = false } = {}) {
  // drive-pattern adjustment in the ACTIVE model only when the weekly gate enabled it (components.drives); weight = walk-forward model weight
  const dW = useDrives ? (drives?.fit?.weight?.model || 0) : 0;
  const driveAdjust = drives && dW > 0 ? (p, sc) => driveAdjustFor(drives, p, { opp: sc.opp, spread: sc.spread, weight: dW }) : null;
  ix = ix || buildIndex(prep);
  identity = identity || identityFor(ix, prep, week);
  const fw = forecastWeek(ix, identity, { season: prep.season, week, weights, lessons, lessonsUnplayed, now, errorModel, coverage, pubTdBlend, stackFit, budgetFit, volCal, exp, caps, trendWeights, trendHistory, driveAdjust });
  const games = fw.games.map(G => {
    const sides = {};
    for (const s of ['away', 'home']) {
      const S = G.sides[s];
      const players = S.players.slice().sort(compareDefault);
      for (const p of players) { p.sideImplied = S.implied ?? null; p.sideSpread = S.spread ?? null; }
      if (challenger) {
        // challenger may return a number (legacy logistic) or { p, legs, usage } (endzone-4.6 blend)
        const ctx = { implied: S.implied ?? null, spread: S.spread ?? null, home: s === 'home', opp: G.sides[s === 'home' ? 'away' : 'home']?.team ?? S.opp ?? null };
        for (const p of players) { const c = challenger(p, ctx); if (c && typeof c === 'object') { p.challenger = c.p; p.challengerLegs = c.legs; p.usageProb = c.usage; p.blendDrives = c.drives?.after ?? null; p.driveAdj = c.drives?.adj ?? null; } else p.challenger = c ?? null; }
        // reapply the shared team scoring budget to the shadow probabilities (not for the blend: it is a calibrated
        // combination of three already-budgeted/published forecasts and was validated without re-scaling)
        if (!challenger.noBudget) {
          const lam = players.reduce((a, p) => a + (p.challenger != null ? -Math.log(1 - Math.min(0.999, p.challenger)) : 0), 0);
          if (lam > S.tdBudget && lam > 0) for (const p of players) if (p.challenger != null) p.challenger = 1 - Math.exp(Math.log(1 - Math.min(0.999, p.challenger)) * S.tdBudget / lam);
        }
        // promoted challenger (only when the weekly gate enabled it): replaces the champion chance, still under the hard ceiling
        if (useChallenger) for (const p of players) if (p.challenger != null) { p.championChance = p.chance; p.chance = Math.min(p.challenger, challenger.noBudget ? 0.62 : (p.ceiling ?? 0.62)); p.lambda = -Math.log(1 - p.chance); p.promotedChallenger = true; }
      }
      sides[s] = { ...S, players: players.map(p => compactPrediction(p, s)).sort(compareDefault), raw: players, budget: { ...S.budget } };
    }
    return { ...G, sides };
  });
  const all = games.flatMap(g => ['away', 'home'].flatMap(s => g.sides[s].raw));
  const pick = weeklyPick(all), riser = bestRiser(all);
  return { ix, identity, W: fw.W, games, weeklyPickId: pick?.id || null, riserId: riser?.id || null, modelVersion: MODEL_VERSION, weights: fw.weights };
}
