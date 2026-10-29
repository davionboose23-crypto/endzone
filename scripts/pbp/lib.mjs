// app 4.10.0 — compact play table from nflverse play-by-play (Node only; the browser never sees raw pbp).
// One row per regular-season play in game order (scrimmage, kicks, tries, penalties-only "no_play" snaps), with the
// few derived fields the play-by-play simulator needs: seconds until the next snap (clock model) and, for kicks and
// turnovers, where the receiving team's next possession starts (field-position pools). Rosters map gsis -> Sleeper.
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib';
const NFLV = 'https://github.com/nflverse/nflverse-data/releases/download';
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
export const PT = { run: 0, pass: 1, punt: 2, fg: 3, kickoff: 4, xp: 5, two: 6, kneel: 7, spike: 8, noplay: 9 };
// flag bits
export const F = { sack: 1, int: 2, fumLost: 4, cmp: 8, scramble: 16, td: 32, defTd: 64, pen: 128, penDef: 256, pen1st: 512, gtg: 1024, tb: 2048, fgGood: 4096, oob: 8192, safety: 16384, good: 32768, blocked: 65536, toAfter: 131072 };
export const COLS = ['week', 'g', 'off', 'def', 'qtr', 'hs', 'sd', 'down', 'togo', 'yl', 'type', 'yds', 'flags', 'pid', 'tdPid', 'kd', 'next', 'gap', 'penYds', 'home', 'qb'];
async function download(url, file) {
  const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
// minimal RFC-4180 reader over a whole decompressed file, keeping only the requested columns
export function parseCsv(text, want, onRow) {
  let i = 0; const n = text.length; let header = null, idx = null; let row = []; let field = '';
  const endRow = () => {
    if (!header) { header = row; idx = want.map(c => header.indexOf(c)); }
    else if (row.length > 1) { const o = {}; for (let k = 0; k < want.length; k++) o[want[k]] = idx[k] >= 0 ? (row[idx[k]] ?? '') : ''; onRow(o); }
    row = [];
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34) { // quoted
      let j = i + 1; let s = '';
      for (;;) { const q = text.indexOf('"', j); if (q < 0) { s += text.slice(j); j = n; break; } s += text.slice(j, q); if (text.charCodeAt(q + 1) === 34) { s += '"'; j = q + 2; } else { j = q + 1; break; } }
      field = s; i = j; continue;
    }
    if (c === 44) { row.push(field); field = ''; i++; continue; }
    if (c === 10 || c === 13) { row.push(field); field = ''; endRow(); i++; if (c === 13 && text.charCodeAt(i) === 10) i++; continue; }
    let j = i; while (j < n) { const d = text.charCodeAt(j); if (d === 44 || d === 10 || d === 13) break; j++; } field = text.slice(i, j); i = j;
  }
  if (field !== '' || row.length) { row.push(field); endRow(); }
}
const num = v => (v === '' || v == null || v === 'NA' ? NaN : Number(v));
const one = v => v === '1' || v === '1.0' || v === 'TRUE' || v === 'true';
const CSV_COLS = ['game_id', 'week', 'season_type', 'home_team', 'away_team', 'posteam', 'defteam', 'qtr', 'half_seconds_remaining', 'game_seconds_remaining', 'game_half', 'score_differential', 'down', 'ydstogo', 'yardline_100', 'goal_to_go',
  'play_type', 'pass', 'rush', 'sack', 'qb_scramble', 'interception', 'fumble_lost', 'complete_pass', 'yards_gained', 'touchdown', 'td_team', 'td_player_id', 'rusher_player_id', 'receiver_player_id', 'passer_player_id',
  'penalty', 'penalty_team', 'penalty_yards', 'first_down_penalty', 'field_goal_result', 'kick_distance', 'touchback', 'punt_blocked', 'extra_point_result', 'two_point_attempt', 'two_point_conv_result', 'safety', 'out_of_bounds', 'qb_kneel', 'qb_spike', 'timeout'];
// cacheDir: keeps the downloaded .csv.gz files (CI downloads fresh each run when not given)
export async function loadPbpSeason(s, { cacheDir = process.env.ENDZONE_PBP_CACHE || '/tmp/pbp', log = () => {} } = {}) {
  const gz = path.join(cacheDir, `pbp_${s}.csv.gz`), rf = path.join(cacheDir, `roster_${s}.csv`);
  if (!fs.existsSync(gz) || process.env.ENDZONE_PBP_REFRESH) { log(`download pbp ${s}`); await download(`${NFLV}/pbp/play_by_play_${s}.csv.gz`, gz); }
  if (!fs.existsSync(rf) || process.env.ENDZONE_PBP_REFRESH) { log(`download roster ${s}`); await download(`${NFLV}/weekly_rosters/roster_weekly_${s}.csv`, rf); }
  const people = {};
  parseCsv(fs.readFileSync(rf, 'utf8'), ['week', 'team', 'position', 'full_name', 'gsis_id', 'sleeper_id', 'game_type'], o => {
    if (o.game_type !== 'REG' || !o.gsis_id || !SKILL.has(o.position)) return; const w = +o.week; const p = people[o.gsis_id];
    if (!p || w >= p.w) people[o.gsis_id] = { w, name: o.full_name, pos: o.position, team: o.team, sleeper: o.sleeper_id || null };
  });
  const raw = []; parseCsv(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'), CSV_COLS, o => { if (o.season_type === 'REG') raw.push(o); });
  const teams = [...new Set(raw.flatMap(o => [o.home_team, o.away_team]).filter(Boolean))].sort(); const ti = Object.fromEntries(teams.map((t, i) => [t, i]));
  const pids = []; const pix = new Map(); const P = id => { if (!id || id === 'NA') return -1; let i = pix.get(id); if (i == null) { i = pids.length; pids.push(id); pix.set(id, i); } return i; };
  const games = []; const gix = new Map(); const rows = [];
  let cur = null;
  for (const o of raw) {
    const pt = o.play_type; let type = null;
    if (one(o.two_point_attempt)) type = PT.two; else if (pt === 'run') type = one(o.pass) ? PT.pass : PT.run; else if (pt === 'pass') type = PT.pass; else if (pt === 'punt') type = PT.punt; else if (pt === 'field_goal') type = PT.fg;
    else if (pt === 'kickoff') type = PT.kickoff; else if (pt === 'extra_point') type = PT.xp; else if (pt === 'qb_kneel') type = PT.kneel; else if (pt === 'qb_spike') type = PT.spike; else if (pt === 'no_play') type = PT.noplay;
    if (type == null || !o.posteam || o.posteam === 'NA') continue;
    let g = gix.get(o.game_id); if (g == null) { g = games.length; gix.set(o.game_id, g); games.push({ id: o.game_id, week: +o.week, home: o.home_team, away: o.away_team }); }
    let fl = 0; const pen = one(o.penalty);
    if (one(o.sack)) fl |= F.sack; if (one(o.interception)) fl |= F.int; if (one(o.fumble_lost)) fl |= F.fumLost; if (one(o.complete_pass)) fl |= F.cmp; if (one(o.qb_scramble)) fl |= F.scramble;
    if (one(o.touchdown)) { if (o.td_team === o.posteam) fl |= F.td; else fl |= F.defTd; }
    if (pen) { fl |= F.pen; if (o.penalty_team === o.defteam) fl |= F.penDef; if (one(o.first_down_penalty)) fl |= F.pen1st; }
    if (one(o.goal_to_go)) fl |= F.gtg; if (one(o.touchback)) fl |= F.tb; if (o.field_goal_result === 'made') fl |= F.fgGood; if (one(o.out_of_bounds)) fl |= F.oob; if (one(o.safety)) fl |= F.safety;
    if (o.extra_point_result === 'good' || o.two_point_conv_result === 'success') fl |= F.good; if (one(o.punt_blocked) || o.field_goal_result === 'blocked') fl |= F.blocked;
    const yl = num(o.yardline_100); const rid = type === PT.run || (type === PT.pass && (fl & F.scramble)) ? o.rusher_player_id : type === PT.pass && !(fl & F.sack) ? o.receiver_player_id : null;
    const r = { week: +o.week, g, off: ti[o.posteam], def: ti[o.defteam], qtr: +o.qtr, hs: num(o.half_seconds_remaining), gs: num(o.game_seconds_remaining), half: o.game_half, sd: num(o.score_differential) || 0, down: num(o.down) || 0, togo: num(o.ydstogo) || 0,
      yl: Number.isFinite(yl) ? yl : -1, type, yds: num(o.yards_gained) || 0, flags: fl, pid: P(rid), tdPid: (fl & F.td) ? P(o.td_player_id) : -1, kd: num(o.kick_distance) || 0, next: -1, gap: -1, penYds: pen ? (num(o.penalty_yards) || 0) : 0,
      home: o.posteam === o.home_team ? 1 : 0, qb: P(o.passer_player_id || (type === PT.pass && (fl & F.scramble) ? o.rusher_player_id : null)), _to: one(o.timeout) };
    if (cur && cur.g === g && cur.half === r.half) { if (Number.isFinite(cur.gs) && Number.isFinite(r.gs)) cur.gap = Math.max(0, cur.gs - r.gs); }
    if (cur && cur.g === g && cur._to) cur.flags |= F.toAfter;
    rows.push(r); cur = r;
  }
  // next possession start (yards from the receiving team's opponent goal) for kicks / turnovers: first later scrimmage snap
  // of the receiving team in the same game-half (nflverse kickoff rows carry the RECEIVING team as posteam)
  const scrim = t => t === PT.run || t === PT.pass || t === PT.punt || t === PT.fg || t === PT.kneel || t === PT.spike || t === PT.noplay;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const kick = r.type === PT.punt || r.type === PT.kickoff; const to = (r.flags & (F.int | F.fumLost)) || (r.type === PT.fg && !(r.flags & F.fgGood)); if (!kick && !to) continue;
    for (let j = i + 1; j < rows.length && j < i + 8; j++) { const q = rows[j]; if (q.g !== r.g || q.half !== r.half) break; if (!scrim(q.type) || q.yl < 0) continue;
      if (r.type === PT.kickoff ? q.off === r.off : q.off !== r.off) { r.next = q.yl; } break; }
  }
  for (const p of Object.values(people)) delete p.w;
  const used = {}; pids.forEach((id, i) => { if (people[id]) used[i] = people[id]; });
  log(`pbp ${s}: ${rows.length} plays, ${games.length} games, weeks ${games[0]?.week}-${games.at(-1)?.week}`);
  return { kind: 'pbp-table', season: s, teams, games, pids, people: used, cols: COLS, rows: rows.map(r => COLS.map(c => r[c])) };
}
