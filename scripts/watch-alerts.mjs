// npm run watch-alerts [-- --watch=id1,id2 --min=0.35]
// Prints JSON of status changes for watchlist and high-chance players versus the latest saved
// pregame snapshot of each game (read-only: saves nothing). Intended for a scheduled check.
// Watchlist: --watch=ids, or WATCHLIST env (comma ids), or data/watchlist.json (array of ids; the
// browser watchlist lives in localStorage, so export it there if you want it watched server-side).
import fs from 'node:fs';
import path from 'node:path';
import { Archive } from '../server/archive.js';
import { prepareData } from '../server/prepare.js';
import { buildIndex } from '../src/stats-index.js';
import { runEngine } from '../src/engine.js';
import { calibrationState } from '../server/jobs.js';
import { MODEL_VERSION } from '../src/model.js';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const dbFile = process.env.ENDZONE_DB || path.join(process.env.ENDZONE_DATA_DIR || path.join(ROOT, 'data'), 'endzone.sqlite');
const wlFile = path.join(path.dirname(dbFile), 'watchlist.json');
const watch = new Set((arg('watch') || process.env.WATCHLIST || '').split(',').filter(Boolean).concat(fs.existsSync(wlFile) ? JSON.parse(fs.readFileSync(wlFile, 'utf8')) : []));
const minChance = Number(arg('min') || 0.35);
export async function watchAlerts({ archive, prep, watch, minChance, now = Date.now() }) {
  const ix = buildIndex(prep);
  // same production path as the refresh job (lessons + uncertainty), so differences reflect inputs, not setup
  let cal = null; try { cal = calibrationState(archive, prep, ix, prep.season, prep.week); } catch { cal = null; }
  const res = runEngine(prep, { ix, week: prep.week, now, lessons: cal?.active || null, lessonsUnplayed: cal?.unplayedLessons || null, errorModel: cal?.errorModel || null, coverage: cal?.coverage || null });
  const snaps = new Map(archive.snapshots(prep.season, prep.week, 'latest').map(s => [s.gameId, s]));
  const alerts = [], noBaseline = [];
  for (const G of res.games) {
    const snap = snaps.get(G.gameId); if (!snap) { noBaseline.push(G.gameId); continue; }
    const before = new Map(snap.players.map(p => [p.id, p]));
    const nowPlayers = new Map([...G.sides.away.players, ...G.sides.home.players].map(p => [p.id, p]));
    const excludedNow = new Map([...G.sides.away.excluded, ...G.sides.home.excluded].map(e => [e.id, e]));
    const ids = new Set([...before.keys(), ...nowPlayers.keys()]);
    for (const id of ids) {
      const b = before.get(id), a = nowPlayers.get(id);
      const why = []; if (watch.has(id)) why.push('watchlist'); if (Math.max(b?.chance || 0, a?.chance || 0) >= minChance || b?.tdConf?.level === 'High' || a?.tdConf?.level === 'High') why.push('high-chance');
      if (!why.length) continue;
      const ch = [];
      const cmp = (field, x, y) => { if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) ch.push({ field, before: x ?? null, after: y ?? null }); };
      if (b && !a) ch.push({ field: 'status', before: 'eligible', after: excludedNow.get(id)?.reason || 'no longer listed' });
      if (!b && a) ch.push({ field: 'status', before: 'not in snapshot', after: 'eligible' });
      if (b && a) {
        cmp('injury', b.injury, a.injury); cmp('practice', b.practice, a.practice); cmp('availability', b.avail?.label ?? b.avail?.factor, a.avail?.label ?? a.avail?.factor);
        cmp('role', b.role, a.role); cmp('roleTags', (b.tags || []).slice().sort(), (a.tags || []).slice().sort()); cmp('replacing', b.replacing, a.replacing);
        const tb = (b.vol?.carries || 0) + (b.vol?.targets || 0), ta = (a.vol?.carries || 0) + (a.vol?.targets || 0);
        if (Math.abs(ta - tb) >= Math.max(2, 0.25 * tb)) ch.push({ field: 'projectedTouches', before: +tb.toFixed(1), after: +ta.toFixed(1) });
        if (Math.abs((a.chance || 0) - (b.chance || 0)) >= 0.05) ch.push({ field: 'chance', before: b.chance, after: +a.chance.toFixed(4) });
        cmp('tdConfidence', b.tdConf?.level, a.tdConf?.level);
      }
      const modelChanged = snap.modelVersion !== MODEL_VERSION;
      if (modelChanged) for (const c of ch) if (c.field === 'chance' || c.field === 'tdConfidence') c.cause = `model version changed (${snap.modelVersion} → ${MODEL_VERSION})`;
      if (ch.length) alerts.push({ id, name: (a || b).name, team: (a || b).team, pos: (a || b).pos, gameId: G.gameId, kickoff: G.game.kickoff, started: G.game.started ?? (Date.parse(G.game.kickoff) <= now), reasons: why, snapshotCapturedAt: snap.capturedAt, changes: ch });
    }
  }
  return { generatedAt: new Date(now).toISOString(), season: prep.season, week: prep.week, minChance, watchCount: watch.size, alerts, gamesWithoutBaseline: noBaseline,
    note: 'Compared with the latest saved pregame snapshot per game. Snap counts are not stored in snapshots, so workload changes are reported as projected touches (carries + targets).' };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const archive = await Archive.open(dbFile);
  const prep = await prepareData({});
  console.log(JSON.stringify(await watchAlerts({ archive, prep, watch, minChance }), null, 2));
}
