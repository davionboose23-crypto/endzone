// app 4.14.0: nflverse weekly rosters as the backtests' pre-game roster (team + status), merged with the injury report.
// rosterWeek(S, W) -> rosterNow map like the live app's (gsis -> [team, injury, practice, status, pos, name]):
//   ACT / INA -> on the team (INA = game-day inactive, not known before the inactives list, so treated as available);
//   RES -> Injured Reserve (excluded); DEV -> practice squad (excluded); CUT / RET / other -> no team (dropped).
// poolOf(S, W, team) -> the scoring pool: that team's QB/RB/WR/TE/FB with status ACT or INA (pre-game roster, not post-game stat lines).
import fs from 'node:fs';
const splitCsv = l => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
const csv = txt => { const L = txt.trim().split('\n'); const H = splitCsv(L[0]); return L.slice(1).map(l => { const a = splitCsv(l); return Object.fromEntries(H.map((h, i) => [h, a[i]])); }); };
const RW = {}, INJ = {};
const rows = S => RW[S] || (RW[S] = csv(fs.readFileSync(`/tmp/nfl_roster_weekly_${S}.csv`, 'utf8')).filter(r => r.gsis_id && (r.game_type === 'REG' || !r.game_type)));
const injOf = S => { if (INJ[S]) return INJ[S]; const m = new Map(); for (const r of csv(fs.readFileSync(`/tmp/nfl_injuries_${S}.csv`, 'utf8'))) if (r.game_type === 'REG' || !r.game_type) m.set(`${r.week}|${r.gsis_id}`, r); return (INJ[S] = m); };
const SK = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
const prac = r => { const pr = (r?.practice_status || '').toLowerCase(); return pr.includes('did not') ? 'DNP' : pr.includes('limited') ? 'Limited' : pr.includes('full') ? 'Full' : ''; };
export function rosterWeek(S, W, full = true) { const o = {}; const I = injOf(S);
  if (full) for (const r of rows(S)) { if (+r.week !== W) continue; const st = r.status; const tm = st === 'ACT' || st === 'INA' || st === 'RES' || st === 'DEV' ? r.team : 'FA';
    const status = st === 'RES' ? 'Injured Reserve' : st === 'DEV' ? 'Inactive (practice squad)' : null; const ij = I.get(`${W}|${r.gsis_id}`);
    o[r.gsis_id] = [tm, ij?.report_status || null, prac(ij), status, r.position === 'HB' ? 'RB' : r.position, r.full_name, r.years_exp === '' ? null : +r.years_exp]; }
  for (const [k, r] of I) { const [w, g] = k.split('|'); if (+w !== W || !r.report_status || o[g]) continue; o[g] = [null, r.report_status, prac(r), null, null, null]; } // 4.13.1 behaviour when !full
  return o; }
export function poolOf(S, W, team) { const m = new Map(); for (const r of rows(S)) if (+r.week === W && r.team === team && (r.status === 'ACT' || r.status === 'INA') && SK.has(r.position)) m.set(r.gsis_id, { pos: r.position === 'FB' ? 'RB' : r.position, name: r.full_name, st: r.status }); return m; }
