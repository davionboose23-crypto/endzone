// app 4.9.2 — walk-forward validation of the team-style simulator. Research only; writes archive/sim/team-validation-<s>.json.
//   node scripts/sim/validate-teams.mjs [--sims 2000] [--skip-sims]
// Part A (analytic, every game): for each week W the team fit sees only drives from weeks < W of the same season, then
//   predicts week W. Compared: league average (no team identity) / raw team rates as 4.9.1 used them (shrunk, NOT
//   opponent-adjusted) / the 4.9.2 opponent-adjusted ridge fit. Hyper-parameters are picked on 2025 only; 2026 is out of sample.
// Part B (full simulations, 2026 W3-W7): old 4.9.1 sim (git 36a97f3) vs 4.9.2 free vs 4.9.2 anchored vs league-average
//   free, on team points / TDs / totals / margins (actual and closing lines from nflverse games.csv) and, where pre-game
//   model snapshots + settled outcomes exist (W6-W7), player anytime-TD Brier / log loss vs the model and Sleeper.
import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTable, tableToD } from './table.mjs';
import { teamStrength, matchup, TS_DEFAULTS, TS_VERSION } from '../../src/team-strength.js';
import { leaguePriors, mixIdx, RESULTS, buildSimInputs, runSim, summarize, SIM_VERSION } from '../../src/sim.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const NS = +arg('--sims', 2000); const SKIP = process.argv.includes('--skip-sims');
const r4 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(4);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const mae = (p, a) => mean(p.map((x, i) => Math.abs(x - a[i])));
const corr = (x, y) => { const mx = mean(x), my = mean(y); let a = 0, b = 0, c = 0; for (let i = 0; i < x.length; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; } return b && c ? a / Math.sqrt(b * c) : null; };

// ---- actual scores + closing lines (nflverse)
async function loadGames() {
  const cache = '/tmp/nflverse-games.csv'; let txt = null;
  try { const r = await fetch('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'); if (r.ok) { txt = await r.text(); fs.writeFileSync(cache, txt); } } catch {}
  if (!txt && fs.existsSync(cache)) txt = fs.readFileSync(cache, 'utf8'); if (!txt) throw new Error('no games.csv');
  const lines = txt.trim().split('\n'); const H = lines[0].split(','); const ix = Object.fromEntries(H.map((h, i) => [h, i])); const out = new Map();
  for (const l of lines.slice(1)) { const c = l.split(','); const s = +c[ix.season]; if (s < 2025) continue; if (c[ix.game_type] !== 'REG') continue;
    const as = c[ix.away_score], hs = c[ix.home_score]; if (as === '' || hs === '') continue;
    out.set(c[ix.game_id], { season: s, week: +c[ix.week], away: c[ix.away_team], home: c[ix.home_team], as: +as, hs: +hs, spread: c[ix.spread_line] === '' ? null : +c[ix.spread_line], total: c[ix.total_line] === '' ? null : +c[ix.total_line] }); }
  return out; // spread_line > 0 = home favoured by that many
}
const fix = t => t; // team codes already match (LA, LV, ...)

// ---- Part A
const PTS = { TD: 6.95, FG: 3 }; // TD incl. average extra point / 2-pt
function partA(T, season, weeks, G, opts, keep = false) {
  const rows = []; const Dall = tableToD(T);
  for (const W of weeks) {
    const D = tableToD(T, { before: W }); const TS = teamStrength(D, opts); const L = leaguePriors(D);
    const offDpg = {}, defDpg = {}; for (const [t, TT] of Object.entries(D.teams)) { for (const g of TT.games) { (offDpg[t] = offDpg[t] || []).push(g.d.length); (defDpg[g.opp] = defDpg[g.opp] || []).push(g.d.length); } }
    const LA = matchup(TS, '__none', '__none');
    for (const [t, TT] of Object.entries(Dall.teams)) for (const g of TT.games) { if (g.w !== W) continue;
      const NEW = matchup(TS, t, g.opp);
      const oi = mixIdx(L.off[t], L), di = mixIdx(L.def[g.opp], L);
      const rawMix = [0, 1, 2, 3].map(b => { const base = L.bucket[b]; const p = base.map((v, r) => r === 6 || r === 7 ? v : v * Math.sqrt(oi[r] * di[r])); const s = p.reduce((a, x) => a + x, 0); return p.map(x => x / s); });
      const od = offDpg[t] ? mean(offDpg[t]) : L.dpg, dd = defDpg[g.opp] ? mean(defDpg[g.opp]) : L.dpg; const rawDpg = 0.7 * (od + dd) / 2 + 0.3 * L.dpg;
      const V = { league: { mix: LA.mix, dpg: LA.dpg }, raw: { mix: rawMix, dpg: rawDpg }, adjusted: { mix: NEW.mix, dpg: NEW.dpg } };
      const act = { td: 0, fg: 0, drives: g.d.length }; const out = { season, w: W, team: t, opp: g.opp, game: g.game, act, v: {} };
      for (const d of g.d) { if (d[5] === 'TD') act.td++; if (d[5] === 'FG') act.fg++; }
      for (const [k, v] of Object.entries(V)) {
        let ll = 0, br = 0, eTd = 0, eFg = 0; for (const d of g.d) { const b = d[3] & 2 ? 1 : (d[9] >= 4 && d[2] >= 9) ? 2 : (d[9] >= 4 && d[2] <= -9) ? 3 : 0; const p = v.mix[b]; const r = RESULTS.indexOf(d[5]);
          ll -= Math.log(Math.max(1e-4, p[r])); br += (p[0] - (r === 0 ? 1 : 0)) ** 2; eTd += p[0]; eFg += p[1]; }
        // pre-game expectation (drive count unknown): league game-state mix weights
        const pd = [0, 1, 2, 3].reduce((s, b) => s + TS.league.bShare[b] * v.mix[b][0], 0), pf = [0, 1, 2, 3].reduce((s, b) => s + TS.league.bShare[b] * v.mix[b][1], 0);
        out.v[k] = { ll, br, n: g.d.length, eTdGiven: eTd, preTd: pd * v.dpg, prePts: v.dpg * (pd * PTS.TD + pf * PTS.FG) };
      }
      rows.push(out); }
  }
  // game-level (both teams) with real scores + lines
  const games = new Map(); for (const r of rows) { const gm = G.get(r.game); if (!gm) continue; const e = games.get(r.game) || { gm, sides: {} }; e.sides[r.team === gm.home ? 'home' : 'away'] = r; games.set(r.game, e); }
  const res = {};
  for (const k of ['league', 'raw', 'adjusted']) {
    const nd = rows.reduce((s, r) => s + r.v[k].n, 0);
    const tdP = rows.map(r => r.v[k].preTd), tdA = rows.map(r => r.act.td), tdG = rows.map(r => r.v[k].eTdGiven);
    const gl = [...games.values()].filter(e => e.sides.home && e.sides.away);
    const predTot = gl.map(e => e.sides.home.v[k].prePts + e.sides.away.v[k].prePts), predMar = gl.map(e => e.sides.home.v[k].prePts - e.sides.away.v[k].prePts);
    const actTot = gl.map(e => e.gm.hs + e.gm.as), actMar = gl.map(e => e.gm.hs - e.gm.as);
    const ptsP = gl.flatMap(e => [e.sides.home.v[k].prePts, e.sides.away.v[k].prePts]), ptsA = gl.flatMap(e => [e.gm.hs, e.gm.as]);
    const bias = mean(ptsP) - mean(ptsA); // the drive-only points proxy misses defensive / return TDs: score totals after removing the season-wide mean gap would be in-sample, so report both
    const L2 = gl.filter(e => e.gm.total != null && e.gm.spread != null);
    const pt = L2.map(e => e.sides.home.v[k].prePts + e.sides.away.v[k].prePts), pm = L2.map(e => e.sides.home.v[k].prePts - e.sides.away.v[k].prePts);
    res[k] = { drives: nd, driveLogLoss: r4(rows.reduce((s, r) => s + r.v[k].ll, 0) / nd), tdDriveBrier: r4(rows.reduce((s, r) => s + r.v[k].br, 0) / nd),
      teamTdMAE_pregame: r4(mae(tdP, tdA)), teamTdMAE_givenDrives: r4(mae(tdG, tdA)), teamTdCorr_pregame: r4(corr(tdP, tdA)),
      games: gl.length, teamPtsMAE: r4(mae(ptsP, ptsA)), teamPtsBias: r4(bias), teamPtsCorr: r4(corr(ptsP, ptsA)),
      totalMAE: r4(mae(predTot, actTot)), totalCorr: r4(corr(predTot, actTot)), marginMAE: r4(mae(predMar, actMar)), marginCorr: r4(corr(predMar, actMar)),
      vsLines: { games: L2.length, totalCorrWithLine: r4(corr(pt, L2.map(e => e.gm.total))), marginCorrWithLine: r4(corr(pm, L2.map(e => e.gm.spread))),
        lineTotalMAE: r4(mae(L2.map(e => e.gm.total), L2.map(e => e.gm.hs + e.gm.as))), lineMarginMAE: r4(mae(L2.map(e => e.gm.spread), L2.map(e => e.gm.hs - e.gm.as))),
        // does the sim's disagreement with the line point the right way?  corr(pred - line, actual - line)
        totalEdgeCorr: r4(corr(pt.map((x, i) => x - L2[i].gm.total), L2.map(e => e.gm.hs + e.gm.as - e.gm.total))),
        marginEdgeCorr: r4(corr(pm.map((x, i) => x - L2[i].gm.spread), L2.map(e => e.gm.hs - e.gm.as - e.gm.spread))) } };
  }
  return keep ? { res, rows } : { res };
}

// ---- Part B
async function partB(T26, G, opts) {
  const old = path.join('/tmp', 'endzone-sim-491.mjs'); fs.writeFileSync(old, execSync('git show 36a97f3:src/sim.js', { cwd: ROOT }));
  const OLD = await import(pathToFileURL(old).href);
  const out = { games: [], players: [] }; const outcomes = {};
  for (const w of [6, 7]) { const f = path.join(ROOT, 'archive', '2026', `outcomes-w${w}.json`); if (fs.existsSync(f)) Object.assign(outcomes, JSON.parse(fs.readFileSync(f, 'utf8'))); }
  for (const W of [3, 4, 5, 6, 7, 8]) {
    const D = tableToD(T26, { before: W });
    // old engine expects offense / defense drives per game in the drive file
    D.offense = {}; D.defense = {}; const acc = (o, t, n) => { const x = o[t] || (o[t] = { g: 0, d: 0 }); x.g++; x.d += n; };
    for (const [t, TT] of Object.entries(D.teams)) for (const g of TT.games) { acc(D.offense, t, g.d.length); acc(D.defense, g.opp, g.d.length); }
    for (const o of [D.offense, D.defense]) for (const x of Object.values(o)) x.dpg = x.d / x.g;
    const snapDir = path.join(ROOT, 'archive', '2026', `w${W}`); const snaps = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter(f => f.endsWith('.json')) : [];
    const games = [...G.values()].filter(g => g.season === 2026 && g.week === W);
    for (const gm of games) {
      const gid = `2026_${String(W).padStart(2, '0')}_${gm.away}_${gm.home}`; const sf = snaps.find(f => f === `${gid}.json`);
      const P = sf ? JSON.parse(fs.readFileSync(path.join(snapDir, sf), 'utf8')).latest?.payload : null;
      const side = P?.teams?.away ? t => { const k = t === P.teams.away.team ? 'away' : 'home'; return { players: P.players.filter(p => p.team === t), opp: k === 'away' ? P.teams.home.team : P.teams.away.team, teamLambda: P.teams[k].teamLambda, tdBudget: P.teams[k].tdBudget }; } : () => null;
      const args = { away: gm.away, home: gm.home, sideFor: side, lines: P?.lines || null, gameId: gid };
      const In = buildSimInputs(D, { ...args, tsOpts: opts }); const Io = OLD.buildSimInputs(D, args);
      const Ilg = { ...In, teams: In.teams.map(t => { const m = matchup(teamStrength(D, opts), '__none', '__none'); return { ...t, mix: m.mix, pf: m.pf, ppdF: 1, dpg: m.dpg }; }) }; Ilg.targetDrives = Ilg.teams[0].dpg;
      const V = { old491: () => OLD.summarize(OLD.runSim(Io, { n: NS, seed: 11 }), Io), free: () => summarize(runSim(In, { n: NS, seed: 11, mode: 'free' }), In), anchored: () => summarize(runSim(In, { n: NS, seed: 11, mode: 'anchored' }), { ...In, mode: 'anchored' }), leagueFree: () => summarize(runSim(Ilg, { n: NS, seed: 11, mode: 'free' }), Ilg) };
      const rec = { gid, w: W, snapshot: !!P, act: { as: gm.as, hs: gm.hs }, line: { spread: gm.spread, total: gm.total }, v: {} }; const pl = {};
      for (const [k, f] of Object.entries(V)) { const s = f(); rec.v[k] = { a: s.team[0].mean.pts, h: s.team[1].mean.pts, aTd: s.team[0].mean.td, hTd: s.team[1].mean.td, pHome: s.win.home + s.win.tie / 2 };
        for (const p of s.players) { (pl[p.id] = pl[p.id] || { id: p.id, team: p.team, name: p.name, model: p.model.chance })[k] = p.anytime; } }
      // actual offensive TDs from the drive table (W <= 7)
      const Dn = tableToD(T26, { before: W + 1 }); const tdOf = t => { const g = Dn.teams[t]?.games.find(x => x.w === W); return g ? g.d.filter(d => d[5] === 'TD').length : null; };
      rec.act.aTd = tdOf(gm.away); rec.act.hTd = tdOf(gm.home); out.games.push(rec);
      if (P) for (const p of P.players) { const o = outcomes[`${gid}|${p.id}`]?.payload; const x = pl[p.id]; if (!o || !x || (o.status !== 'confirmed' && o.status !== 'confirmed-zero')) continue;
        out.players.push({ gid, id: p.id, name: p.name, y: (o.td || 0) > 0 ? 1 : 0, model: p.chance, sleeper: p.published?.probability ?? null, old491: x.old491, free: x.free, anchored: x.anchored, leagueFree: x.leagueFree }); }
      process.stderr.write(`.`);
    }
  }
  const K = ['old491', 'free', 'anchored', 'leagueFree']; const res = { team: {}, players: {} };
  for (const k of K) { const g = out.games; const tot = g.map(x => x.v[k].a + x.v[k].h), mar = g.map(x => x.v[k].h - x.v[k].a), aT = g.map(x => x.act.as + x.act.hs), aM = g.map(x => x.act.hs - x.act.as);
    const pts = g.flatMap(x => [x.v[k].a, x.v[k].h]), apts = g.flatMap(x => [x.act.as, x.act.hs]); const gt = g.filter(x => x.act.aTd != null);
    const tds = gt.flatMap(x => [x.v[k].aTd, x.v[k].hTd]), atds = gt.flatMap(x => [x.act.aTd, x.act.hTd]);
    const L = g.filter(x => x.line.total != null && x.line.spread != null);
    const win = g.filter(x => x.act.hs !== x.act.as).map(x => { const p = Math.min(0.99, Math.max(0.01, x.v[k].pHome)); return x.act.hs > x.act.as ? -Math.log(p) : -Math.log(1 - p); });
    res.team[k] = { games: g.length, teamPtsMAE: r4(mae(pts, apts)), teamPtsBias: r4(mean(pts) - mean(apts)), teamTdMAE: r4(mae(tds, atds)), teamTdBias: r4(mean(tds) - mean(atds)), totalMAE: r4(mae(tot, aT)), marginMAE: r4(mae(mar, aM)), marginCorr: r4(corr(mar, aM)), winLogLoss: r4(mean(win)),
      totalEdgeCorr: r4(corr(L.map(x => x.v[k].a + x.v[k].h - x.line.total), L.map(x => x.act.as + x.act.hs - x.line.total))), marginEdgeCorr: r4(corr(L.map(x => x.v[k].h - x.v[k].a - x.line.spread), L.map(x => x.act.hs - x.act.as - x.line.spread))),
      totalCorrWithLine: r4(corr(L.map(x => x.v[k].a + x.v[k].h), L.map(x => x.line.total))), marginCorrWithLine: r4(corr(L.map(x => x.v[k].h - x.v[k].a), L.map(x => x.line.spread))) };
  }
  { const g = out.games.filter(x => x.line.total != null && x.line.spread != null); res.team.closingLine = { games: g.length, totalMAE: r4(mae(g.map(x => x.line.total), g.map(x => x.act.as + x.act.hs))), marginMAE: r4(mae(g.map(x => x.line.spread), g.map(x => x.act.hs - x.act.as))) }; }
  const sc = (rows, k) => { const R = rows.filter(r => r[k] != null); const cl = p => Math.min(0.995, Math.max(0.005, p)); return { n: R.length, brier: r4(mean(R.map(r => (r[k] - r.y) ** 2))), logLoss: r4(mean(R.map(r => -(r.y ? Math.log(cl(r[k])) : Math.log(1 - cl(r[k])))))), meanP: r4(mean(R.map(r => r[k]))), rate: r4(mean(R.map(r => r.y))) }; };
  const all = out.players; const both = all.filter(r => r.sleeper > 0);
  for (const k of ['model', 'sleeper', ...K]) res.players[k] = { all: k === 'sleeper' ? null : sc(all, k), withSleeper: sc(both, k) };
  return { res, detail: out };
}

const G = await loadGames();
const T25 = loadTable(ROOT, 2025), T26 = loadTable(ROOT, 2026);
// tune on 2025 only
const grid = []; for (const halfLife of [3, 6, Infinity]) for (const kMix of [3, 8, 20]) { const o = { halfLife, kMix }; const a = partA(T25, 2025, [3, 5, 7, 9, 11, 13, 15, 17], G, o).res.adjusted; grid.push({ halfLife: Number.isFinite(halfLife) ? halfLife : null, kMix, driveLogLoss: a.driveLogLoss, teamTdMAE: a.teamTdMAE_pregame }); process.stderr.write('g'); }
grid.sort((a, b) => a.driveLogLoss - b.driveLogLoss); const best = { halfLife: grid[0].halfLife ?? Infinity, kMix: grid[0].kMix };
const A25 = partA(T25, 2025, Array.from({ length: 16 }, (_, i) => i + 3), G, best).res;
const A26 = partA(T26, 2026, [3, 4, 5, 6, 7], G, best).res; const A26def = partA(T26, 2026, [3, 4, 5, 6, 7], G, {}).res;
const B = SKIP ? null : await partB(T26, G, {});
const out = { generated: new Date().toISOString(), simVersion: SIM_VERSION, tsVersion: TS_VERSION, tsDefaults: { ...TS_DEFAULTS }, simsPerGame: NS,
  tuning: { note: 'grid on 2025 walk-forward weeks 3,5,...,17 only (drive-outcome log loss)', grid, best: { halfLife: grid[0].halfLife, kMix: grid[0].kMix } },
  partA: { note: 'analytic, every game; team fit sees weeks < W only. raw = 4.9.1-style shrunk team rates (k=60) without schedule adjustment; adjusted = 4.9.2 ridge fit. Points = drives x (TD 6.95 + FG 3): offence-only proxy, so defensive / return scores make the bias negative.', season2025_w3to18: A25, season2026_w3to7_tuned: A26, season2026_w3to7_shippedDefaults: A26def },
  partB: B ? { note: '2026 W3-W7 full sims. old491 = git 36a97f3 engine (TD rate pinned to model λ when a snapshot exists, else to a history λ); free = 4.9.2 default; anchored = 4.9.2 inputs with the 4.9.1 pinning; leagueFree = 4.9.2 engine with every team set to league average. Player rows: W6-W7 pre-game snapshots with settled outcomes.', ...B.res } : null };
fs.mkdirSync(path.join(ROOT, 'archive', 'sim'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'archive', 'sim', 'team-validation-2026.json'), JSON.stringify(out, null, 1));
if (B) fs.writeFileSync('/tmp/team-validation-detail.json', JSON.stringify(B.detail));
console.log(JSON.stringify({ tuning: out.tuning.best, A25, A26, A26def, B: out.partB }, null, 1));
