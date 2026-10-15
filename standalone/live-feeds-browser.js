// Live feed access: allowlisted sources, bounded concurrency, retries, timeouts,
// gzip detection by magic bytes, HTML rejection, and streaming CSV projection.
// Browser build of server/live-feeds.js (standalone file): gzip via DecompressionStream, no Node APIs.
import { CsvStream } from '../server/csv.js';

const NFLV = 'https://github.com/nflverse/nflverse-data/releases/download';
export const SOURCES = {
  state: () => 'https://api.sleeper.app/v1/state/nfl',
  schedule: () => 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv',
  scheduleFallback: () => `${NFLV}/schedules/games.csv`,
  players: () => 'https://api.sleeper.app/v1/players/nfl',
  stats: (s, w) => `https://api.sleeper.app/v1/stats/nfl/regular/${s}/${w}`,
  projections: (s, w) => `https://api.sleeper.app/v1/projections/nfl/regular/${s}/${w}`,
  history: s => `${NFLV}/stats_player/stats_player_week_${s}.csv`,
  historyFallback: s => `${NFLV}/player_stats/player_stats_${s}.csv`,
  pbp: s => `${NFLV}/pbp/play_by_play_${s}.csv.gz`,
  idmap: () => `${NFLV}/players/players.csv`,
  roster: s => `${NFLV}/rosters/roster_${s}.csv`,
  snaps: s => `${NFLV}/snap_counts/snap_counts_${s}.csv`,
  ftn: s => `${NFLV}/ftn_charting/ftn_charting_${s}.csv`,
};

// Allowlist for the /api/feed relay: exact supported URL shapes only.
const ALLOW = [
  /^https:\/\/api\.sleeper\.app\/v1\/state\/nfl$/,
  /^https:\/\/api\.sleeper\.app\/v1\/players\/nfl$/,
  /^https:\/\/api\.sleeper\.app\/v1\/(stats|projections)\/nfl\/regular\/20\d\d\/([1-9]|1[0-8])$/,
  /^https:\/\/raw\.githubusercontent\.com\/nflverse\/nfldata\/master\/data\/games\.csv$/,
  /^https:\/\/github\.com\/nflverse\/nflverse-data\/releases\/download\/schedules\/games\.csv$/,
  /^https:\/\/github\.com\/nflverse\/nflverse-data\/releases\/download\/(stats_player\/stats_player_week_|player_stats\/player_stats_|rosters\/roster_|snap_counts\/snap_counts_|ftn_charting\/ftn_charting_)20\d\d\.csv$/,
  /^https:\/\/github\.com\/nflverse\/nflverse-data\/releases\/download\/pbp\/play_by_play_20\d\d\.csv\.gz$/,
  /^https:\/\/github\.com\/nflverse\/nflverse-data\/releases\/download\/players\/players\.csv$/,
];
export function isAllowed(url) {
  if (typeof url !== 'string' || url.length > 300) return false;
  return ALLOW.some(r => r.test(url));
}

export class FeedError extends Error {
  constructor(msg, { status = 0, transient = false, notFound = false } = {}) { super(msg); this.status = status; this.transient = transient; this.notFound = notFound; }
}

// Bounded concurrency semaphore.
let active = 0; const queue = [];
export const MAX_CONCURRENCY = 4;
async function acquire() { if (active < MAX_CONCURRENCY) { active++; return; } await new Promise(r => queue.push(r)); active++; }
function release() { active--; const n = queue.shift(); if (n) n(); }
export function concurrencyState() { return { active, queued: queue.length }; }

export function looksLikeHtml(text) {
  const t = text.slice(0, 512).trimStart().toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html') || t.startsWith('<head') || (t.startsWith('<') && t.includes('<body'));
}
export function isGzip(buf) { return buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b; }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fetchImpl = (...a) => fetch(...a);
export function setFetch(f) { fetchImpl = f || ((...a) => fetch(...a)); }

// Core request with retries. Returns a Response whose status is 2xx; 404 raises notFound.
export async function request(url, { timeoutMs = 45000, retries = 2, signal } = {}) {
  if (url.startsWith('https://github.com/')) retries = 0; // release downloads are CORS-blocked in browsers; fail fast to the bundled copy
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new FeedError('cancelled');
    await acquire();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'follow', mode: 'cors' });
      if (res.status === 404) throw new FeedError(`404 ${url}`, { status: 404, notFound: true });
      if (res.status === 429 || res.status >= 500) throw new FeedError(`HTTP ${res.status}`, { status: res.status, transient: true });
      if (!res.ok) throw new FeedError(`HTTP ${res.status}`, { status: res.status });
      return { res, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); release(); }, ctl };
    } catch (e) {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); release();
      const err = e instanceof FeedError ? e : new FeedError(signal?.aborted ? 'cancelled' : (e.name === 'AbortError' ? `timeout ${url}` : `transport ${e.message}`), { transient: !signal?.aborted });
      lastErr = err;
      if (!err.transient || attempt === retries || signal?.aborted) throw err;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const { res, done } = await request(url, opts);
  try {
    const text = await res.text();
    if (looksLikeHtml(text)) throw new FeedError(`HTML page returned for ${url}`);
    try { return JSON.parse(text); } catch { throw new FeedError(`invalid JSON from ${url}`); }
  } finally { done(); }
}

// Stream a CSV (optionally gzip, detected from bytes) and project each row via mapRow(obj)->value|null.
export async function streamCsv(url, mapRow, opts = {}) {
  const { columns } = opts;
  const { res, done } = await request(url, opts);
  const out = [];
  try {
    const reader = res.body.getReader();
    let first = await reader.read();
    if (first.done) return out;
    const firstBuf = first.value;
    let header = null, idx = null;
    const csv = new CsvStream(r => {
      if (!header) {
        header = r;
        if (columns) idx = columns.map(c => header.indexOf(c));
        return;
      }
      const o = {};
      if (idx) columns.forEach((c, i) => { o[c] = idx[i] >= 0 ? r[idx[i]] : ''; });
      else header.forEach((h, i) => { o[h] = r[i]; });
      const v = mapRow(o);
      if (v != null) out.push(v);
    });
    const decoder = new TextDecoder('utf-8');
    let checkedHtml = false;
    const handleText = t => {
      if (!checkedHtml) { checkedHtml = true; if (looksLikeHtml(t)) throw new FeedError(`HTML page returned for ${url}`); }
      csv.push(t);
    };
    if (isGzip(firstBuf)) {
      const ds = new DecompressionStream('gzip'); const w = ds.writable.getWriter();
      (async () => { try { await w.write(firstBuf); while (true) { const n = await reader.read(); if (n.done) break; await w.write(n.value); } await w.close(); } catch (e) { w.abort(e).catch(() => {}); } })();
      const r2 = ds.readable.getReader();
      while (true) { const n = await r2.read(); if (n.done) break; handleText(decoder.decode(n.value, { stream: true })); }
    } else {
      handleText(decoder.decode(firstBuf, { stream: true }));
      while (true) { const n = await reader.read(); if (n.done) break; handleText(decoder.decode(n.value, { stream: true })); }
    }
    csv.end();
    if (!header) throw new FeedError(`empty CSV ${url}`);
    return out;
  } finally { done(); }
}
