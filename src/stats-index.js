// Indexes prepared feeds into per-player/team/defense lookups. Every query takes
// an as-of (season, week) cutoff so features never use the selected game's results.
import { normTeam } from './roster.js';

export const before = (row, season, week) => row.season < season || (row.season === season && row.week < week);

export function buildIndex(prep) {
  const gamesById = new Map(prep.games.map(g => [g.id, g]));
  const gameByTeamWeek = new Map();
  for (const g of prep.games) { gameByTeamWeek.set(`${g.season}|${g.week}|${g.away}`, g); gameByTeamWeek.set(`${g.season}|${g.week}|${g.home}`, g); }
  const C = prep.logCols; const ci = Object.fromEntries(C.map((c, i) => [c, i]));
  const logsByGsis = new Map(); const nflvWeeks = new Set(); const posByGsis = new Map();
  const mk = (o) => { o.td = o.rushTd + o.recTd; o.touches = o.carries + o.targets; return o; };
  for (const r of prep.logs || []) {
    const o = {}; C.forEach((c, i) => { o[c] = r[i]; });
    o.team = normTeam(o.team); o.opp = normTeam(o.opp); o.src = 'nflverse';
    const g = gamesById.get(o.gameId) || gameByTeamWeek.get(`${o.season}|${o.week}|${o.team}`);
    if (g) { o.gameId = g.id; o.home = g.location === 'Neutral' ? null : g.home === o.team; if (!o.opp) o.opp = g.home === o.team ? g.away : g.home; } else o.home = null;
    if (o.season === prep.season) nflvWeeks.add(o.week);
    mk(o);
    if (!logsByGsis.has(o.gsis)) logsByGsis.set(o.gsis, []);
    logsByGsis.get(o.gsis).push(o); posByGsis.set(o.gsis, o.pos);
  }
  // zone rows
  const Z = prep.zoneCols || []; const zi = Object.fromEntries(Z.map((c, i) => [c, i]));
  const zonesByGsis = new Map(); const teamZones = new Map(); // team -> [{week,gameId,path,bin,looks,scores,opp,gsis}]
  const zoneWeeks = new Set();
  for (const r of prep.zones || []) {
    const o = {}; Z.forEach((c, i) => { o[c] = r[i]; }); o.team = normTeam(o.team); o.opp = normTeam(o.opp); o.season = prep.season;
    zoneWeeks.add(o.week);
    if (!zonesByGsis.has(o.gsis)) zonesByGsis.set(o.gsis, []);
    zonesByGsis.get(o.gsis).push(o);
    if (!teamZones.has(o.team)) teamZones.set(o.team, []);
    teamZones.get(o.team).push(o);
  }
  const zoneGameSet = new Set(prep.zoneGames || []);
  // snaps (pfr -> gsis via roster/idmap)
  const pfrToGsis = new Map();
  for (const r of prep.idmap || []) if (r.pfr && r.gsis) pfrToGsis.set(r.pfr, r.gsis);
  for (const r of prep.roster || []) if (r.pfr && r.gsis) pfrToGsis.set(r.pfr, r.gsis);
  const snapsByGsis = new Map(); const snapsByPfr = new Map(); const teamSnapGames = new Map();
  for (const r of prep.snaps || []) {
    const [pfr, week, gameId, team, offSnaps, offPct, name] = r;
    const o = { pfr, week, gameId, team: normTeam(team), offSnaps, offPct, name, season: prep.season };
    const g = pfrToGsis.get(pfr);
    const key = g || `pfr:${pfr}`;
    if (!snapsByGsis.has(key)) snapsByGsis.set(key, []);
    snapsByGsis.get(key).push(o);
  }
  return { prep, season: prep.season, gamesById, gameByTeamWeek, logsByGsis, posByGsis, nflvWeeks, zonesByGsis, teamZones, zoneWeeks, zoneGameSet, snapsByGsis, pfrToGsis, weekly: prep.weekly || {} };
}

// Current-season logs (and prior season separately) for a player, using nflverse
// rows and Sleeper weekly stats for current-season weeks nflverse has not published.
export function playerLogs(ix, player, season, week) {
  const own = (player.gsis && ix.logsByGsis.get(player.gsis)) || [];
  const out = own.filter(r => before(r, season, week)).map(r => ({ ...r }));
  if (season === ix.season) {
    for (let w = 1; w < week; w++) {
      if (ix.nflvWeeks.has(w)) continue;
      const s = ix.weekly[w]?.stats?.[player.id];
      if (!s) continue;
      const g = ix.gameByTeamWeek.get(`${season}|${w}|${player.team}`);
      if (!g || !g.finished) continue;
      out.push(sleeperLog(s, player, g, season, w));
    }
  }
  // Snap enrichment
  const sn = (player.gsis && ix.snapsByGsis.get(player.gsis)) || (player.pfr && ix.snapsByGsis.get(`pfr:${player.pfr}`)) || [];
  for (const r of out) {
    if (r.season !== ix.season) continue;
    const s = sn.find(x => x.week === r.week);
    const sl = ix.weekly[r.week]?.stats?.[player.id];
    if (s) { r.offSnaps = s.offSnaps; r.offPct = s.offPct; }
    else if (sl?.off_snp) { r.offSnaps = sl.off_snp; r.offPct = sl.tm_off_snp ? sl.off_snp / sl.tm_off_snp : null; }
    if (sl) { r.slRzRush = sl.rush_rz_att || 0; r.slRzTgt = sl.rec_rz_tgt || 0; r.slRzPass = sl.pass_rz_att || 0; }
  }
  return out.sort((a, b) => a.season - b.season || a.week - b.week);
}
export function sleeperLog(s, player, g, season, w) {
  const o = { gsis: player.gsis, name: player.name, pos: player.pos, season, week: w, gameId: g.id, team: player.team, opp: g.home === player.team ? g.away : g.home,
    home: g.location === 'Neutral' ? null : g.home === player.team,
    carries: s.rush_att || 0, rushYd: s.rush_yd || 0, rushTd: s.rush_td || 0, targets: s.rec_tgt || 0, rec: s.rec || 0, recYd: s.rec_yd || 0, airYd: s.rec_air_yd || 0, yac: s.rec_yac || s.rec_yar || 0, recTd: s.rec_td || 0,
    att: s.pass_att || 0, cmp: s.pass_cmp || 0, passYd: s.pass_yd || 0, passTd: s.pass_td || 0, src: 'sleeper' };
  o.td = o.rushTd + o.recTd; o.touches = o.carries + o.targets; return o;
}
export const played = r => (r.carries + r.targets + r.att) > 0 || (r.offSnaps || 0) > 0;

export function zoneRows(ix, player, season, week) {
  if (season !== ix.season || !player.gsis) return [];
  return (ix.zonesByGsis.get(player.gsis) || []).filter(z => z.week < week);
}
export function teamZoneRows(ix, team, season, week) {
  if (season !== ix.season) return [];
  return (ix.teamZones.get(team) || []).filter(z => z.week < week);
}
// All current-season skill rows before week (for defense/team aggregates).
export function allLogsBefore(ix, season, week) {
  const out = [];
  for (const arr of ix.logsByGsis.values()) for (const r of arr) if (r.season === season && r.week < week) out.push(r);
  if (season === ix.season) {
    const idPos = new Map((ix.prep.players || []).map(p => [p.id, p]));
    for (let w = 1; w < week; w++) {
      if (ix.nflvWeeks.has(w)) continue;
      for (const [id, s] of Object.entries(ix.weekly[w]?.stats || {})) {
        const p = idPos.get(id); if (!p || !p.team) continue;
        const g = ix.gameByTeamWeek.get(`${season}|${w}|${p.team}`); if (!g || !g.finished) continue;
        out.push(sleeperLog(s, p, g, season, w));
      }
    }
  }
  return out;
}
