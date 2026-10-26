// Drive-level table from nflverse play-by-play (Node). One row per team-game-drive (drive attributes at the
// drive's first snap) plus one row per player-drive (targets, receptions, rec yds, carries, rush yds, red-zone and
// inside-10 touches, TDs). Weekly rosters supply names / positions / Sleeper ids. Strictly a historical table:
// pattern detection (src/drive-patterns.js) only ever reads drives from games before the target week.
import { streamCsv } from '../../server/live-feeds.js';
const NFLV = 'https://github.com/nflverse/nflverse-data/releases/download';
const opt = { timeoutMs: 300000, retries: 2 };
const num = v => (v === '' || v == null || v === 'NA' ? NaN : Number(v));
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
const one = v => v === '1' || v === '1.0' || v === 'TRUE' || v === 'true';
// drive columns: [season, week, game, team, opp, n (team drive #), fixed_drive, qtr, half(1|2|3=OT), sd (score diff at start, offense view),
//   startYL (yards from opp goal), result, flags, plays, tgt, car]; flags bitmask below
export const DCOLS = ['season', 'week', 'game', 'team', 'opp', 'n', 'fd', 'qtr', 'half', 'sd', 'yl', 'result', 'flags', 'plays', 'tgt', 'car'];
export const PCOLS = ['d', 'pid', 'tgt', 'rec', 'recYd', 'car', 'rushYd', 'rz', 'i10', 'td'];
export const FLAG = { first2H: 1, twoMin: 2, rz: 4, gtg: 8 };
export async function loadDriveSeason(s, log = () => {}) {
  const people = {};
  await streamCsv(`${NFLV}/weekly_rosters/roster_weekly_${s}.csv`, o => {
    if (o.game_type !== 'REG' || !o.gsis_id || !SKILL.has(o.position)) return null;
    const w = +o.week; const p = people[o.gsis_id];
    if (!p || w >= p.w) people[o.gsis_id] = { w, name: o.full_name, pos: o.position, team: o.team, sleeper: o.sleeper_id || null };
    return null;
  }, { ...opt, columns: ['week', 'team', 'position', 'full_name', 'gsis_id', 'sleeper_id', 'game_type'] });
  const drives = new Map(), pd = new Map();
  const cols = ['game_id', 'week', 'season_type', 'posteam', 'defteam', 'fixed_drive', 'fixed_drive_result', 'qtr', 'game_half', 'score_differential', 'yardline_100', 'half_seconds_remaining', 'goal_to_go',
    'rush', 'pass', 'sack', 'rusher_player_id', 'receiver_player_id', 'complete_pass', 'rushing_yards', 'receiving_yards', 'rush_touchdown', 'pass_touchdown', 'td_player_id', 'td_team', 'two_point_attempt', 'qb_kneel', 'qb_spike', 'play_type'];
  await streamCsv(`${NFLV}/pbp/play_by_play_${s}.csv.gz`, o => {
    if (o.season_type !== 'REG' || !o.posteam || !o.fixed_drive || o.fixed_drive === 'NA') return null;
    if (o.play_type === 'kickoff' || o.play_type === 'extra_point' || one(o.two_point_attempt)) return null;
    const key = `${o.game_id}|${+o.fixed_drive}`; const y = num(o.yardline_100); let D = drives.get(key);
    if (!D) {
      const half = o.game_half === 'Half1' ? 1 : o.game_half === 'Half2' ? 2 : 3;
      D = { season: s, week: +o.week, game: o.game_id, team: o.posteam, opp: o.defteam, n: 0, fd: +o.fixed_drive, qtr: +o.qtr, half, sd: num(o.score_differential) || 0, yl: Number.isFinite(y) ? y : null,
        result: o.fixed_drive_result || '', flags: 0, plays: 0, tgt: 0, car: 0 };
      drives.set(key, D);
    }
    if (o.posteam !== D.team) return null;
    const rush = one(o.rush), pass = one(o.pass); if (!rush && !pass) return null;
    if (one(o.qb_kneel) || one(o.qb_spike)) return null;
    D.plays++;
    const hs = num(o.half_seconds_remaining); if (D.half < 3 && hs <= 120) D.flags |= FLAG.twoMin;
    if (y <= 20) D.flags |= FLAG.rz; if (one(o.goal_to_go)) D.flags |= FLAG.gtg;
    const P = pid => { const k = `${key}|${pid}`; let r = pd.get(k); if (!r) { r = { key, pid, tgt: 0, rec: 0, recYd: 0, car: 0, rushYd: 0, rz: 0, i10: 0, td: 0 }; pd.set(k, r); } return r; };
    if (rush && o.rusher_player_id) { const r = P(o.rusher_player_id); r.car++; D.car++; r.rushYd += num(o.rushing_yards) || 0; if (y <= 20) r.rz++; if (y <= 10) r.i10++; }
    if (pass && !one(o.sack) && o.receiver_player_id) { const r = P(o.receiver_player_id); r.tgt++; D.tgt++; if (one(o.complete_pass)) { r.rec++; r.recYd += num(o.receiving_yards) || 0; } if (y <= 20) r.rz++; if (y <= 10) r.i10++; }
    if ((one(o.rush_touchdown) || one(o.pass_touchdown)) && o.td_player_id && o.td_team === D.team) P(o.td_player_id).td++;
    return null;
  }, { ...opt, columns: cols });
  // team drive numbers, first drive after halftime (offense view; drives with no offensive snap still count as possessions)
  const byTG = new Map(); for (const D of drives.values()) { const k = `${D.game}|${D.team}`; if (!byTG.has(k)) byTG.set(k, []); byTG.get(k).push(D); }
  for (const L of byTG.values()) { L.sort((a, b) => a.fd - b.fd); L.forEach((D, i) => { D.n = i + 1; }); const f = L.find(D => D.half === 2); if (f) f.flags |= FLAG.first2H; }
  const list = [...drives.values()].sort((a, b) => a.week - b.week || (a.game < b.game ? -1 : a.game > b.game ? 1 : 0) || a.fd - b.fd);
  const idx = new Map(list.map((D, i) => [`${D.game}|${D.fd}`, i]));
  const players = [...pd.values()].map(r => [idx.get(r.key), r.pid, r.tgt, r.rec, r.recYd, r.car, r.rushYd, r.rz, r.i10, r.td]).sort((a, b) => a[0] - b[0]);
  log(`drives ${s}: ${list.length} drives, ${players.length} player-drives, weeks ${Math.min(...list.map(d => d.week))}-${Math.max(...list.map(d => d.week))}`);
  for (const p of Object.values(people)) delete p.w;
  return { kind: 'drive-table', version: 1, season: s, cols: { drives: DCOLS, players: PCOLS }, weeks: [...new Set(list.map(d => d.week))].sort((a, b) => a - b),
    drives: list.map(D => DCOLS.map(c => D[c])), players, people };
}
