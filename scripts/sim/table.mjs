// 4.9.2: rebuild the sim's drive-file shape ({ teams: { T: { people, games: [{ w, opp, d }] } } }) from the season drive table,
// so walk-forward checks can use exactly the drives that existed before any week (and 2025, which has no weekly drive files).
import fs from 'node:fs'; import path from 'node:path';
const RES = { Touchdown: 'TD', 'Field goal': 'FG', 'Missed field goal': 'MFG', Punt: 'Punt', Turnover: 'TO', 'Turnover on downs': 'Downs', 'End of half': 'Half', 'Opp touchdown': 'TO', Safety: 'Safety' };
export function loadTable(root, season) { return JSON.parse(fs.readFileSync(path.join(root, 'archive', 'drives', String(season), 'table.json'), 'utf8')); }
// before: only weeks < before
export function tableToD(T, { before = Infinity } = {}) {
  const C = Object.fromEntries(T.cols.drives.map((c, i) => [c, i])), PC = Object.fromEntries(T.cols.players.map((c, i) => [c, i]));
  const people = new Map(Array.isArray(T.people) ? T.people : Object.entries(T.people));
  const byDrive = new Map(); for (const r of T.players) { const a = byDrive.get(r[PC.d]) || []; a.push(r); byDrive.set(r[PC.d], a); }
  const teams = {}; const games = new Map();
  T.drives.forEach((d, di) => { if (!(d[C.week] < before)) return; const t = d[C.team];
    const TT = teams[t] || (teams[t] = { people: [], idx: {}, games: [] }); const key = `${d[C.game]}|${t}`;
    let g = games.get(key); if (!g) { g = { w: d[C.week], opp: d[C.opp], game: d[C.game], d: [] }; games.set(key, g); TT.games.push(g); }
    const pi = pid => { if (TT.idx[pid] == null) { const pe = people.get(pid) || {}; TT.idx[pid] = TT.people.length; TT.people.push([pid, pe.name || pid, pe.pos || null, pe.sleeper || null]); } return TT.idx[pid]; };
    const pl = (byDrive.get(di) || []).filter(r => r[PC.tgt] || r[PC.car]).map(r => [pi(r[PC.pid]), r[PC.tgt], r[PC.rec], r[PC.recYd], r[PC.car], r[PC.rushYd], r[PC.rz], r[PC.td]]);
    g.d.push([d[C.n], d[C.half], d[C.sd], d[C.flags], d[C.plays], RES[d[C.result]] || d[C.result], d[C.tgt], d[C.car], pl, d[C.qtr], d[C.yl]]);
  });
  for (const TT of Object.values(teams)) { delete TT.idx; TT.games.sort((a, b) => a.w - b.w); for (const g of TT.games) g.d.sort((a, b) => a[0] - b[0]); }
  return { teams };
}
