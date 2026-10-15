// Conservative learning from completed games: per-shape scales, last three weeks
// averaged (missing week = 1), damped in-week nudges, never compounding a season.
import { clamp } from './model.js';
export const MIN_CONFIRMED = 8;
const BAND_BOUNDS = { lt15: [0.8, 1.15], '15to25': [0.8, 1.15], '25to35': [0.8, 1.15], '35to50': [0.45, 1.05], '50plus': [0.8, 1.08] };
const VOL_RULES = { rushYd: { k: 600, b: [0.72, 1.10] }, rec: { k: 60, b: [0.9, 1.1] }, recYd: { k: 600, b: [0.9, 1.1] }, passYd: { k: 600, b: [0.9, 1.1] } };
export function bandKey(p) { return p < 0.15 ? 'lt15' : p < 0.25 ? '15to25' : p < 0.35 ? '25to35' : p < 0.5 ? '35to50' : '50plus'; }

export function weeklyLesson(rows, { season, week } = {}) {
  const conf = rows.filter(r => r.actual && (r.actual.status === 'confirmed' || r.actual.status === 'confirmed-zero'));
  const res = { season, week, confirmed: conf.length, prospective: conf.filter(r => r.prospective).length, reconstructed: conf.filter(r => !r.prospective).length, applied: conf.length >= MIN_CONFIRMED, vol: {}, band: {}, spot: {}, explain: [] };
  if (!res.applied) { res.explain.push(`Only ${conf.length} confirmed results (needs ${MIN_CONFIRMED}); no lesson.`); return res; }
  for (const [m, rule] of Object.entries(VOL_RULES)) {
    const g = conf.filter(r => r.volume?.[m]?.mean != null && (m !== 'passYd' || r.pos === 'QB'));
    const a = g.reduce((s, r) => s + (r.actual[m] || 0), 0), p = g.reduce((s, r) => s + r.volume[m].mean, 0);
    res.vol[m] = g.length ? clamp((a + rule.k) / (p + rule.k), ...rule.b) : 1;
  }
  for (const [b, bounds] of Object.entries(BAND_BOUNDS)) {
    const g = conf.filter(r => bandKey(r.chance) === b && !(b === '35to50' && r.insideFinisher));
    const hits = g.filter(r => r.actual.td > 0).length, exp = g.reduce((s, r) => s + r.chance, 0);
    res.band[b] = g.length ? clamp((hits + 3) / (exp + 3), ...bounds) : 1;
    if (b === '35to50' && res.band[b] < 0.85) res.explain.push(`35–50% names without an inside-10 finishing role scored ${hits} of ${g.length} (expected ${exp.toFixed(1)}): that band comes down to ×${res.band[b].toFixed(2)}.`);
  }
  const known = conf.filter(r => r.actual.spotKnown && r.components);
  for (const k of ['r1', 'r2', 'r3', 't1', 't2', 't3']) {
    const e = known.reduce((s, r) => s + (r.components[k] || 0), 0), a = known.reduce((s, r) => s + (r.actual.spotTd[k] || 0), 0);
    res.spot[k] = known.length ? clamp((a + 10) / (e + 10), 0.7, 1.3) : 1;
  }
  return res;
}
// Average only the previous three weeks' scales; a missing week counts as 1.
export function activeLessons(lessonsByWeek, week) {
  const weeks = [week - 1, week - 2, week - 3];
  const pick = (L, grp, k) => (L && L.applied && L[grp] && L[grp][k] != null ? L[grp][k] : 1);
  const out = { vol: {}, band: {}, spot: {}, weeks, basis: weeks.map(w => ({ week: w, applied: !!lessonsByWeek[w]?.applied, prospective: lessonsByWeek[w]?.prospective || 0, reconstructed: lessonsByWeek[w]?.reconstructed || 0 })) };
  for (const [grp, keys] of [['vol', Object.keys(VOL_RULES)], ['band', Object.keys(BAND_BOUNDS)], ['spot', ['r1', 'r2', 'r3', 't1', 't2', 't3']]]) for (const k of keys) out[grp][k] = weeks.reduce((s, w) => s + pick(lessonsByWeek[w], grp, k), 0) / 3;
  out.prospectiveCount = out.basis.reduce((s, b) => s + b.prospective, 0); out.reconstructedCount = out.basis.reduce((s, b) => s + b.reconstructed, 0);
  out.label = out.prospectiveCount ? 'Learned from finished games, from the last three weeks' : 'Learned from finished games (reconstructed history, not prospectively validated), from the last three weeks';
  return out;
}
// Damped in-week nudge from games completed before this game's forecast.
export function withInWeekNudge(active, inWeekLesson) {
  if (!inWeekLesson || !inWeekLesson.applied) return active;
  const out = JSON.parse(JSON.stringify(active)); out.inWeek = { confirmed: inWeekLesson.confirmed };
  for (const grp of ['vol', 'band', 'spot']) for (const k of Object.keys(out[grp])) out[grp][k] *= ((inWeekLesson[grp]?.[k] ?? 1) + 2) / 3;
  return out;
}
export function describeLessons(L) {
  if (!L) return [];
  const pct = x => `${x >= 1 ? '+' : ''}${((x - 1) * 100).toFixed(0)}%`;
  const lines = [L.label];
  for (const [k, v] of Object.entries(L.vol)) if (Math.abs(v - 1) >= 0.005) lines.push(`${k}: ${pct(v)}`);
  for (const [k, v] of Object.entries(L.band)) if (Math.abs(v - 1) >= 0.005) lines.push(`${k} chances: ${pct(v)}`);
  for (const [k, v] of Object.entries(L.spot)) if (Math.abs(v - 1) >= 0.005) lines.push(`${k} spot: ${pct(v)}`);
  return lines;
}

// Pick tracker: week-by-week record of team calls and High-TD names from graded rows.
// Prospective (frozen pregame snapshot) and reconstructed rows are counted separately, never merged.
export function pickTracker(perWeek) {
  const weeks = [];
  for (const [w, rows] of Object.entries(perWeek || {}).sort((a, b) => a[0] - b[0])) {
    const out = { week: +w, groups: {} };
    for (const kind of ['prospective', 'reconstructed']) {
      const rs = rows.filter(r => !!r.prospective === (kind === 'prospective'));
      if (!rs.length) continue;
      const known = r => r.actual && (r.actual.status === 'confirmed' || r.actual.status === 'confirmed-zero');
      const item = r => ({ id: r.id, name: r.name, team: r.team, pos: r.pos, chance: r.chance, tdConf: r.tdConf, outcome: known(r) ? (r.actual.td > 0 ? 'scored' : 'no TD') : (r.actual?.status || 'pending') });
      const grp = sel => { const list = rs.filter(sel).map(item); const k = list.filter(x => x.outcome === 'scored' || x.outcome === 'no TD'); return { hits: k.filter(x => x.outcome === 'scored').length, total: k.length, pending: list.length - k.length, list }; };
      out.groups[kind] = { teamCalls: grp(r => r.teamCall), highTd: grp(r => r.tdConf === 'High') };
    }
    weeks.push(out);
  }
  const tot = (kind, key) => weeks.reduce((a, w) => { const g = w.groups[kind]?.[key]; if (g) { a.hits += g.hits; a.total += g.total; } return a; }, { hits: 0, total: 0 });
  return { weeks, totals: Object.fromEntries(['prospective', 'reconstructed'].map(k => [k, { teamCalls: tot(k, 'teamCalls'), highTd: tot(k, 'highTd') }])) };
}
