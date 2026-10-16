// Standalone worker: the same src/worker.js, but /api/data and /api/archive are answered
// in-browser (live Sleeper + nflverse feeds, bundled nflverse fallback, IndexedDB archive).
import { setBundle } from './feed-cache-browser.js';
import { prepareData } from '../server/prepare.js';
import { calibrationState, summarizeReport } from '../server/jobs.js';
import { runEngine } from '../src/engine.js';
import { buildIndex } from '../src/stats-index.js';
import { snapshotFromGame } from '../src/grading.js';
import { describeLessons, pickTracker } from '../src/research.js';
import { challengerProbability, promotionDecision } from '../src/validation.js';
import { tdReport, volumeReport } from '../src/evaluation.js';
import { MODEL_VERSION, DEFAULT_WEIGHTS } from '../src/model.js';

/* global __BUNDLE_B64__ */
const bundleReady = (async () => {
  try {
    const bin = Uint8Array.from(atob(__BUNDLE_B64__), c => c.charCodeAt(0));
    const text = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    setBundle(JSON.parse(text));
  } catch (e) { setBundle(null); }
})();

// ---- IndexedDB pregame-frame archive (first + latest per game, strictly before kickoff)
const DB = 'endzone-standalone', ST = 'snapshots';
const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(ST); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function allSnaps() { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(ST, 'readonly'); const r = t.objectStore(ST).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }
async function putSnap(key, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(ST, 'readwrite'); t.objectStore(ST).put(v, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
class MiniArchive {
  constructor(list) { this.list = list; }
  snapshots(season, week, kind = 'latest') { return this.list.filter(s => s.kind === kind && s.season === season && s.week === week && Date.parse(s.capturedAt) < Date.parse(s.kickoff)).map(s => s.payload); }
}

const realFetch = self.fetch.bind(self);
let lastPrep = null;
const nd = o => JSON.stringify(o) + '\n';
function dataResponse(url, signal) {
  const q = url.searchParams; const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        await bundleReady;
        const prep = await prepareData({ season: Number(q.get('season')) || undefined, week: Number(q.get('week')) || undefined, force: q.get('force') === '1', signal, onStage: s => ctrl.enqueue(enc.encode(nd({ type: 'stage', ...s }))) });
        lastPrep = prep; ctrl.enqueue(enc.encode(nd({ type: 'data', data: prep })));
      } catch (e) { ctrl.enqueue(enc.encode(nd({ type: 'error', error: String(e.message || e) }))); }
      ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}
// Shared repo archive published with the Pages site (archive/<season>/w<week>.json). Same frozen
// predictions, grades and lessons on every device; this browser's IndexedDB frames only fill gaps.
async function repoArchive(season, week) {
  const base = self.__EZ_BASE__ || self.location?.href || '';
  if (!/^https?:/.test(base)) return null;
  try { const r = await realFetch(new URL(`archive/${season}/w${week}.json`, base).href, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function archiveResponse(url) {
  const season = Number(url.searchParams.get('season')), week = Number(url.searchParams.get('week'));
  const repo = await repoArchive(season, week);
  if (repo) {
    const local = await allSnaps().catch(() => []); const have = new Set(repo.snapshots.map(s => s.gameId));
    for (const s of new MiniArchive(local).snapshots(season, week, 'latest')) if (!have.has(s.gameId)) repo.snapshots.push({ ...s, browserOnly: true });
    return new Response(JSON.stringify(repo), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const prep = lastPrep && lastPrep.season === season && lastPrep.week === week ? lastPrep : await prepareData({ season, week });
  const list = await allSnaps().catch(() => []);
  const archive = new MiniArchive(list);
  const ix = buildIndex(prep);
  const cal = calibrationState(archive, prep, ix, season, week);
  const report = tdReport(cal.graded), vol = volumeReport(cal.graded);
  const promo = promotionDecision(cal.graded.filter(r => r.challenger != null), { modelVersion: MODEL_VERSION });
  const body = {
    season, week, modelVersion: MODEL_VERSION,
    snapshots: archive.snapshots(season, week, 'latest'), firstSnapshots: archive.snapshots(season, week, 'first').map(s => ({ gameId: s.gameId, capturedAt: s.capturedAt, modelVersion: s.modelVersion })),
    lessons: Object.fromEntries(Object.entries(cal.lessonsByWeek)), activeCalibration: { active: cal.active, inWeek: cal.inWeek, unplayed: cal.unplayedLessons, describe: describeLessons(cal.active) },
    uncertainty: { errorModel: cal.errorModel, coverage: cal.coverage },
    challenger: { status: cal.challenger.fit ? cal.challenger.kind : 'not fit', reason: cal.challenger.reason, trainingCount: cal.challenger.trainingCount, cutoff: cal.challenger.cutoff, fit: cal.challenger.fit ? { beta: cal.challenger.fit.beta, mu: cal.challenger.fit.mu, sd: cal.challenger.fit.sd, rich: cal.challenger.fit.rich, n: cal.challenger.fit.n, games: cal.challenger.fit.games } : null },
    researchStatus: { summary: summarizeReport(report), volume: vol, promotion: promo }, pickTracker: pickTracker(cal.cur.perWeek), lastRun: null,
    schedule: 'Standalone file: no background refresh. Frames are saved in this browser (IndexedDB) each time you load or refresh before kickoff.',
  };
  // Save pregame frames for unplayed games (first kept, latest updated), strictly before kickoff.
  try {
    const now = Date.now();
    const chFn = cal.challenger.fit ? (p => challengerProbability(cal.challenger, p, null, null)) : null;
    const res = runEngine(prep, { ix, week: prep.week, weights: DEFAULT_WEIGHTS, lessons: cal.active, lessonsUnplayed: cal.unplayedLessons, now, errorModel: cal.errorModel, coverage: cal.coverage, challenger: chFn });
    const meta = { modelVersion: MODEL_VERSION, weights: res.weights, inputTimestamps: Object.fromEntries(Object.entries(prep.sources).map(([k, s]) => [k, s.fetchedAt])), sourceAvailability: Object.fromEntries(Object.entries(prep.sources).map(([k, s]) => [k, s.ok])), lessonsLabel: cal.active.label, challenger: { status: cal.challenger.fit ? cal.challenger.kind : 'not fit', capturedCutoff: new Date(now).toISOString() } };
    const have = new Set(list.map(s => `${s.payload.gameId}:${s.kind}`));
    for (const G of res.games) {
      const kick = Date.parse(G.game.kickoff); if (!(kick > now)) continue;
      const snap = { ...snapshotFromGame(G, meta), capturedAt: new Date(now).toISOString() };
      const rec = k => ({ kind: k, season: snap.season, week: snap.week, kickoff: snap.kickoff, capturedAt: snap.capturedAt, payload: snap });
      if (!have.has(`${snap.gameId}:first`)) await putSnap(`${snap.gameId}:first`, rec('first'));
      await putSnap(`${snap.gameId}:latest`, rec('latest'));
    }
  } catch (e) { body.snapshotError = String(e.message || e); }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
self.fetch = (input, init = {}) => {
  const u = typeof input === 'string' ? input : input.url;
  if (u.startsWith('/api/data')) return Promise.resolve(dataResponse(new URL(u, 'http://sa'), init.signal));
  if (u.startsWith('/api/archive')) return archiveResponse(new URL(u, 'http://sa'));
  return realFetch(input, init);
};
