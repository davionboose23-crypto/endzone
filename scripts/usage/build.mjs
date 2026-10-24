// Weekly usage-model build (GitHub Actions + local): nflverse pre-game usage -> features -> walk-forward refit
// -> archive/usage/<season>/w<week>.json (per-player usage probabilities the site and the auto-run load).
// Usage: node scripts/usage/build.mjs [--season 2026 --weeks 8,9] [--cache /tmp/usage-cache.json] [--if-missing]
// Idempotent: a table whose fit and players did not change is not rewritten.
import fs from 'node:fs'; import path from 'node:path';
import { loadSeason, loadSchedule, combine, priors, trainingRows, fitCloglog, shipTable } from './lib.mjs';
import { getState } from '../../server/prepare.js';
import { stable } from '../../server/file-archive.js';
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = process.env.ENDZONE_ARCHIVE || 'archive';
export async function loadAll(season, { cache = null, log = console.log } = {}) {
  if (cache && fs.existsSync(cache)) { const j = JSON.parse(fs.readFileSync(cache)); j.seasons.forEach(S => { S.posOf = new Map(S.posOf); }); return combine(j.seasons, j.schedule); }
  const seasons = []; for (const s of [season - 2, season - 1, season]) seasons.push(await loadSeason(s, log));
  const schedule = await loadSchedule();
  if (cache) fs.writeFileSync(cache, JSON.stringify({ seasons: seasons.map(S => ({ ...S, posOf: [...S.posOf] })), schedule }));
  return combine(seasons, schedule);
}
export function buildWeek(C, season, week) {
  const Pr = priors(C, season, week); const cache = { t: new Map(), d: new Map() };
  const { X, y } = trainingRows(C, season, week, Pr, cache);
  const fit = fitCloglog(X, y, { ridge: 2 });
  return shipTable(C, fit, season, week, Pr, cache, { builtAt: new Date().toISOString(), source: 'nflverse pbp + FTN + snap counts + weekly rosters + schedule lines (pre-game only)' });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const st = await getState(); const season = Number(arg('season') || st.season); const cur = Number(st.display_week || st.week);
  const weeks = arg('weeks') ? arg('weeks').split(',').map(Number) : [cur, cur + 1].filter(w => w >= 1 && w <= 18);
  const missing = weeks.filter(w => !fs.existsSync(path.join(dir, 'usage', String(season), `w${w}.json`)));
  if (process.argv.includes('--if-missing') && !missing.length) { console.log(`usage tables present for ${season} w${weeks.join(',')}; skipping refit`); process.exit(0); }
  const C = await loadAll(season, { cache: arg('cache') });
  for (const w of weeks) {
    const T = buildWeek(C, season, w); const f = path.join(dir, 'usage', String(season), `w${w}.json`);
    const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null;
    const same = prev && JSON.stringify(stable({ ...prev, builtAt: 0 })) === JSON.stringify(stable({ ...T, builtAt: 0 }));
    if (!same) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(T)); }
    console.log(JSON.stringify({ season, week: w, players: Object.keys(T.players).length, trainRows: T.trainRows, written: !same, coef: T.coef }));
  }
}
