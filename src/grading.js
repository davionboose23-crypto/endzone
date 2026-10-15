// Joins predictions (frozen snapshots preferred, else reconstructed) with outcomes.
import { actualOutcome } from './forecast-details.js';
export function gradeGame(ix, game, preds, { prospective, callIds = {}, source }) {
  return preds.map(p => {
    const player = { id: p.id, gsis: p.gsis, team: p.team, name: p.name, pos: p.pos };
    const actual = actualOutcome(ix, player, game);
    return { ...p, published: p.published?.probability ?? (typeof p.published === 'number' ? p.published : null), publishedSource: p.published?.source || null, gameId: game.id, season: game.season, week: game.week, kickoff: game.kickoff, actual, prospective, source,
      teamCall: callIds.away === p.id || callIds.home === p.id, contributor: (p.chance || 0) >= 0.1 || ((p.vol?.carries || 0) + (p.vol?.targets || 0)) >= 5,
      tdConf: p.tdConf?.level || p.tdConf || null, volConf: Object.fromEntries(Object.entries(p.volConf || {}).map(([k, v]) => [k, v?.level || v])) };
  });
}
export function snapshotFromGame(G, meta) {
  const players = [...G.sides.away.players, ...G.sides.home.players];
  return { season: G.game.season, week: G.game.week, gameId: G.game.id, kickoff: G.game.kickoff, modelVersion: meta.modelVersion, weights: meta.weights,
    inputTimestamps: meta.inputTimestamps, sourceAvailability: meta.sourceAvailability, lessons: meta.lessonsLabel || null,
    roster: { away: G.sides.away.players.map(p => ({ id: p.id, gsis: p.gsis, team: p.team, verified: p.verified })), home: G.sides.home.players.map(p => ({ id: p.id, gsis: p.gsis, team: p.team, verified: p.verified })),
      excluded: [...G.sides.away.excluded, ...G.sides.home.excluded] },
    callIds: { away: G.sides.away.call?.id || null, home: G.sides.home.call?.id || null },
    lines: G.sides.away.lines, teams: { away: { team: G.sides.away.team, teamLambda: G.sides.away.teamLambda, tdBudget: G.sides.away.tdBudget }, home: { team: G.sides.home.team, teamLambda: G.sides.home.teamLambda, tdBudget: G.sides.home.tdBudget } },
    gameLambda: G.gameLambda, players, challenger: meta.challenger || null };
}
