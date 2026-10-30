// ENDZONE server: static app + API routes. No background refresh schedule exists.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { prepareData, getState } from './prepare.js';
import { isAllowed, request, looksLikeHtml } from './live-feeds.js';
import { Archive } from './archive.js';
import { refresh, calibrationState } from './jobs.js';
import { buildIndex } from '../src/stats-index.js';
import { describeLessons, pickTracker } from '../src/research.js';
import { MODEL_VERSION } from '../src/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.ENDZONE_TOKEN || null; const WRITE_TOKEN = process.env.ENDZONE_WRITE_TOKEN || null; // WRITE_TOKEN: reads public, refresh job protected; // kept in memory only; never logged or sent to the browser
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Storage path: ENDZONE_DB (file) or ENDZONE_DATA_DIR (directory) — e.g. a mounted persistent disk.
export const DEFAULT_DB = process.env.ENDZONE_DB || path.join(process.env.ENDZONE_DATA_DIR || path.join(ROOT, 'data'), 'endzone.sqlite');
export async function createServer({ dbFile = DEFAULT_DB, log = console.log } = {}) {
  const archive = await Archive.open(dbFile);
  const authorized = req => {
    if (!TOKEN) return true;
    const h = req.headers['authorization'] || req.headers['oai-sites-authorization'] || '';
    return h === `Bearer ${TOKEN}`;
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    log(`${new Date().toISOString()} ${req.method} ${url.pathname}`); // path only: no query strings, headers, or tokens
    try {
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') return json(res, 200, { ok: true, modelVersion: MODEL_VERSION, schemaVersion: archive.schemaVersion(), schedule: 'none (manual refresh only)' }); // public liveness probe, no data
        if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
        if (url.pathname === '/api/data' && req.method === 'GET') return apiData(req, res, url);
        if (url.pathname === '/api/feed' && req.method === 'GET') return apiFeed(res, url);
        if (url.pathname === '/api/jobs/refresh' && req.method === 'POST') {
          if (WRITE_TOKEN && (req.headers['authorization'] || '') !== `Bearer ${WRITE_TOKEN}`) return json(res, 401, { error: 'unauthorized' });
          const body = await readBody(req); let parsed; try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'JSON body required' }); }
          const r = await refresh(archive, { season: parsed.season, week: parsed.week });
          return json(res, r.ok ? 200 : 502, r);
        }
        if (url.pathname === '/api/archive' && req.method === 'GET') return apiArchive(res, url);
        if (url.pathname === '/api/health') return json(res, 200, { ok: true, modelVersion: MODEL_VERSION, schemaVersion: archive.schemaVersion(), schedule: 'none (manual refresh only)' });
        return json(res, 404, { error: 'not found' });
      }
      return serveStatic(req, res, url.pathname);
    } catch (e) { log(`error ${url.pathname}: ${e.message}`); if (!res.headersSent) json(res, 500, { error: String(e.message) }); else res.end(); }
  });
  async function apiData(req, res, url) {
    const gz = /gzip/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    const out = gz ? zlib.createGzip() : null; if (out) out.pipe(res);
    const write = obj => { const line = JSON.stringify(obj) + '\n'; if (out) { out.write(line); out.flush(); } else res.write(line); };
    const ctl = new AbortController(); res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
    try {
      const prep = await prepareData({ season: url.searchParams.get('season'), week: url.searchParams.get('week'), force: url.searchParams.get('force') === '1', signal: ctl.signal, onStage: s => write({ type: 'stage', ...s }) });
      write({ type: 'data', data: prep });
    } catch (e) { write({ type: 'error', error: String(e.message || e) }); }
    if (out) out.end(); else res.end();
  }
  async function apiFeed(res, url) {
    const target = url.searchParams.get('url');
    if (!isAllowed(target)) return json(res, 403, { error: 'source not on allowlist' });
    const { res: r, done } = await request(target, { timeoutMs: 60000 });
    try {
      const buf = Buffer.from(await r.arrayBuffer());
      if (!(buf[0] === 0x1f && buf[1] === 0x8b) && looksLikeHtml(buf.subarray(0, 512).toString('utf8'))) return json(res, 502, { error: 'source returned an HTML page' });
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'max-age=300' }); res.end(buf);
    } finally { done(); }
  }
  async function apiArchive(res, url) {
    let season = Number(url.searchParams.get('season')) || null, week = Number(url.searchParams.get('week')) || null;
    if (!season || !week) { const st = await getState(); season = season || Number(st.season); week = week || Number(st.display_week || st.week); }
    const prep = await prepareData({ season, week });
    const ix = buildIndex(prep);
    const cal = calibrationState(archive, prep, ix, season, week);
    const validation = archive.latestExperiment('validation', season, null);
    json(res, 200, {
      season, week, modelVersion: MODEL_VERSION,
      snapshots: archive.snapshots(season, week, 'latest'), firstSnapshots: archive.snapshots(season, week, 'first').map(s => ({ gameId: s.gameId, capturedAt: s.capturedAt, modelVersion: s.modelVersion })),
      lessons: archive.lessons(season), activeCalibration: { active: cal.active, inWeek: cal.inWeek, unplayed: cal.unplayedLessons, describe: describeLessons(cal.active) },
      uncertainty: { errorModel: cal.errorModel, coverage: cal.coverage }, trendHistory: cal.trendHistory,
      challenger: cal.challenger, usage: cal.usage || null, drives: typeof archive.drives === 'function' ? archive.drives(season, week) : null, pbp: typeof archive.pbp === 'function' ? archive.pbp(season, week) : null, simTop4: typeof archive.simTop4 === 'function' ? archive.simTop4(season) : null,
    researchStatus: validation ? validation.payload : null, pickTracker: pickTracker(cal.cur.perWeek), lastRun: archive.lastRun(), schedule: 'Scheduled refreshes are paused: initial load and manual Refresh only.',
    });
  }
  function serveStatic(req, res, p) {
    if (p === '/') p = '/index.html';
    const base = p.startsWith('/src/') ? ROOT : path.join(ROOT, 'public');
    const file = path.normalize(path.join(base, p));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }
  return { server, archive };
}
function readBody(req) { return new Promise((res, rej) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => res(b)); req.on('error', rej); }); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const { server } = await createServer();
  server.listen(port, '0.0.0.0', () => console.log(`ENDZONE listening on http://localhost:${port} (no background refresh schedule; storage ${path.dirname(DEFAULT_DB)})`));
}
