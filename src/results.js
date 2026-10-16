// Results vs predicted for a finished game: frozen pregame prediction (or labeled reconstruction) beside actuals.
import { gradeGame } from './grading.js';
const METRICS = ['rushYd', 'recYd', 'rec', 'passYd'];
export function gameResults(ix, game, sides, { frozen }) {
  if (!game.finished) return null;
  const prospective = frozen === 'snapshot';
  const callIds = { away: sides.away.call?.id || null, home: sides.home.call?.id || null };
  const rows = []; const teams = {};
  for (const s of ['away', 'home']) {
    const graded = gradeGame(ix, game, sides[s].players, { prospective, callIds, source: prospective ? 'frozen pregame snapshot' : 'reconstructed from earlier weeks' });
    let exp = 0, act = 0;
    for (const r of graded) {
      const a = r.actual; if (a.status !== 'confirmed' && a.status !== 'confirmed-zero') { rows.push({ id: r.id, side: s, status: a.status, note: a.note || null }); continue; }
      exp += r.chance > 0 ? -Math.log(1 - Math.min(0.999, r.chance)) : 0; act += a.td || 0;
      const vol = {}; for (const m of METRICS) { const v = r.volume?.[m]; if (!v || v.mean == null || (m === 'passYd' && r.pos !== 'QB')) continue; const x = a[m] ?? 0; vol[m] = { pred: v.mean, lo: v.lo, hi: v.hi, actual: x, inRange: v.lo != null && x >= v.lo && x <= v.hi }; }
      rows.push({ id: r.id, side: s, name: r.name, pos: r.pos, status: a.status, chance: r.chance, td: a.td || 0, scored: (a.td || 0) > 0, teamCall: r.teamCall, contributor: r.contributor, brier: (r.chance - ((a.td || 0) > 0 ? 1 : 0)) ** 2, vol,
        passTd: r.pos === 'QB' ? { pred: r.passTd?.expected ?? null, actual: a.passTd ?? null } : null });
    }
    teams[s] = { team: sides[s].team, expectedTd: exp, actualTd: act };
  }
  const graded = rows.filter(r => r.chance != null);
  const calls = graded.filter(r => r.teamCall);
  const inR = graded.flatMap(r => Object.values(r.vol)); 
  return { prospective, label: prospective ? 'Prospective: frozen pregame prediction' : 'Reconstructed: not a prospective forecast',
    summary: { players: graded.length, brier: graded.length ? graded.reduce((s, r) => s + r.brier, 0) / graded.length : null, teamCalls: { hits: calls.filter(r => r.scored).length, total: calls.length },
      expectedTd: teams.away.expectedTd + teams.home.expectedTd, actualTd: teams.away.actualTd + teams.home.actualTd, teams, rangeHits: inR.filter(v => v.inRange).length, rangeTotal: inR.length,
      missing: rows.filter(r => r.status === 'missing').length },
    rows };
}
export function weekResults(games) {
  const done = games.filter(g => g.results); const all = done.flatMap(g => g.results.rows.filter(r => r.chance != null).map(r => ({ ...r, prospective: g.results.prospective })));
  const grp = rs => ({ n: rs.length, brier: rs.length ? rs.reduce((s, r) => s + r.brier, 0) / rs.length : null, calls: { hits: rs.filter(r => r.teamCall && r.scored).length, total: rs.filter(r => r.teamCall).length }, expectedTd: done.length ? rs.reduce((s, r) => s + (r.chance > 0 ? -Math.log(1 - Math.min(0.999, r.chance)) : 0), 0) : 0, actualTd: rs.reduce((s, r) => s + r.td, 0) });
  return { games: done.length, prospective: grp(all.filter(r => r.prospective)), reconstructed: grp(all.filter(r => !r.prospective)) };
}
