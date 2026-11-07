// Display-only opening-possession estimate. Reads only the current-season drive grid,
// never model chances, fitted patterns, betting data, or either simulation engine.
// Grid schema is documented in scripts/drives/profile.mjs. A touch means rec + car.
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const shrink = (x, n, base, k) => (x + k * base) / (n + k);
const sum = (a, fn) => a.reduce((s, x) => s + fn(x), 0);
const stat = d => ({ td: +(d[5] === 'TD'), scored: +['TD', 'FG'].includes(d[5]),
  touches: sum(d[8] || [], r => r[2] + r[4]),
  rushYards: sum(d[8] || [], r => r[5]), recYards: sum(d[8] || [], r => r[3]) });
const aggregate = a => ({ n: a.length, td: sum(a, x => x.td), scored: sum(a, x => x.scored), touches: sum(a, x => x.touches),
  rushYards: sum(a, x => x.rushYards), recYards: sum(a, x => x.recYards) });

export function firstDriveForecast(D, player, opponent = null) {
  // Explicit season lock: an older/newer grid must never silently become 2026 research.
  if (D?.season !== 2026 || !D.teams || !(D.week > 1)) return null;
  const games = [], all = [], league = [], offense = [], defense = [], peers = [];
  let position = player.pos || null;
  for (const [team, T] of Object.entries(D.teams)) {
    const pi = (T.people || []).findIndex(r => (player.gsis && r[0] === player.gsis) || (player.id != null && r[3] != null && String(r[3]) === String(player.id)));
    if (!position && pi >= 0) position = T.people[pi][2];
    for (const g of T.games || []) {
      // Weekly grids already enforce this; repeat it to guard stale/mixed fixtures.
      if (!(g.w < D.week)) continue;
      const first = g.d.find(d => d[0] === 1);
      if (first) {
        const s = stat(first); league.push(s);
        if (team === player.team) offense.push(s);
        if (g.opp === opponent) defense.push(s);
        // Same-position first-possession cohort. Include a zero opener only when
        // that player has recorded target/carry involvement elsewhere in this game.
        const active = new Set(g.d.flatMap(d => (d[8] || []).map(r => r[0])));
        for (const i of active) {
          const r = (first[8] || []).find(r => r[0] === i) || [i, 0, 0, 0, 0, 0, 0, 0];
          peers.push({ pos: T.people?.[i]?.[2], catches: r[2], carries: r[4], recYards: r[3], rushYards: r[5] });
        }
      }
      if (pi < 0) continue;
      // A missing first-drive row is a zero only if he has recorded game involvement.
      // This avoids treating inactive / DNP games as observed opening-drive misses.
      if (!g.d.some(d => (d[8] || []).some(r => r[0] === pi))) continue;
      for (const d of g.d) {
        const r = (d[8] || []).find(r => r[0] === pi) || [pi, 0, 0, 0, 0, 0, 0, 0];
        const line = { touches: r[2] + r[4], targets: r[1], carries: r[4], catches: r[2], rushYards: r[5], recYards: r[3], yards: r[3] + r[5],
          playerTd: +(r[7] > 0), teamTd: +(d[5] === 'TD'), teamTargets: d[6], opportunities: d[6] + d[7] };
        all.push(line);
        if (d === first) games.push({ week: g.w, team, opp: g.opp, rz: !!(d[3] & 4), result: d[5], ...line });
      }
    }
  }
  games.sort((a, b) => a.week - b.week);
  const L = aggregate(league), O = aggregate(offense), A = aggregate(defense);
  if (!games.length || !L.n || !all.length) return { games: [], offense: O, defense: A };
  const n = games.length, touchGames = sum(games, g => +(g.touches > 0));
  const observed = { games: n, touchGames, touchRate: touchGames / n, touches: sum(games, g => g.touches),
    targets: sum(games, g => g.targets), teamTargets: sum(games, g => g.teamTargets) };
  observed.targetShare = observed.teamTargets ? observed.targets / observed.teamTargets : null;
  const baseTouch = sum(all, g => +(g.touches > 0)) / all.length;
  const baseTouches = sum(all, g => g.touches) / all.length;
  const leagueTd = L.td / L.n, leagueTouches = L.touches / L.n;
  const matchup = A.n && leagueTouches ? clamp(shrink(A.touches, A.n, leagueTouches, 6) / leagueTouches, .75, 1.25) : 1;
  const touches = shrink(observed.touches, n, baseTouches, 4) * matchup;
  // Scale the zero-touch hazard (not raw probability) to stay bounded and monotone.
  const touch = Math.min(touches, 1 - Math.pow(1 - shrink(touchGames, n, baseTouch, 4), matchup));
  const teamTd = clamp((shrink(O.td, O.n, leagueTd, 6) + shrink(A.td, A.n, leagueTd, 6)) / 2);
  const opportunities = sum(all, g => g.opportunities), playerOpp = sum(all, g => g.targets + g.carries);
  const opportunityShare = opportunities ? playerOpp / opportunities : 0;
  const tdShare = shrink(sum(all, g => g.playerTd), sum(all, g => g.teamTd), opportunityShare, 4);
  const firstTdShare = shrink(sum(games, g => g.playerTd), sum(games, g => g.teamTd), tdShare, 3);
  const playerTd = Math.min(touch, teamTd, teamTd * clamp(firstTdShare));
  const recent = games.slice(-3), previous = games.slice(-6, -3);
  const recentMean = sum(recent, g => g.touches) / recent.length;
  const prevMean = previous.length ? sum(previous, g => g.touches) / previous.length : null;
  const delta = prevMean == null ? null : recentMean - prevMean;
  const direction = n < 4 ? 'insufficient' : delta >= .5 ? 'rising' : delta <= -.5 ? 'falling' : 'steady';
  return { games, observed, offense: O, defense: A, league: L,
    yardage: firstDriveYardage(games, peers, position, L, A),
    prediction: { touch, touches, playerTd, teamTd, matchup },
    trend: { direction, recent: recentMean, previous: prevMean, recentN: recent.length, previousN: previous.length } };
}

// New yardage/catch/carry estimates use ONLY first possessions, unlike the older
// touch/TD forecast above. Cohort half-count regularization avoids a 0/100% prior.
function firstDriveYardage(games, peers, position, league, defense) {
  const samePos = peers.filter(g => g.pos === position);
  const cohort = samePos.length ? samePos : peers;
  const n = games.length, k = 2;
  const definitions = [
    ['carry', '1+ carry', g => g.carries >= 1],
    ['catch', '1+ catch', g => g.catches >= 1],
    ['rush10', '10+ rushing yards', g => g.rushYards >= 10],
    ['rec10', '10+ receiving yards', g => g.recYards >= 10],
    ['scrim20', '20+ scrimmage yards', g => g.rushYards + g.recYards >= 20],
  ];
  const outcomes = definitions.map(([key, label, hit]) => {
    const hits = sum(games, g => +hit(g));
    const prior = (sum(cohort, g => +hit(g)) + .5) / (cohort.length + 1);
    const probability = shrink(hits, n, prior, k);
    const level = probability >= .75 ? 'High' : probability >= .6 ? 'Likely' : probability >= .4 ? 'Coin flip' : probability >= .2 ? 'Possible' : 'Long shot';
    return { key, label, hits, games: n, rawRate: hits / n, probability, level, prior };
  });
  // Context affects mean yards, NOT historical threshold probabilities. A team's
  // allowed first-drive yardage is not the probability for a specific player.
  const expected = {}, context = { games: defense.n };
  for (const key of ['rushYards', 'recYards']) {
    const leagueMean = league[key] / league.n;
    const allowedMean = defense.n ? defense[key] / defense.n : null;
    const multiplier = defense.n && leagueMean > 0 ? clamp(shrink(defense[key], defense.n, leagueMean, 6) / leagueMean, .8, 1.2) : 1;
    const cohortMean = cohort.length ? sum(cohort, g => g[key]) / cohort.length : 0;
    // Retain negative historical yards (including rushing losses); never infer an explosive play from drive totals.
    expected[key] = shrink(sum(games, g => g[key]), n, cohortMean, k) * multiplier;
    context[key] = { leagueMean, allowedMean, multiplier };
  }
  const byProb = (a, b) => b.probability - a.probability;
  // The top three include at least one yardage outcome (only two outcomes are
  // involvement-only); do not hide a more likely catch behind a long-shot yardage claim.
  const headline = outcomes.slice().sort(byProb).slice(0, 3).map(o => o.key);
  return { outcomes, headline, expected, context,
    position, cohortGames: cohort.length, priorDrives: k, smallSample: n < 4 };
}
