// Shared schedule/game-context helpers plus the browser feed client
// (staged /api/data stream, last-successful recovery cache, cancellation).
export const DEFAULT_TOTAL = 44.5;
const NORM = { LAR: 'LA', JAC: 'JAX', WSH: 'WAS', OAK: 'LV', SD: 'LAC', STL: 'LA' };
const nt = t => (t ? (NORM[String(t).toUpperCase()] || String(t).toUpperCase()) : t);

function tzOffsetMs(utcMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - utcMs;
}
// Timezone-aware conversion of an Eastern wall-clock kickoff to UTC (DST safe).
export function easternToUtc(dateStr, timeStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '13:00').split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall - tzOffsetMs(wall, 'America/New_York');
  guess = wall - tzOffsetMs(guess, 'America/New_York');
  return new Date(guess).toISOString();
}
const n = v => (v === '' || v == null || v === 'NA' ? null : (Number.isFinite(+v) ? +v : null));
export function parseScheduleRow(o) {
  const awayScore = n(o.away_score), homeScore = n(o.home_score);
  return {
    id: o.game_id, season: +o.season, week: +o.week, weekday: o.weekday, gameday: o.gameday, gametime: o.gametime,
    kickoff: easternToUtc(o.gameday, o.gametime), away: nt(o.away_team), home: nt(o.home_team),
    awayScore, homeScore, finished: awayScore != null && homeScore != null,
    spreadLine: n(o.spread_line), totalLine: n(o.total_line), roof: o.roof || null, surface: o.surface || null,
    temp: n(o.temp), wind: n(o.wind), stadium: o.stadium || null, location: o.location || null, overtime: o.overtime === '1',
  };
}
// Spread is the AWAY number (nflverse spread_line: positive = home favored = away +s).
export function lines(game) {
  const known = game.spreadLine != null && game.totalLine != null;
  const s = game.spreadLine != null ? game.spreadLine : 0;
  const T = game.totalLine != null ? game.totalLine : DEFAULT_TOTAL;
  return { known, spreadKnown: game.spreadLine != null, totalKnown: game.totalLine != null, awaySpread: s, homeSpread: s === 0 ? 0 : -s, total: T, awayImplied: T / 2 - s / 2, homeImplied: T / 2 + s / 2 };
}
export function isIndoor(game) { return game.roof === 'dome' || game.roof === 'closed'; }
export function weather(game) {
  const indoor = isIndoor(game), outdoor = game.roof === 'outdoors' || game.roof === 'open';
  const windKnown = game.wind != null, tempKnown = game.temp != null;
  const harsh = outdoor && ((windKnown && game.wind >= 15) || (tempKnown && game.temp <= 32));
  return { indoor, outdoor, roofKnown: !!game.roof, wind: game.wind, temp: game.temp, windKnown, tempKnown, rushTilt: harsh,
    note: indoor ? 'Indoors: no weather adjustment.' : !outdoor ? 'Roof unknown: no weather adjustment.' : harsh ? `Outdoor ${windKnown && game.wind >= 15 ? `wind ${game.wind} mph` : `temperature ${game.temp}°F`} tilts work toward rushing.` : (windKnown || tempKnown) ? 'Outdoor weather within normal range.' : 'Outdoor weather not yet available; no adjustment.' };
}
export function etDisplay(iso) {
  if (!iso) return { day: '', time: 'TBD' };
  const d = new Date(iso);
  return { day: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }), date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }), time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET' };
}

// ---------------- Browser feed client ----------------
export const STAGES = ['Schedule and closing line', 'Rosters and injuries', 'Red-zone usage', 'Player probabilities'];
const IDB = 'endzone-cache', STORE = 'prepared';
function idb() {
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((res, rej) => { const r = indexedDB.open(IDB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
export async function saveLastSuccessful(key, value) {
  try { const db = await idb(); if (!db) return; await new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put({ value, savedAt: new Date().toISOString() }, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch { /* recovery cache is best effort */ }
}
export async function loadLastSuccessful(key) {
  try { const db = await idb(); if (!db) return null; return await new Promise((res, rej) => { const t = db.transaction(STORE, 'readonly'); const r = t.objectStore(STORE).get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); }); } catch { return null; }
}
// Streams NDJSON stage events from /api/data and resolves with the prepared payload.
export async function fetchPrepared({ season, week, force, signal, onStage, fetchFn = fetch, base = '' }) {
  const qs = new URLSearchParams(); if (season) qs.set('season', season); if (week) qs.set('week', week); if (force) qs.set('force', '1');
  const res = await fetchFn(`${base}/api/data?${qs}`, { signal });
  if (!res.ok) throw new Error(`Data service HTTP ${res.status}`);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let data = null; let err = null;
  const handle = line => {
    if (!line.trim()) return;
    let m; try { m = JSON.parse(line); } catch { throw new Error('Data service returned non-JSON content'); }
    if (m.type === 'stage') onStage?.(m); else if (m.type === 'data') data = m.data; else if (m.type === 'error') err = m.error;
  };
  while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } }
  handle(buf);
  if (err) throw new Error(err);
  if (!data) throw new Error('Data stream ended without a slate');
  return data;
}

// Guards against an older worker response replacing a newer request.
export function requestGate() { let latest = 0; return { next() { latest += 1000; return latest; }, isCurrent(id) { return id === latest; }, get latest() { return latest; } }; }
