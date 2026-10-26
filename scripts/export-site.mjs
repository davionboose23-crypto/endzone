// Publish the repo archive for the Pages app: _site/archive/<season>/w<week>.json has the same shape as the
// local server's /api/archive response (frozen snapshots, lessons, active calibration, validation, pick tracker)
// plus what the model learned. Usage: node scripts/export-site.mjs <outDir> [--weeks 1-8]
import fs from 'node:fs'; import path from 'node:path';
import { FileArchive, writeJson } from '../server/file-archive.js';
import { prepareData, getState } from '../server/prepare.js';
import { buildIndex } from '../src/stats-index.js';
import { calibrationState } from '../server/jobs.js';
import { describeLessons, pickTracker } from '../src/research.js';
import { MODEL_VERSION } from '../src/model.js';
import { componentState } from '../src/calibration.js';
const out = process.argv[2] || '_site/archive'; const A = await FileArchive.open(process.env.ENDZONE_ARCHIVE || 'archive');
const st = await getState(); const season = Number(st.season); const cur = Number(st.display_week || st.week);
const S = A.state(); const index = { season, currentWeek: cur, weeks: [], modelVersion: MODEL_VERSION, exportedAt: new Date().toISOString() };
for (let week = 1; week <= Math.min(18, cur + 1); week++) {
  const prep = await prepareData({ season, week }); if (!prep.games.some(g => g.season === season && g.week === week)) continue;
  const ix = buildIndex(prep); const cal = calibrationState(A, prep, ix, season, week); const v = A.latestExperiment('validation');
  writeJson(path.join(out, String(season), `w${week}.json`), {
    season, week, modelVersion: MODEL_VERSION, repoArchive: true,
    snapshots: A.snapshots(season, week, 'latest'), firstSnapshots: A.snapshots(season, week, 'first').map(s => ({ gameId: s.gameId, capturedAt: s.capturedAt, modelVersion: s.modelVersion })),
    lessons: A.lessons(season), activeCalibration: { active: cal.active, inWeek: cal.inWeek, unplayed: cal.unplayedLessons, describe: describeLessons(cal.active) },
    uncertainty: { errorModel: cal.errorModel, coverage: cal.coverage }, trendHistory: cal.trendHistory,
    challenger: cal.challenger, usage: cal.usage || null, drives: A.drives?.(season, week) || null,
    researchStatus: v ? v.payload : null, pickTracker: pickTracker(cal.cur.perWeek), lastRun: A.lastRun(),
    learned: { ...(S.learned || {}), changes: S.changes || [], components: componentState(), decisions: S.decisions || [], promotion: S.promotion || null },
    schedule: 'Shared archive: a scheduled GitHub Actions job captures pregame snapshots and grades finished games (about every 30 minutes in game windows; GitHub may delay scheduled runs).',
  });
  index.weeks.push(week); console.log('exported', season, week, A.snapshots(season, week).length, 'snapshots');
}
writeJson(path.join(out, 'index.json'), index);
