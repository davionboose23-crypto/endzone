// Point-in-time reconstruction for full past seasons (walk-forward evaluation data).
// For each week w: players' teams/availability come from the nflverse weekly roster AT week w
// (ACT/INA kept, reserve lists excluded; Sleeper's current injuries/depth are cleared because they
// are not point-in-time), features use only games before w (pipeline), identity uses weeks < w.
// Output: data/hist/<tag>-<season>.json (graded rows with features).
import fs from 'node:fs';
import { prepareData } from '../../server/prepare.js';
import { streamCsv, SOURCES } from '../../server/live-feeds.js';
import { normTeam } from '../../src/roster.js';
import { buildIndex } from '../../src/stats-index.js';
import { runEngine } from '../../src/engine.js';
import { gradeGame } from '../../src/grading.js';
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
export async function loadSeason(season) {
  const prep = await prepareData({ season, week: 18 });
  const weekly = new Map(); // week -> Map(gsis|sleeper -> row)
  await streamCsv(`https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_${season}.csv`, o => {
    if (o.game_type && o.game_type !== 'REG') return null;
    if (!SKILL.has(o.position) && !SKILL.has(o.depth_chart_position)) return null;
    const w = Number(o.week); if (!w) return null;
    if (!weekly.has(w)) weekly.set(w, new Map());
    const row = { gsis: o.gsis_id || null, sleeper: o.sleeper_id || null, espn: o.espn_id || null, pfr: o.pfr_id || null, name: o.full_name, pos: o.position, team: normTeam(o.team), status: o.status, statusAbbr: o.status_description_abbr, week: w, depthPos: o.depth_chart_position };
    const m = weekly.get(w); if (row.gsis) m.set('g' + row.gsis, row); if (row.sleeper) m.set('s' + row.sleeper, row);
    return null;
  }, { timeoutMs: 120000 });
  return { prep, ix: buildIndex(prep), weekly };
}
export function prepAtWeek(S, w) {
  const R = S.weekly.get(w) || new Map();
  const players = [];
  for (const p of S.prep.players) {
    const r = (p.gsis && R.get('g' + p.gsis)) || R.get('s' + p.id); if (!r) continue;
    if (!(r.status === 'ACT' || r.status === 'INA')) continue; // reserve/practice squad/cut known pregame
    players.push({ ...p, team: r.team, injury: null, practice: null, injuryNotes: null, depth: null, depthPos: r.depthPos || p.pos, status: 'Active', active: true, rosterStatus: r.status });
  }
  const roster = [...new Map([...R.values()].map(r => [r.gsis || r.sleeper, r])).values()];
  return { ...S.prep, week: w, currentWeek: w, players, roster };
}
export function gradeWeek(S, w, engineOpts = {}) {
  const pw = prepAtWeek(S, w);
  const res = runEngine(pw, { ix: S.ix, week: w, now: Date.now(), lessons: null, ...engineOpts });
  const rows = []; const rs = new Map(pw.players.map(p => [p.id, p.rosterStatus]));
  for (const G of res.games) {
    if (!G.game.finished) continue;
    const callIds = { away: G.sides.away.call?.id, home: G.sides.home.call?.id };
    for (const s of ['away', 'home']) {
      const Sd = G.sides[s];
      for (const r of gradeGame(S.ix, G.game, Sd.players, { prospective: false, callIds })) {
        if (!(r.actual.status === 'confirmed' || r.actual.status === 'confirmed-zero')) continue;
        rows.push({ rosterStatus: rs.get(r.id) || null, season: G.game.season, week: w, gameId: G.game.id, id: r.id, name: r.name, pos: r.pos, team: r.team, side: s, spread: Sd.spread, implied: Sd.implied, teamLambda: Sd.teamLambda, tdBudget: Sd.tdBudget,
          chance: r.chance, lambda: r.lambda, published: r.published, pubExp: r.published != null ? -Math.log(1 - Math.min(0.999, r.published)) : null,
          y: r.actual.td > 0 ? 1 : 0, td: r.actual.td, teamCall: r.teamCall, contributor: r.contributor, tdConf: r.tdConf, role: r.role, glShare: r.glShare, insideFinisher: r.insideFinisher, recentFinisher: r.recentFinisher, coldGoal: r.coldGoal,
          ceiling: r.ceiling, preSafety: r.preSafety, secondOption: !!r.secondOption, preStack: r.preStack, glShareRaw: r.glShareRaw, stacked: r.stacked, recentRzLooks: r.recentRzLooks, gamesPlayed: r.gamesPlayed, i10Exp: r.i10Exp, lambdaRaw: r.lambdaRaw, components: r.components, vol: r.vol, verified: r.verified,
          volume: Object.fromEntries(Object.entries(r.volume || {}).map(([k, v]) => [k, { mean: v.mean, lo: v.lo, hi: v.hi }])), volConf: r.volConf,
          actualVol: { rushYd: r.actual.rushYd, rec: r.actual.rec, recYd: r.actual.recYd, passYd: r.actual.passYd } });
      }
    }
  }
  return rows;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const tag = process.argv[2] || 'base'; const seasons = (process.argv[3] || '2024,2025,2026').split(',').map(Number);
  const opts = process.argv[4] ? JSON.parse(process.argv[4]) : {};
  for (const season of seasons) {
    const t = Date.now(); const S = await loadSeason(season);
    const last = season === S.prep.season && S.prep.games.some(g => g.season === season && !g.finished && g.week <= 18) ? Math.max(...S.prep.games.filter(g => g.season === season && g.finished).map(g => g.week)) : 18;
    const rows = []; for (let w = 1; w <= last; w++) rows.push(...gradeWeek(S, w, opts));
    fs.writeFileSync(`data/hist/${tag}-${season}.json`, JSON.stringify(rows));
    console.log(season, 'weeks 1-' + last, 'rows', rows.length, 'withPub', rows.filter(r => r.published != null).length, 'games', new Set(rows.map(r => r.gameId)).size, Math.round((Date.now() - t) / 1000) + 's');
  }
}
