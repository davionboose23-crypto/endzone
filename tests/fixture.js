// Deterministic synthetic prepared dataset for unit/acceptance tests (never used by the app).
import { easternToUtc } from '../src/feeds.js';
export function rng(seed = 7) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
export const TEAMS = ['KC', 'BUF', 'MIA', 'NYJ'];
const ROLES = [['QB', 1], ['QB', 2], ['RB', 1], ['RB', 2], ['RB', 3], ['WR', 1], ['WR', 2], ['WR', 3], ['TE', 1], ['FB', 1]];
const BASE = { QB1: { att: 34, car: 3, rz: 0.6 }, QB2: { att: 0, car: 0, rz: 0 }, RB1: { car: 16, tgt: 3, rz: 3 }, RB2: { car: 8, tgt: 2, rz: 1.2 }, RB3: { car: 2, tgt: 0.5, rz: 0.2 },
  WR1: { tgt: 8, rz: 1.2 }, WR2: { tgt: 6, rz: 0.8 }, WR3: { tgt: 4, rz: 0.5 }, TE1: { tgt: 5, rz: 1.1 }, FB1: { tgt: 0.6, car: 0.5, rz: 0.1 } };
export function makeFixture({ season = 2030, week = 5, seed = 11, mutate } = {}) {
  const r = rng(seed); const pois = m => { let L = Math.exp(-m), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; };
  const games = [];
  const pairs = [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2], [1, 0, 3, 2], [3, 0, 2, 1]];
  for (let w = 1; w <= 5; w++) {
    const [a, b, c, d] = pairs[w - 1];
    const sunday = new Date(Date.UTC(season, 8, 7 + 7 * (w - 1))).toISOString().slice(0, 10);
    const monday = new Date(Date.UTC(season, 8, 8 + 7 * (w - 1))).toISOString().slice(0, 10);
    games.push({ id: `${season}_0${w}_${TEAMS[a]}_${TEAMS[b]}`, season, week: w, weekday: 'Sunday', gameday: sunday, gametime: '13:00', kickoff: easternToUtc(sunday, '13:00'), away: TEAMS[a], home: TEAMS[b], awayScore: null, homeScore: null, finished: false, spreadLine: 3, totalLine: 47.5, roof: 'outdoors', temp: 60, wind: 5, stadium: 'Field A', location: 'Home' });
    games.push({ id: `${season}_0${w}_${TEAMS[c]}_${TEAMS[d]}`, season, week: w, weekday: 'Monday', gameday: monday, gametime: '20:15', kickoff: easternToUtc(monday, '20:15'), away: TEAMS[c], home: TEAMS[d], awayScore: null, homeScore: null, finished: false, spreadLine: -9.5, totalLine: 41.5, roof: 'dome', temp: null, wind: null, stadium: 'Dome B', location: 'Home' });
  }
  const players = [], roster = [], idmap = [];
  let id = 1000;
  for (const t of TEAMS) for (const [pos, rank] of ROLES) {
    const pid = String(id++); const gsis = `00-${pid}`;
    const p = { id: pid, name: `${t} ${pos}${rank}`, first: t, last: `${pos}${rank}`, pos, team: t, gsis, espn: String(9000 + +pid), depth: rank, depthPos: pos, injury: null, practice: null, status: 'Active', active: true };
    players.push(p); roster.push({ gsis, sleeper: pid, espn: p.espn, pfr: `P${pid}`, name: p.name, pos, team: t, status: 'ACT', week: 4 }); idmap.push({ gsis, espn: p.espn, pfr: `P${pid}`, name: p.name, pos, team: t });
  }
  const logs = [], zones = [], snaps = [], zoneGames = [];
  const weekly = {};
  for (let w = 1; w <= week; w++) weekly[w] = { stats: {}, proj: {}, statsOk: true, projOk: true };
  const playedWeeks = [1, 2, 3, 4];
  const emit = (g, w) => {
    zoneGames.push(g.id);
    for (const [team, opp] of [[g.away, g.home], [g.home, g.away]]) for (const p of players.filter(x => x.team === team)) {
      const role = `${p.pos}${p.depth}`; const b = BASE[role] || {};
      const car = pois(b.car || 0), tgt = pois(b.tgt || 0), att = b.att ? Math.round(b.att + (r() - 0.5) * 8) : 0;
      const rec = Math.round(tgt * 0.65), rushYd = Math.round(car * (3.5 + r() * 2)), recYd = Math.round(rec * (8 + r() * 6));
      // zones
      let rushTd = 0, recTd = 0;
      const rzr = pois((b.rz || 0) * (p.pos === 'RB' || p.pos === 'QB' || p.pos === 'FB' ? 1 : 0)), rzt = pois((b.rz || 0) * (p.pos === 'WR' || p.pos === 'TE' ? 1 : p.pos === 'RB' ? 0.2 : 0));
      const bins = { r: [0, 0, 0, 0], rs: [0, 0, 0, 0], t: [0, 0, 0, 0], ts: [0, 0, 0, 0] };
      for (let i = 0; i < rzr; i++) { const bin = r() < 0.35 ? 1 : r() < 0.5 ? 2 : 3; bins.r[bin]++; if (r() < [0, 0.45, 0.3, 0.02][bin]) { bins.rs[bin]++; rushTd++; } }
      for (let i = 0; i < rzt; i++) { const bin = r() < 0.25 ? 1 : r() < 0.5 ? 2 : 3; bins.t[bin]++; if (r() < [0, 0.5, 0.45, 0.08][bin]) { bins.ts[bin]++; recTd++; } }
      bins.r[0] = Math.max(0, car - rzr); bins.t[0] = Math.max(0, tgt - rzt);
      for (const path of ['r', 't']) for (let bin = 0; bin <= 3; bin++) if (bins[path][bin]) zones.push([p.gsis, w, g.id, team, opp, path, bin, bins[path][bin], bins[path + 's'][bin], bins[path][bin] * [25, 3, 8, 15][bin], bins[path][bin] * 5, 0, 0, 0, 0, 0]);
      const passTd = p.pos === 'QB' && p.depth === 1 ? pois(1.5) : 0;
      if (car + tgt + att > 0) logs.push([p.gsis, p.name, p.pos, season, w, g.id, team, opp, car, rushYd, rushTd, tgt, rec, recYd, recYd * 0.6, recYd * 0.4, recTd, att, Math.round(att * 0.64), att * 7, passTd]);
      snaps.push([`P${p.id}`, w, g.id, team, car + tgt + att > 0 ? 20 + car + tgt : 0, 0.5, p.name]);
      weekly[w].proj[p.id] = { rush_att: b.car || 0, rec_tgt: b.tgt || 0, pass_att: b.att || 0, rush_td: (b.rz || 0) * 0.12, rec_td: (b.tgt || 0) * 0.04 };
    }
    g.awayScore = 20; g.homeScore = 17; g.finished = true;
  };
  for (const g of games) if (playedWeeks.includes(g.week)) emit(g, g.week);
  for (const p of players) weekly[week].proj[p.id] = weekly[week].proj[p.id] || { rush_att: (BASE[`${p.pos}${p.depth}`]?.car || 0), rec_tgt: BASE[`${p.pos}${p.depth}`]?.tgt || 0, pass_att: BASE[`${p.pos}${p.depth}`]?.att || 0, rush_td: 0.2, rec_td: 0.1 };
  const prep = { version: 1, season, week, currentWeek: week, state: { season: String(season), week }, generatedAt: new Date().toISOString(),
    sources: { schedule: { label: 'fixture schedule', ok: true, optional: false } }, games, players, roster, idmap, weekly, logs,
    logCols: ['gsis', 'name', 'pos', 'season', 'week', 'gameId', 'team', 'opp', 'carries', 'rushYd', 'rushTd', 'targets', 'rec', 'recYd', 'airYd', 'yac', 'recTd', 'att', 'cmp', 'passYd', 'passTd'],
    zones, zoneGames, zoneCols: ['gsis', 'week', 'gameId', 'team', 'opp', 'path', 'bin', 'looks', 'scores', 'sumYl', 'sumYtg', 'endzone', 'catchable', 'contested', 'sneaks', 'charted'],
    snaps, snapCols: ['pfr', 'week', 'gameId', 'team', 'offSnaps', 'offPct', 'name'], charting: false };
  prep._emit = emit; // lets tests finish a week-5 game with results
  if (mutate) mutate(prep);
  return prep;
}
export const byName = (res, name) => { for (const G of res.games) for (const s of ['away', 'home']) { const p = G.sides[s].raw.find(x => x.name === name); if (p) return { G, s, p }; } return null; };
