// app 4.10.0 — walk-forward validation of the play-by-play simulator (src/sim-pbp.js). Research only; writes archive/sim/pbp-validation-2026.json.
//   node scripts/sim/validate-pbp.mjs [--sims 2000] [--no-2025]
// Every week W: play-by-play params refit on plays from weeks < W only (src/pbp-fit.js), the 4.9.2 team fit on drives < W only,
// the model's pre-game snapshot (archive/2026/w<W>/<game>.json) for who plays and projected volumes. Compared:
//   pbp = play-by-play engine; drive = 4.9.2 free drive sim; model = the shipped anytime chance; sleeper = published price.
// Team: points / offensive TDs / margin / total / win log loss, with the closing line as reference (nflverse games.csv).
// Players (W6-W7, settled outcomes): anytime-TD Brier + log loss overall, by position, TE1 (most projected targets among a team's TEs).
// 2025 (tuning season, no snapshots: history-built player inputs): team metrics only, weeks 3-18 — the engine's two
// constants (clock 1.06, red-zone lift 0.2) were set on 2025 league averages before 2026 was scored.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { loadTable, tableToD } from './table.mjs';
import { buildSimInputs, runSim, summarize } from '../../src/sim.js';
import { fitPbp } from '../../src/pbp-fit.js';
import { buildPbpInputs, runPbp, summarizePbp, SIM_PBP_VERSION, SIM_PBP_TUNE } from '../../src/sim-pbp.js';
import { loadPbpSeason } from '../pbp/lib.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const NS = +arg('--sims', 2000); const DO25 = !process.argv.includes('--no-2025');
const r4 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(4);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const mae = (p, a) => mean(p.map((x, i) => Math.abs(x - a[i])));
const corr = (x, y) => { const mx = mean(x), my = mean(y); let a = 0, b = 0, c = 0; for (let i = 0; i < x.length; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; } return b && c ? a / Math.sqrt(b * c) : null; };
async function loadGames() {
  const cache = '/tmp/nflverse-games.csv'; let txt = null;
  try { const r = await fetch('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'); if (r.ok) { txt = await r.text(); fs.writeFileSync(cache, txt); } } catch {}
  if (!txt && fs.existsSync(cache)) txt = fs.readFileSync(cache, 'utf8'); if (!txt) throw new Error('no games.csv');
  const lines = txt.trim().split('\n'); const H = lines[0].split(','); const ix = Object.fromEntries(H.map((h, i) => [h, i])); const out = new Map();
  for (const l of lines.slice(1)) { const c = l.split(','); const s = +c[ix.season]; if (s < 2025 || c[ix.game_type] !== 'REG') continue; const as = c[ix.away_score], hs = c[ix.home_score]; if (as === '' || hs === '') continue;
    out.set(c[ix.game_id], { season: s, week: +c[ix.week], away: c[ix.away_team], home: c[ix.home_team], as: +as, hs: +hs, spread: c[ix.spread_line] === '' ? null : +c[ix.spread_line], total: c[ix.total_line] === '' ? null : +c[ix.total_line] }); }
  return out;
}
const sc = (rows, k) => { const R = rows.filter(r => r[k] != null); const cl = p => Math.min(0.995, Math.max(0.005, p)); return R.length ? { n: R.length, brier: r4(mean(R.map(r => (r[k] - r.y) ** 2))), logLoss: r4(mean(R.map(r => -(r.y ? Math.log(cl(r[k])) : Math.log(1 - cl(r[k])))))), meanP: r4(mean(R.map(r => r[k]))), rate: r4(mean(R.map(r => r.y))) } : null; };
function teamTable(games, K) { const res = {};
  for (const k of K) { const g = games; const tot = g.map(x => x.v[k].a + x.v[k].h), mar = g.map(x => x.v[k].h - x.v[k].a), aT = g.map(x => x.act.as + x.act.hs), aM = g.map(x => x.act.hs - x.act.as);
    const pts = g.flatMap(x => [x.v[k].a, x.v[k].h]), apts = g.flatMap(x => [x.act.as, x.act.hs]); const gt = g.filter(x => x.act.aTd != null);
    const tds = gt.flatMap(x => [x.v[k].aTd, x.v[k].hTd]), atds = gt.flatMap(x => [x.act.aTd, x.act.hTd]); const L = g.filter(x => x.line.total != null && x.line.spread != null);
    const win = g.filter(x => x.act.hs !== x.act.as).map(x => { const p = Math.min(0.99, Math.max(0.01, x.v[k].pHome)); return x.act.hs > x.act.as ? -Math.log(p) : -Math.log(1 - p); });
    res[k] = { games: g.length, teamPtsMAE: r4(mae(pts, apts)), teamPtsBias: r4(mean(pts) - mean(apts)), teamTdMAE: r4(mae(tds, atds)), teamTdBias: r4(mean(tds) - mean(atds)), totalMAE: r4(mae(tot, aT)), totalBias: r4(mean(tot) - mean(aT)), marginMAE: r4(mae(mar, aM)), marginCorr: r4(corr(mar, aM)), winLogLoss: r4(mean(win)),
      totalCorrWithLine: r4(corr(L.map(x => x.v[k].a + x.v[k].h), L.map(x => x.line.total))), marginCorrWithLine: r4(corr(L.map(x => x.v[k].h - x.v[k].a), L.map(x => x.line.spread))) }; }
  { const g = games.filter(x => x.line.total != null && x.line.spread != null); const win = g.filter(x => x.act.hs !== x.act.as).map(x => { const p = Math.min(0.99, Math.max(0.01, 1 / (1 + Math.exp(-x.line.spread / 6.8)))); return x.act.hs > x.act.as ? -Math.log(p) : -Math.log(1 - p); });
    res.closingLine = { games: g.length, totalMAE: r4(mae(g.map(x => x.line.total), g.map(x => x.act.as + x.act.hs))), marginMAE: r4(mae(g.map(x => x.line.spread), g.map(x => x.act.hs - x.act.as))), winLogLoss: r4(mean(win)), note: 'win prob from the closing spread via logistic(spread / 6.8)' }; }
  return res;
}
const tdTable = s => { const T = loadTable(ROOT, s); return { T, tdOf: (W, t) => { const D = tableToD(T, { before: W + 1 }); const g = D.teams[t]?.games.find(x => x.w === W); return g ? g.d.filter(d => d[5] === 'TD').length : null; } }; };
async function season(S, weeks, PB, G, { snapshots }) {
  const { T, tdOf } = tdTable(S); const out = { games: [], players: [] }; const outcomes = {};
  if (snapshots) for (const w of weeks) { const f = path.join(ROOT, 'archive', String(S), `outcomes-w${w}.json`); if (fs.existsSync(f)) Object.assign(outcomes, JSON.parse(fs.readFileSync(f, 'utf8'))); }
  for (const W of weeks) {
    const D = tableToD(T, { before: W }); const PP = fitPbp(PB, { season: S, before: W }); if (PP.through >= W) throw new Error('leak: params see week ' + PP.through);
    const snapDir = path.join(ROOT, 'archive', String(S), `w${W}`);
    for (const gm of [...G.values()].filter(g => g.season === S && g.week === W)) {
      const gid = `${S}_${String(W).padStart(2, '0')}_${gm.away}_${gm.home}`; const sf = path.join(snapDir, `${gid}.json`);
      const P = snapshots && fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')).latest?.payload : null;
      const side = P?.teams?.away ? t => { const k = t === P.teams.away.team ? 'away' : 'home'; return { players: P.players.filter(p => p.team === t), opp: k === 'away' ? P.teams.home.team : P.teams.away.team, teamLambda: P.teams[k].teamLambda, tdBudget: P.teams[k].tdBudget }; } : () => null;
      const In = buildSimInputs(D, { away: gm.away, home: gm.home, sideFor: side, lines: P?.lines || null, gameId: gid }); const Ip = buildPbpInputs(In, PP); if (process.env.DBG) process.stderr.write(gid + ' ');
      const V = { drive: () => summarize(runSim(In, { n: NS, seed: 11, mode: 'free' }), In), pbp: () => summarizePbp(runPbp(Ip, { n: NS, seed: 11 }), Ip) };
      const rec = { gid, w: W, snapshot: !!P, act: { as: gm.as, hs: gm.hs, aTd: tdOf(W, gm.away), hTd: tdOf(W, gm.home) }, line: { spread: gm.spread, total: gm.total }, v: {} }; const pl = {};
      for (const [k, f] of Object.entries(V)) { const s = f(); rec.v[k] = { a: s.team[0].mean.pts, h: s.team[1].mean.pts, aTd: s.team[0].mean.td, hTd: s.team[1].mean.td, pHome: s.win.home + s.win.tie / 2 };
        for (const p of s.players) (pl[p.id] = pl[p.id] || {})[k] = p.anytime; }
      out.games.push(rec);
      if (P) { const te1 = {}; for (const p of P.players) if (p.pos === 'TE') { const v = p.vol?.targets ?? 0; if (!te1[p.team] || v > te1[p.team].v) te1[p.team] = { id: p.id, v }; }
        for (const p of P.players) { const o = outcomes[`${gid}|${p.id}`]?.payload; const x = pl[p.id]; if (!o || !x || (o.status !== 'confirmed' && o.status !== 'confirmed-zero')) continue;
          out.players.push({ gid, w: W, id: p.id, name: p.name, team: p.team, pos: p.pos, te1: te1[p.team]?.id === p.id, y: (o.td || 0) > 0 ? 1 : 0, model: p.chance, sleeper: p.published?.probability ?? null, drive: x.drive, pbp: x.pbp }); } }
      process.stderr.write('.');
    }
    process.stderr.write(`w${W} `);
  }
  return out;
}
function playerTables(rows) { const K = ['model', 'sleeper', 'drive', 'pbp']; const both = rows.filter(r => r.sleeper > 0); const grp = {};
  const add = (name, R) => { grp[name] = { all: Object.fromEntries(K.filter(k => k !== 'sleeper').map(k => [k, sc(R, k)])), withSleeper: Object.fromEntries(K.map(k => [k, sc(R.filter(r => r.sleeper > 0), k)])) }; };
  add('all', rows); for (const pos of ['RB', 'WR', 'TE', 'QB']) add(pos, rows.filter(r => r.pos === pos)); add('TE1', rows.filter(r => r.te1)); return { n: rows.length, withSleeper: both.length, groups: grp }; }
const G = await loadGames();
const PB = [await loadPbpSeason(2025), await loadPbpSeason(2026)];
const t0 = Date.now(); const B26 = await season(2026, [3, 4, 5, 6, 7], PB, G, { snapshots: true }); const ms26 = Date.now() - t0;
const B25 = DO25 ? await season(2025, [3, 5, 7, 9, 11, 13, 15, 17], [PB[0]], G, { snapshots: false }) : null;
const team26 = teamTable(B26.games, ['drive', 'pbp']); const pl26 = playerTables(B26.players); const team25 = B25 ? teamTable(B25.games, ['drive', 'pbp']) : null;
const out = { generated: new Date().toISOString(), simPbpVersion: SIM_PBP_VERSION, tune: SIM_PBP_TUNE, simsPerGame: NS, ms2026: ms26,
  note: 'pbp = play-by-play engine; drive = 4.9.2 free drive sim; model = shipped anytime chance; sleeper = published price. All inputs pre-game: params / team fits from weeks < W only.',
  season2026_w3to7: { team: team26, players_w6to7: pl26 }, season2025_tuning: team25 ? { weeks: [3, 5, 7, 9, 11, 13, 15, 17], team: team25 } : null };
fs.mkdirSync(path.join(ROOT, 'archive', 'sim'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'archive', 'sim', 'pbp-validation-2026.json'), JSON.stringify(out, null, 1));
fs.writeFileSync('/tmp/pbp-validation-detail.json', JSON.stringify({ B26, B25 }));
console.log(JSON.stringify(out, null, 1));
