// Weekly play-by-play simulator params (app 4.10.0): nflverse pbp (season S-1 + S) -> archive/pbp/<season>/w<week>.json,
// fitted on plays from weeks < week only (src/pbp-fit.js). The app's "Play-by-play" sim mode reads it via the archive.
// app 4.12.0: also carries `td` (src/td-share.js) — who scores a team's TDs, used by both sims when present.
// Usage: node scripts/pbp/build.mjs [--season 2026 --weeks 8,9] [--if-missing]
import fs from 'node:fs'; import path from 'node:path';
import { loadPbpSeason } from './lib.mjs';
import { fitPbp } from '../../src/pbp-fit.js';
import { buildTdShare, TD_SHARE_VERSION } from '../../src/td-share.js';
import { getState } from '../../server/prepare.js';
import { stable } from '../../server/file-archive.js';
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = process.env.ENDZONE_ARCHIVE || 'archive';
const writeIfChanged = (f, obj, ignore = ['builtAt']) => {
  const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null; const strip = o => { const c = { ...o }; for (const k of ignore) delete c[k]; return stable(c); };
  if (prev && JSON.stringify(strip(prev)) === JSON.stringify(strip(obj))) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); return true;
};
if (import.meta.url === `file://${process.argv[1]}`) {
  const st = await getState(); const season = Number(arg('season') || st.season); const cur = Number(st.display_week || st.week);
  const weeks = arg('weeks') ? arg('weeks').split(',').map(Number) : [cur, cur + 1].filter(w => w >= 1 && w <= 18);
  const missing = weeks.filter(w => { const f = path.join(dir, 'pbp', String(season), `w${w}.json`); if (!fs.existsSync(f)) return true; try { return JSON.parse(fs.readFileSync(f)).td?.version !== TD_SHARE_VERSION; } catch { return true; } });
  if (process.argv.includes('--if-missing') && !missing.length) { console.log(`pbp params present for ${season} w${weeks.join(',')}; skipping`); process.exit(0); }
  const tables = [await loadPbpSeason(season - 1, { log: console.log }), await loadPbpSeason(season, { log: console.log })];
  for (const w of weeks) {
    const P = fitPbp(tables, { season, before: w }); P.builtAt = new Date().toISOString();
    if (P.through >= w) throw new Error(`leak: week ${w} params include week ${P.through}`);
    // app 4.12.0: td-share-1 scorer split (red-zone / inside-10 / goal-line shares, recency, prior season), also plays < w only
    P.td = buildTdShare(tables, { season, before: w }); if (P.td.through >= w) throw new Error(`leak: week ${w} td-share includes week ${P.td.through}`);
    console.log(JSON.stringify({ season, week: w, through: P.through, plays: P.nPlays, written: writeIfChanged(path.join(dir, 'pbp', String(season), `w${w}.json`), P) }));
  }
}
