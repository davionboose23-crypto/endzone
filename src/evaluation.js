// Evaluation: Brier, log loss, flat-25% baseline on the actual cohort, matched
// published comparison, calibration bins with 95% intervals, volume accuracy, misses.
const BANDS = [['lt15', 'Under 15%', 0, 0.15], ['15to25', '15–25%', 0.15, 0.25], ['25to35', '25–35%', 0.25, 0.35], ['35to50', '35–50%', 0.35, 0.5], ['50plus', '50%+', 0.5, 1.01]];
const eps = 1e-6;
export const brier = rows => (rows.length ? rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length : null);
export const logLoss = rows => (rows.length ? -rows.reduce((s, r) => { const p = Math.min(1 - eps, Math.max(eps, r.p)); return s + (r.y ? Math.log(p) : Math.log(1 - p)); }, 0) / rows.length : null);
export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null]; const p = k / n; const d = 1 + z * z / n; const c = p + z * z / (2 * n); const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}
export function calibrationBins(rows) {
  return BANDS.map(([key, label, lo, hi]) => { const g = rows.filter(r => r.p >= lo && r.p < hi); const k = g.filter(r => r.y).length;
    return { key, label, n: g.length, avgChance: g.length ? g.reduce((s, r) => s + r.p, 0) / g.length : null, hitRate: g.length ? k / g.length : null, ci: wilson(k, g.length) }; });
}
export function ece(rows) { const bins = calibrationBins(rows); const n = rows.length || 1; return bins.reduce((s, b) => s + (b.n ? b.n / n * Math.abs(b.avgChance - b.hitRate) : 0), 0); }

// Build graded rows: one per prediction with a confirmed (or confirmed-zero) outcome.
export function gradeRows(preds) {
  const rows = [], missing = [], pending = [];
  for (const x of preds) {
    const st = x.actual?.status;
    if (st === 'confirmed' || st === 'confirmed-zero') rows.push({ ...x, p: x.chance, y: x.actual.td > 0 ? 1 : 0 });
    else if (st === 'missing') missing.push(x); else pending.push(x);
  }
  return { rows, missing, pending };
}
export function cohortMetrics(rows) {
  const matched = rows.filter(r => r.published != null);
  return { n: rows.length, scored: rows.filter(r => r.y).length, confirmedZeros: rows.filter(r => !r.y).length, brier: brier(rows), logLoss: logLoss(rows),
    flat25Brier: brier(rows.map(r => ({ p: 0.25, y: r.y }))),
    matched: { n: matched.length, model: brier(matched), published: brier(matched.map(r => ({ p: r.published, y: r.y }))), modelLogLoss: logLoss(matched), publishedLogLoss: logLoss(matched.map(r => ({ p: r.published, y: r.y }))) },
    bins: calibrationBins(rows) };
}
export function tdReport(preds) {
  const { rows, missing, pending } = gradeRows(preds);
  const cohorts = {
    all: rows, contributors: rows.filter(r => r.contributor), teamCalls: rows.filter(r => r.teamCall), highTd: rows.filter(r => r.tdConf === 'High'),
    medTd: rows.filter(r => r.tdConf === 'Med'), lowTd: rows.filter(r => r.tdConf === 'Low'),
  };
  const out = { missingExcluded: missing.length, pending: pending.length, prospective: rows.filter(r => r.prospective).length, reconstructed: rows.filter(r => !r.prospective).length, cohorts: {} };
  for (const [k, v] of Object.entries(cohorts)) out.cohorts[k] = { all: cohortMetrics(v), prospective: cohortMetrics(v.filter(r => r.prospective)), reconstructed: cohortMetrics(v.filter(r => !r.prospective)) };
  out.highestMisses = rows.filter(r => !r.y).sort((a, b) => b.p - a.p).slice(0, 10).map(r => ({ ...brief(r), reason: classifyMiss(r) }));
  out.lowestScorers = rows.filter(r => r.y).sort((a, b) => a.p - b.p).slice(0, 10).map(brief);
  out.spots = spotReport(rows);
  return out;
}
const brief = r => ({ id: r.id, name: r.name, team: r.team, pos: r.pos, week: r.week, chance: r.p, td: r.actual.td, prospective: r.prospective });
export function classifyMiss(r) {
  const a = r.actual; const projTouches = (r.vol?.carries || 0) + (r.vol?.targets || 0);
  if (a.status === 'missing') return 'Missing data (excluded)';
  if (projTouches > 0 && (a.carries + a.targets) < 0.6 * projTouches) return (a.carries + a.targets) <= 0.25 * projTouches ? 'Workload shortfall (possible in-game injury or inactive; not verified)' : 'Workload shortfall';
  if (a.spotKnown) { const rz = ['r1', 'r2', 'r3', 't1', 't2', 't3'].reduce((s, k) => s + (a.spotLooks[k] || 0), 0); return rz === 0 ? 'No confirmed red-zone opportunity' : 'Scoring chances failed to convert'; }
  return 'Red-zone opportunity unknown (no yard-line data)';
}
export function spotReport(rows) {
  const known = rows.filter(r => r.actual.spotKnown && r.components);
  const keys = ['r1', 'r2', 'r3', 'r0', 't1', 't2', 't3', 't0'];
  const agg = keys.map(k => ({ spot: k, expected: known.reduce((s, r) => s + (r.components[k] || 0), 0), actual: known.reduce((s, r) => s + (r.actual.spotTd[k] || 0), 0), n: known.length }));
  const cold = [];
  for (const r of known) for (const k of keys) if ((r.components[k] || 0) >= 0.15 && (r.actual.spotTd[k] || 0) === 0) cold.push({ name: r.name, week: r.week, spot: k, expected: r.components[k] });
  return { agg, meaningfulZero: cold.sort((a, b) => b.expected - a.expected).slice(0, 25), excludedUnknown: rows.length - known.length };
}
// Volume accuracy: MAE, signed bias, empirical coverage of saved ranges.
export function volumeReport(preds) {
  const metrics = { rushYd: 'rushYd', rec: 'rec', recYd: 'recYd', passYd: 'passYd' }; const out = {};
  for (const m of Object.keys(metrics)) {
    const rows = preds.filter(x => (x.actual?.status === 'confirmed' || x.actual?.status === 'confirmed-zero') && x.volume?.[m]?.mean != null && (m !== 'passYd' || x.pos === 'QB'));
    const summarize = g => { if (!g.length) return { n: 0 }; const err = g.map(x => x.volume[m].mean - x.actual[m]); return { n: g.length, mae: err.reduce((s, e) => s + Math.abs(e), 0) / g.length, bias: err.reduce((s, e) => s + e, 0) / g.length, coverage: g.filter(x => x.volume[m].lo != null && x.actual[m] >= x.volume[m].lo && x.actual[m] <= x.volume[m].hi).length / g.length }; };
    const by = f => { const o = {}; for (const x of rows) { const k = f(x); (o[k] = o[k] || []).push(x); } return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, summarize(v)])); };
    out[m] = { overall: summarize(rows), byConfidence: by(x => x.volConf?.[m] || 'n/a'), bySource: by(x => (x.prospective ? 'prospective' : 'reconstructed')), bySegment: by(x => x.segment || 'n/a'), prospective: summarize(rows.filter(x => x.prospective)) };
  }
  out.passTd = { provisional: true, note: 'Passing TDs stay provisional until their own prospective validation exists.' };
  return out;
}
