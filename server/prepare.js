// Builds the compact "prepared" dataset streamed by /api/data. Large CSVs are
// streamed and projected; raw play-by-play is never retained.
import { SOURCES, fetchJson, streamCsv } from './live-feeds.js';
import { FeedCache } from './feed-cache.js';
import { normTeam } from '../src/roster.js';
import { parseScheduleRow } from '../src/feeds.js';

export const cache = new FeedCache();
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
const num = v => { if (v === '' || v == null || v === 'NA') return 0; const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isTrue = v => v === '1' || v === 'TRUE' || v === 'true' || v === '1.0';

function src(sources, key, label, url, optional, r) {
  sources[key] = { label, url, optional, ok: !r.error || r.stale, fetchedAt: r.fetchedAt ? new Date(r.fetchedAt).toISOString() : null, stale: !!r.stale, error: r.error || null, rows: r.rows ?? null, ...(r.bundled ? { bundled: true } : {}) };
}
async function load(sources, key, label, url, optional, loader, force) {
  try {
    const r = await cache.get(url, loader, { force });
    const rows = Array.isArray(r.value) ? r.value.length : (r.value && typeof r.value === 'object' ? Object.keys(r.value).length : null);
    src(sources, key, label, url, optional, { ...r, rows });
    return r.value;
  } catch (e) {
    sources[key] = { label, url, optional, ok: false, notFound: !!e.notFound, fetchedAt: null, stale: false, error: String(e.message || e), rows: 0 };
    return null;
  }
}

export async function getState(force = false) {
  const r = await cache.get(SOURCES.state(), () => fetchJson(SOURCES.state(), { timeoutMs: 15000 }), { force });
  return { ...r.value, fetchedAt: new Date(r.fetchedAt).toISOString(), stale: r.stale };
}

export async function prepareData({ season, week, force = false, onStage = () => {}, signal } = {}) {
  const sources = {};
  const opt = { signal };
  // ---- Stage 1: schedule and closing line
  onStage({ stage: 1, label: 'Schedule and closing line' });
  let state = null;
  try { state = await getState(force); sources.state = { label: 'Sleeper NFL state', url: SOURCES.state(), ok: true, optional: false, fetchedAt: state.fetchedAt, stale: state.stale }; }
  catch (e) { sources.state = { label: 'Sleeper NFL state', url: SOURCES.state(), ok: false, optional: false, error: String(e.message) }; }
  season = Number(season || state?.season || state?.league_season);
  if (!season) throw new Error('Season unknown: Sleeper state unavailable and no season given');
  const currentWeek = state && String(state.season) === String(season) ? Math.min(18, Math.max(1, Number(state.display_week || state.week) || 1)) : 18;
  week = Math.min(18, Math.max(1, Number(week || currentWeek)));
  const schedLoader = url => () => streamCsv(url, o => (o.game_type === 'REG' && (+o.season === season || +o.season === season - 1)) ? parseScheduleRow(o) : null, { ...opt, timeoutMs: 60000 });
  let games = await load(sources, 'schedule', 'nflverse schedule (nfldata)', SOURCES.schedule(), false, schedLoader(SOURCES.schedule()), force);
  if (!games || !games.length) {
    games = await load(sources, 'scheduleFallback', 'nflverse schedule (release fallback)', SOURCES.scheduleFallback(), false, schedLoader(SOURCES.scheduleFallback()), force);
  }
  if (!games || !games.length) throw new Error('Schedule unavailable from primary and fallback sources');
  onStage({ stage: 1, done: true, games: games.filter(g => g.season === season && g.week === week).length });

  // ---- Stage 2: rosters, injuries, weekly Sleeper stats/projections
  onStage({ stage: 2, label: 'Rosters and injuries' });
  const sleeperRaw = await load(sources, 'players', 'Sleeper players', SOURCES.players(), false, async () => {
    const all = await fetchJson(SOURCES.players(), { ...opt, timeoutMs: 60000 });
    const out = [];
    for (const p of Object.values(all)) {
      const pos = p.position === 'FB' ? 'FB' : (p.position || (p.fantasy_positions || [])[0]);
      if (!SKILL.has(pos)) continue;
      out.push({ id: String(p.player_id), name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' '), first: p.first_name, last: p.last_name, pos,
        team: p.team ? normTeam(p.team) : null, gsis: p.gsis_id ? String(p.gsis_id).trim() : null, espn: p.espn_id ? String(p.espn_id) : null,
        depth: p.depth_chart_order ?? null, exp: p.years_exp ?? null, depthPos: p.depth_chart_position || null, injury: p.injury_status || null, practice: p.practice_participation || null,
        injuryNotes: p.injury_notes || null, injuryBody: p.injury_body_part || null, status: p.status || null, active: !!p.active, age: p.age ?? null, yearsExp: p.years_exp ?? null, number: p.number ?? null,
        newsUpdated: p.news_updated || null });
    }
    return out;
  }, force);
  const skillIds = new Set((sleeperRaw || []).map(p => p.id));
  const STAT_KEYS = ['rush_att', 'rush_yd', 'rush_td', 'rec_tgt', 'rec', 'rec_yd', 'rec_td', 'rec_air_yd', 'rec_yac', 'rec_yar', 'pass_att', 'pass_cmp', 'pass_yd', 'pass_td', 'rush_rz_att', 'rec_rz_tgt', 'pass_rz_att', 'off_snp', 'tm_off_snp', 'gp'];
  const PROJ_KEYS = ['rush_att', 'rush_yd', 'rush_td', 'rec_tgt', 'rec', 'rec_yd', 'rec_td', 'pass_att', 'pass_cmp', 'pass_yd', 'pass_td'];
  const pick = (obj, keys) => { const o = {}; let any = false; for (const k of keys) if (obj[k] != null && obj[k] !== 0) { o[k] = obj[k]; any = true; } return any ? o : null; };
  const weekly = {};
  await Promise.all(Array.from({ length: week }, (_, i) => i + 1).map(async w => {
    const mk = (kind, keys) => async () => {
      try {
        const raw = await fetchJson(SOURCES[kind](season, w), { ...opt, timeoutMs: 30000 });
        const out = {};
        const entries = Array.isArray(raw) ? raw.map(x => [x.player_id, x.stats || {}]) : Object.entries(raw || {});
        for (const [id, s] of entries) if (skillIds.has(String(id))) { const v = pick(s, keys); if (v) out[id] = v; }
        return out;
      } catch (e) { if (e.notFound) return {}; throw e; } // 404 week => empty map
    };
    const st = await load(sources, `stats_${w}`, `Sleeper stats week ${w}`, SOURCES.stats(season, w), true, mk('stats', STAT_KEYS), force && w >= week - 1);
    const pr = await load(sources, `proj_${w}`, `Sleeper projections week ${w}`, SOURCES.projections(season, w), true, mk('projections', PROJ_KEYS), force && w >= week - 1);
    weekly[w] = { stats: st || {}, proj: pr || {}, statsOk: !!st, projOk: !!pr };
  }));
  const rosterRows = await load(sources, 'roster', `nflverse rosters ${season}`, SOURCES.roster(season), true, async () => {
    const latest = new Map();
    await streamCsv(SOURCES.roster(season), o => {
      if (!SKILL.has(o.position) && !SKILL.has(o.depth_chart_position)) return null;
      const w = num(o.week); const key = o.gsis_id || `${o.full_name}|${o.position}`;
      const prev = latest.get(key);
      if (!prev || w >= prev.week) latest.set(key, { gsis: o.gsis_id || null, sleeper: o.sleeper_id || null, espn: o.espn_id || null, pfr: o.pfr_id || null, name: o.full_name, pos: o.position, team: normTeam(o.team), status: o.status, statusAbbr: o.status_description_abbr, week: w, depthPos: o.depth_chart_position });
      return null;
    }, { ...opt, timeoutMs: 60000 });
    return [...latest.values()];
  }, force);
  const idmap = await load(sources, 'idmap', 'nflverse player ID map', SOURCES.idmap(), true, () => streamCsv(SOURCES.idmap(), o => {
    if (!SKILL.has(o.position) && !SKILL.has(o.position_group)) return null;
    return { gsis: o.gsis_id, espn: o.espn_id || null, pfr: o.pfr_id || null, name: o.display_name, pos: o.position, team: o.latest_team ? normTeam(o.latest_team) : null, status: o.status, lastSeason: num(o.last_season) };
  }, { ...opt, timeoutMs: 90000 }), force);
  onStage({ stage: 2, done: true, players: sleeperRaw?.length || 0 });

  // ---- Stage 3: red-zone usage and history
  onStage({ stage: 3, label: 'Red-zone usage' });
  const HCOLS = ['player_id', 'player_display_name', 'position', 'season', 'week', 'season_type', 'game_id', 'team', 'opponent_team', 'completions', 'attempts', 'passing_yards', 'passing_tds', 'carries', 'rushing_yards', 'rushing_tds', 'receptions', 'targets', 'receiving_yards', 'receiving_tds', 'receiving_air_yards', 'receiving_yards_after_catch', 'recent_team', 'opponent'];
  const histMap = o => {
    if ((o.season_type || 'REG') !== 'REG' || !SKILL.has(o.position)) return null;
    return [o.player_id, o.player_display_name, o.position, num(o.season), num(o.week), o.game_id || '', normTeam(o.team || o.recent_team), normTeam(o.opponent_team || o.opponent),
      num(o.carries), num(o.rushing_yards), num(o.rushing_tds), num(o.targets), num(o.receptions), num(o.receiving_yards), num(o.receiving_air_yards), num(o.receiving_yards_after_catch), num(o.receiving_tds),
      num(o.attempts), num(o.completions), num(o.passing_yards), num(o.passing_tds)];
  };
  const logs = [];
  for (const s of [season, season - 1]) {
    let rows = await load(sources, `history_${s}`, `nflverse weekly stats ${s}`, SOURCES.history(s), true, () => streamCsv(SOURCES.history(s), histMap, { ...opt, columns: HCOLS, timeoutMs: 90000 }), force && s === season);
    if (!rows) rows = await load(sources, `historyFb_${s}`, `nflverse player_stats ${s} (fallback)`, SOURCES.historyFallback(s), true, () => streamCsv(SOURCES.historyFallback(s), histMap, { ...opt, columns: HCOLS, timeoutMs: 90000 }), force && s === season);
    if (rows) logs.push(...rows);
  }
  const ftn = await load(sources, 'ftn', `FTN charting ${season} (FTN Data via nflverse, CC-BY-SA 4.0)`, SOURCES.ftn(season), true, async () => {
    const m = {};
    await streamCsv(SOURCES.ftn(season), o => {
      const bits = (isTrue(o.is_catchable_ball) ? 1 : 0) | (isTrue(o.is_contested_ball) ? 2 : 0) | (isTrue(o.is_qb_sneak) ? 4 : 0) | 8;
      m[`${o.nflverse_game_id}#${o.nflverse_play_id}`] = bits; return null;
    }, { ...opt, columns: ['nflverse_game_id', 'nflverse_play_id', 'is_catchable_ball', 'is_contested_ball', 'is_qb_sneak'], timeoutMs: 45000 });
    return m;
  }, force);
  const PCOLS = ['game_id', 'play_id', 'season_type', 'week', 'posteam', 'defteam', 'yardline_100', 'ydstogo', 'play_type', 'qb_kneel', 'air_yards', 'td_player_id', 'rush_touchdown', 'pass_touchdown', 'two_point_attempt', 'passer_player_id', 'receiver_player_id', 'rusher_player_id', 'play_deleted', 'sack', 'qb_scramble'];
  const zones = await load(sources, 'pbp', `nflverse play-by-play ${season}`, SOURCES.pbp(season), true, async () => {
    const agg = new Map(); const gamesSeen = new Set();
    const add = (gid, wk, team, opp, pid, path, bin, scored, yl, ytg, ez, bits) => {
      const k = `${gid}|${pid}|${path}|${bin}`;
      let a = agg.get(k);
      if (!a) { a = [pid, wk, gid, team, opp, path, bin, 0, 0, 0, 0, 0, 0, 0, 0, 0]; agg.set(k, a); }
      a[7]++; if (scored) a[8]++; a[9] += yl; a[10] += ytg; if (ez) a[11]++;
      if (bits & 8) { a[15]++; if (bits & 1) a[12]++; if (bits & 2) a[13]++; if (bits & 4) a[14]++; }
    };
    await streamCsv(SOURCES.pbp(season), o => {
      if (o.season_type !== 'REG') return null;
      if (o.play_deleted === '1' || o.qb_kneel === '1' || o.two_point_attempt === '1') return null;
      if (o.play_type !== 'run' && o.play_type !== 'pass') return null; // excludes no_play (nullified)
      const yl = num(o.yardline_100); if (!yl) return null;
      const bin = yl <= 5 ? 1 : yl <= 10 ? 2 : yl <= 20 ? 3 : 0;
      const gid = o.game_id, wk = num(o.week), team = normTeam(o.posteam), opp = normTeam(o.defteam);
      gamesSeen.add(gid);
      const bits = ftn ? (ftn[`${gid}#${o.play_id}`] || 0) : 0;
      if (o.play_type === 'run' && o.rusher_player_id && o.rusher_player_id !== 'NA') {
        add(gid, wk, team, opp, o.rusher_player_id, 'r', bin, o.rush_touchdown === '1' && o.td_player_id === o.rusher_player_id, yl, num(o.ydstogo), false, bits);
      } else if (o.play_type === 'pass' && o.sack !== '1') {
        if (o.receiver_player_id && o.receiver_player_id !== 'NA') add(gid, wk, team, opp, o.receiver_player_id, 't', bin, o.pass_touchdown === '1' && o.td_player_id === o.receiver_player_id, yl, num(o.ydstogo), num(o.air_yards) >= yl, bits);
        if (o.passer_player_id && o.passer_player_id !== 'NA' && o.qb_scramble !== '1') add(gid, wk, team, opp, o.passer_player_id, 'p', bin, o.pass_touchdown === '1', yl, num(o.ydstogo), false, 0);
      }
      return null;
    }, { ...opt, columns: PCOLS, timeoutMs: 120000 });
    return { rows: [...agg.values()], games: [...gamesSeen] };
  }, force);
  const snaps = await load(sources, 'snaps', `nflverse snap counts ${season}`, SOURCES.snaps(season), true, () => streamCsv(SOURCES.snaps(season), o => {
    if (o.game_type !== 'REG' || !SKILL.has(o.position)) return null;
    return [o.pfr_player_id, num(o.week), o.game_id, normTeam(o.team), num(o.offense_snaps), num(o.offense_pct), o.player];
  }, { ...opt, timeoutMs: 45000 }), force);
  onStage({ stage: 3, done: true });
  const fetchedAt = new Date().toISOString();
  return {
    version: 1, season, week, currentWeek, state, generatedAt: fetchedAt, sources,
    games, players: sleeperRaw || [], roster: rosterRows, idmap, weekly, logs,
    logCols: ['gsis', 'name', 'pos', 'season', 'week', 'gameId', 'team', 'opp', 'carries', 'rushYd', 'rushTd', 'targets', 'rec', 'recYd', 'airYd', 'yac', 'recTd', 'att', 'cmp', 'passYd', 'passTd'],
    zones: zones ? zones.rows : null, zoneGames: zones ? zones.games : [],
    zoneCols: ['gsis', 'week', 'gameId', 'team', 'opp', 'path', 'bin', 'looks', 'scores', 'sumYl', 'sumYtg', 'endzone', 'catchable', 'contested', 'sneaks', 'charted'],
    snaps, snapCols: ['pfr', 'week', 'gameId', 'team', 'offSnaps', 'offPct', 'name'],
    charting: !!ftn,
  };
}
