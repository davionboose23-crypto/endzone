// Headless scheduled job (GitHub Actions): capture pregame snapshots strictly before kickoff (first + latest),
// reconcile final results, grade, update lessons/validation, and record what the model learned, all in archive/.
// Usage: node scripts/auto-run.mjs [--season 2026 --week 7]   (idempotent: unchanged inputs => no file changes)
import { FileArchive, writeJson, stable } from '../server/file-archive.js';
import { refresh } from '../server/jobs.js';
import { MODEL_VERSION } from '../src/model.js';
import { componentState } from '../src/calibration.js';
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : undefined; };
const dir = process.env.ENDZONE_ARCHIVE || 'archive';
const A = await FileArchive.open(dir);
const r = await refresh(A, { season: arg('season'), week: arg('week') });
console.log(JSON.stringify({ week: r.details.week, status: r.status, steps: r.details.steps, partial: r.details.partial, error: r.details.error }, null, 1));
if (!r.ok) process.exit(1);
// also capture the next week's first/latest pregame frames (strictly before kickoff) unless a week was pinned
if (!arg('week') && r.details.week < 18) {
  const n = await refresh(A, { season: r.details.season, week: r.details.week + 1 });
  console.log(JSON.stringify({ week: n.details.week, status: n.status, steps: n.details.steps, error: n.details.error }, null, 1));
}
const st = A.state(); const L = r.details.learned;
const scales = L ? { vol: L.active.vol, band: L.active.band, spot: L.active.spot } : null;
const prev = st.learned?.scales || null;
st.learned = { season: r.details.season, week: r.details.week, scales, describe: L?.describe || [], basis: L?.active.basis || [], label: L?.active.label || null, inWeek: L?.inWeek || null, modelVersion: MODEL_VERSION };
if (scales && JSON.stringify(stable(scales)) !== JSON.stringify(stable(prev))) {
  const diff = [];
  for (const g of ['vol', 'band', 'spot']) for (const k of Object.keys(scales[g] || {})) { const a = prev?.[g]?.[k] ?? 1, b = scales[g][k]; if (Math.abs(a - b) >= 0.005) diff.push({ group: g, key: k, from: +a.toFixed(4), to: +b.toFixed(4) }); }
  if (diff.length || !prev) st.changes = [{ at: new Date().toISOString(), season: r.details.season, week: r.details.week, diff, why: 'Lessons recomputed after newly finished games (last-3-weeks rule; in-week nudge for later games).' }, ...(st.changes || [])].slice(0, 30);
}
st.promotion = L?.promotion || null; st.drivesPromotion = L?.drivesPromotion || st.drivesPromotion || null; st.components = componentState();
A.saveState(st);
writeJson(`${dir}/index.json`, { seasons: Object.fromEntries(A.seasons().map(s => [s, A.weeks(s)])), modelVersion: MODEL_VERSION });
