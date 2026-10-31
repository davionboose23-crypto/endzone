// app 4.12.0 — "Sim top 4" track record: walk-forward backtest of the simulators' top-4 anytime-TD picks per game against who
// actually scored, every 2026 game played so far (out-of-sample) and every 2025 game (second out-of-sample check).
//   node scripts/hist/build.mjs t412 2025,2026     (point-in-time model rows -> data/hist/t412-<s>.json; git-ignored, rebuildable)
//   node scripts/sim/top4-backtest.mjs [--sims 1000] [--no-2025] [--no-sims]
// For each week W of season S, everything is fitted on data from BEFORE week W only (leak checks throw):
//   - who plays + projected volumes + model TD lambdas: the model rebuilt point-in-time (nflverse weekly roster at W, features < W)
//   - injuries: nflverse injury report for week W (Out/IR -> excluded, Doubtful 1/3, Questionable by practice; same table as live)
//   - drive sim team fit: drives < W (week 1: all of last season's drives; 2025 starts at week 2, no 2024 drive table); play-by-play params: plays < W (src/pbp-fit.js); td-share-1: plays < W (src/td-share.js)
//   - blend alpha / position offsets: re-fitted on the scorers of earlier test weeks only (fitBlend); unfitted (model split) until
//     150 earlier TDs exist (2025 weeks 2-4)
// Compared top-4 pickers (every one picks the 4 most likely anytime scorers among the game's available players):
//   driveOld / pbp2Old = 4.11.0 engines (scorer split = model lambdas / usage), driveNew / pbp2New = 4.12.0 (td-share-1 blend),
//   model = the shipped anytime chance, sleeper = published price (games where >= 4 priced), naive = season TD leaders (ties: red-zone touches).
// Hit = a pick scored a rushing or receiving TD. Writes archive/sim/top4-backtest-2026.json (2026 per-game list for the app).
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { loadTable, tableToD } from './table.mjs';
import { buildSimInputs, runSim, summarize, assertMarketFree, DATA_OPTS, STAR_SLOTS } from '../../src/sim.js';
import { rosterWeek, poolOf } from './roster-week.mjs';
import { fitPbp } from '../../src/pbp-fit.js';
import { buildPbpInputs, runPbp, summarizePbp, SIM_PBP_VERSION } from '../../src/sim-pbp.js';
import { tallyGames, buildTdShare, fitBlend, fitDataBeta, blendShares, TD_SHARE_VERSION, TD_BLEND } from '../../src/td-share.js';
import { availability } from '../../src/roster.js';
import { surprise } from '../../src/usage-var.js';
import { loadPbpSeason } from '../pbp/lib.mjs';
import { buildUsagePrior } from '../../src/usage-prior.js';
import { fitContext, contextRows } from '../../src/game-context.js';
import { seasonPrior } from '../../src/team-strength.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const NS = +arg('--sims', 1000); const DO25 = !process.argv.includes('--no-2025'); const SIMS = !process.argv.includes('--no-sims');
const r3 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(3); const r5 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(5); const r4 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(4);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const NFLV = 'https://github.com/nflverse/nflverse-data/releases/download';
async function cached(url, f) { if (!fs.existsSync(f)) { for (let i = 0; i < 4; i++) { try { const r = await fetch(url); if (r.ok) { fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); break; } } catch {} await new Promise(r => setTimeout(r, 1500)); } } return fs.readFileSync(f, 'utf8'); }
const splitCsv = l => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
const csv = txt => { const L = txt.trim().split('\n'); const H = splitCsv(L[0]); return L.slice(1).map(l => { const a = splitCsv(l); return Object.fromEntries(H.map((h, i) => [h, a[i]])); }); };
async function loadGames() { const txt = await cached('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv', '/tmp/nflverse-games.csv'); const out = new Map();
  for (const o of csv(txt)) { if (+o.season < 2025 || o.game_type !== 'REG' || o.away_score === '' || o.home_score === '') continue; out.set(o.game_id, { season: +o.season, week: +o.week, away: o.away_team, home: o.home_team, as: +o.away_score, hs: +o.home_score, ctx: { neutral: o.location === 'Neutral', roof: o.roof, wind: o.wind === '' || o.wind === 'NA' ? null : +o.wind, away: { rest: o.away_rest === '' ? null : +o.away_rest }, home: { rest: o.home_rest === '' ? null : +o.home_rest } } }); }
  return out; }
const G = await loadGames();
const TAB = {}; for (const s of [2024, 2025, 2026]) TAB[s] = await loadPbpSeason(s);
const tallies = Object.values(TAB).flatMap(tallyGames);
const GROWS = csv(fs.readFileSync('/tmp/nflverse-games.csv', 'utf8')); // 4.15.0 ctx-1: scores / site / rest / roof / wind only (no market columns)
const CTXF = { 2025: fitContext(contextRows(GROWS, [2022, 2023, 2024])), 2026: fitContext(contextRows(GROWS, [2023, 2024, 2025])) };
const TSP = { 2025: fs.existsSync('/tmp/drv2024/table.json') ? seasonPrior(tableToD(JSON.parse(fs.readFileSync('/tmp/drv2024/table.json', 'utf8'))), 2024) : null, 2026: seasonPrior(tableToD(loadTable(ROOT, 2025)), 2025) }; // 4.15.0 prior-season team strength
console.error('ctx fits', JSON.stringify(CTXF));
const UPS = { 2025: buildUsagePrior(tallies, 2025), 2026: buildUsagePrior(tallies, 2026) }; // 4.15.0: last-season usage (pbp of S-1 only)
const s2g = new Map(); for (const T of Object.values(TAB)) for (const [i, p] of Object.entries(T.people)) if (p.sleeper) s2g.set(String(p.sleeper), T.pids[i]);
const inj = new Map(); for (const s of [2025, 2026]) for (const r of csv(await cached(`${NFLV}/injuries/injuries_${s}.csv`, `/tmp/nfl_injuries_${s}.csv`))) if (r.game_type === 'REG' || !r.game_type) inj.set(`${s}|${r.week}|${r.gsis_id}`, r);
function availOf(s, w, g) { const r = g && inj.get(`${s}|${w}|${g}`); if (!r || !r.report_status) return { factor: 1, status: null };
  const pr = (r.practice_status || '').toLowerCase(); const a = availability({ injury: r.report_status, practice: pr.includes('did not') ? 'DNP' : pr.includes('limited') ? 'Limited' : pr.includes('full') ? 'Full' : '' }); // 4.13.1: keys fixed (injury / practice); before, the report was silently ignored
  return { factor: a.factor, status: r.report_status }; }
// actual offensive rush/rec TD scorers per game & team (pbp)
const scorersOf = (S, W, team) => { const T = tallies.find(x => x.season === S && x.week === W && x.off === team); return T ? [...T.pl.values()].filter(x => x.v[7] > 0).map(x => ({ id: x.id, name: x.name, pos: x.pos, td: x.v[7] })) : []; };
// naive: season TDs before W (week 1-2: prior season pace), ties by red-zone touches
const naiveOf = (S, W) => { const m = new Map(); for (const T of tallies) { const cur = T.season === S && T.week < W, prev = T.season === S - 1 && W <= 2; if (!cur && !prev) continue;
  for (const x of T.pl.values()) { const a = m.get(x.id) || { td: 0, rz: 0 }; a.td += x.v[7] * (cur ? 1 : 0.1); a.rz += (x.v[2] + x.v[5]) * (cur ? 1 : 0.1); m.set(x.id, a); } } return m; };
const clampP = p => Math.min(0.995, Math.max(0.005, p));
const SEED = +(process.env.SEED || 11); // sim seed (paired variant checks re-run at a second seed)
const VAR = process.env.VAR_OPTS ? JSON.parse(process.env.VAR_OPTS) : null; // research variant of the 4.14 data options (engines driveV / pbpV)
const KS = ['driveNew', 'pbp2New', ...(VAR ? ['driveV', 'pbpV'] : []), ...(process.env.TD_SD != null ? ['driveG'] : []), 'drive4131', 'pbp4131', 'drive413', 'pbp413', 'model', 'naive', 'sleeper']; // 4.14.0: driveNew / pbp2New = 4.14 (weekly roster + carried rates + rookie/depth priors + 1% floor); driveG = driveNew + per-game team TD multiplier (research); drive4131 / pbp4131 = 4.13.1 as shipped
const SIM_KS = new Set(['driveNew', 'pbp2New', 'driveV', 'pbpV', 'driveG', 'drive4131', 'pbp4131', 'drive413', 'pbp413']);
const TD_SD = process.env.TD_SD != null ? +process.env.TD_SD : DATA_OPTS.tdSd; // driveG = driveNew with another per-game TD multiplier sd (research)
const OLD_OPTS = { carry: false, rookie: null, floor: 0, depthCal: null, tdSd: 0 }; // 4.13.1: driveNew / pbp2New = model-independent sims (data players); drive413 / pbp413 = 4.13.0 (model players + TD anchor)
const DATA_ALPHA = process.env.DATA_ALPHA != null ? +process.env.DATA_ALPHA : null; // research override of the data-player td-share blend
// injury report for week W as a rosterNow map (gsis -> [team, injury, practice, status]) for the model-free sims
const rosterOf = (S, W) => { const o = {}; for (const [k, r] of inj) { const [s, w, g] = k.split('|'); if (+s !== S || +w !== W || !r.report_status) continue; const pr = (r.practice_status || '').toLowerCase();
  o[g] = [null, r.report_status, pr.includes('did not') ? 'DNP' : pr.includes('limited') ? 'Limited' : pr.includes('full') ? 'Full' : '', null]; } return o; };
async function season(S, weeks, priorDetail) {
  const rowsAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'hist', `t412-${S}.json`))); const T = SIMS ? loadTable(ROOT, S) : null;
  const games = [], players = [], detail = [], blends = [], betas = [];
  for (const W of weeks) {
    const R = rowsAll.filter(r => r.week === W); if (!R.length) continue;
    const D = !SIMS ? null : W > 1 ? tableToD(T, { before: W }) : fs.existsSync(path.join(ROOT, 'archive', 'drives', String(S - 1), 'table.json')) ? tableToD(loadTable(ROOT, S - 1)) : null; // week 1: last season's drives
    if (SIMS && !D) continue; const PP = SIMS ? fitPbp([TAB[S - 1], TAB[S]], { season: S, before: W }) : null; if (PP && PP.through >= W) throw new Error('leak: pbp params see week ' + PP.through);
    const td = buildTdShare([TAB[S - 1], TAB[S]], { season: S, before: W }); if (td.through >= W) throw new Error('leak: td-share sees week ' + td.through);
    const B = fitBlend([...priorDetail, ...detail]); blends.push({ w: W, alpha: B.alpha, beta: B.beta, fitted: B.fitted, tds: B.n });
    const naive = naiveOf(S, W);
    for (const gid of [...new Set(R.map(r => r.gameId))]) {
      const gm = G.get(gid); if (!gm) continue; const GR = R.filter(r => r.gameId === gid && r.pos !== 'K');
      const P = GR.map(r => { const gsis = s2g.get(String(r.id)) || null; const av = availOf(S, W, gsis); const f = av.factor; const sc = x => x == null ? x : x * f;
        return { id: String(r.id), gsis, name: r.name, pos: r.pos, team: r.team, avail: { factor: f, status: av.status }, chance: f ? 1 - Math.exp(-(r.lambda || 0) * f) : 0, lambda: (r.lambda || 0) * f, components: r.components,
          vol: { ...r.vol, targets: sc(r.vol?.targets || 0), carries: sc(r.vol?.carries || 0) }, volume: r.volume, published: r.published, y: r.y ? 1 : 0, td: r.td || 0, teamLambda: r.teamLambda, tdBudget: r.tdBudget }; });
      const sideFor = t => { const pl = P.filter(p => p.team === t); return pl.length ? { players: pl, opp: t === gm.away ? gm.home : gm.away, teamLambda: pl[0].teamLambda, tdBudget: pl[0].tdBudget } : null; };
      const live = P.filter(p => p.avail.factor > 0); const sur = {}; const prob = {}; for (const p of live) prob[p.id] = { model: p.chance, sleeper: p.published ?? null, naive: (naive.get(p.gsis)?.td || 0) + 0.001 * (naive.get(p.gsis)?.rz || 0) };
      // blend split (for the allocation check, all candidates of each team) + detail for later weeks' blend fits
      for (const t of [gm.away, gm.home]) { const pl = live.filter(p => p.team === t).map(p => ({ gsis: p.gsis, pos: p.pos, lam: p.lambda, tgt: p.vol.targets, car: p.vol.carries }));
        const bs = blendShares(pl, td, t === gm.away ? gm.home : gm.away, { alpha: 1, beta: {} }); if (!bs) continue; const lv = live.filter(p => p.team === t);
        detail.push({ S, W, team: t, tds: lv.reduce((a, p) => a + p.td, 0), c: lv.map((p, i) => [p.pos === 'FB' ? 'RB' : p.pos, bs[i].model, bs[i].td, p.td]) }); }
      // 4.14.0: scoring pool = the model's rows plus every QB/RB/WR/TE on the pre-game weekly roster (ACT/INA) and any late scorer missing from both
      const act = [...scorersOf(S, W, gm.away).map(x => ({ ...x, team: gm.away })), ...scorersOf(S, W, gm.home).map(x => ({ ...x, team: gm.home }))]; const actG = new Map(act.map(x => [x.id, x.td]));
      const legacyN = live.length; const haveG = new Set(live.map(p => p.gsis).filter(Boolean));
      for (const t of [gm.away, gm.home]) { const pool = poolOf(S, W, t); for (const x of act) if (x.team === t && !pool.has(x.id)) pool.set(x.id, { pos: x.pos || '?', name: x.name, late: true });
        for (const [g, r] of pool) { if (haveG.has(g)) continue; haveG.add(g); const id = 'g:' + g; live.push({ id, gsis: g, name: r.name, pos: r.pos, team: t, lambda: 0, vol: { targets: 0, carries: 0 }, y: actG.get(g) ? 1 : 0, td: actG.get(g) || 0, extra: true });
          prob[id] = { model: null, sleeper: null, naive: (naive.get(g)?.td || 0) + 0.001 * (naive.get(g)?.rz || 0) }; } }
      let InD = null;
      if (SIMS) {
        const In1 = buildSimInputs(D, { away: gm.away, home: gm.home, sideFor, gameId: gid, source: 'model', tdShare: td, tdBlend: B.fitted ? B : { alpha: 0, beta: {} }, disp: false });
        const In2 = { ...In1, disp: { drive: { anchor: 1 }, pbp: { anchor: 1 } } }; // 4.13.0 as shipped
        const tb = DATA_ALPHA != null ? { tdBlend: { alpha: DATA_ALPHA, beta: process.env.DATA_NOBETA ? {} : { TE: 0.1 } } } : {};
        InD = buildSimInputs(D, { away: gm.away, home: gm.home, gameId: gid, tdShare: td, rosterNow: rosterWeek(S, W, true), dataOpts: DATA_OPTS, usagePrior: UPS[S], tsPrior: W > 1 ? TSP[S] : null, ctx: { ...gm.ctx, fit: CTXF[S] }, ...tb }); // app default (4.14): model-free, market-free
        const InO = buildSimInputs(D, { away: gm.away, home: gm.home, gameId: gid, tdShare: td, rosterNow: rosterOf(S, W), dataOpts: OLD_OPTS, ...tb }); // 4.13.1 as shipped
        for (const I0 of [InD, InO]) assertMarketFree(I0); // throws on any model or betting-market source (no Vegas totals / spreads / implied / odds / Sleeper prices)
        const InG = { ...InD, tdSd: TD_SD };
        const InV = VAR ? buildSimInputs(D, { away: gm.away, home: gm.home, gameId: gid, tdShare: td, rosterNow: rosterWeek(S, W, true), dataOpts: { ...DATA_OPTS, ...VAR }, usagePrior: UPS[S], tsPrior: W > 1 ? TSP[S] : null, ctx: { ...gm.ctx, fit: CTXF[S] }, ...tb, ...(VAR.fitBeta ? { tdBlend: (() => { const F = fitDataBeta([...priorDetail, ...detail]); betas.push({ S, W, ...F }); return F; })() } : {}) }) : null; if (InV) assertMarketFree(InV);
        const keep = (S0, I0, sm) => Object.assign(sm, { __S: S0, __I: I0 });
        const dr = I0 => { const S0 = runSim(I0, { n: NS, seed: SEED, mode: 'free' }); return keep(S0, I0, summarize(S0, I0)); };
        const pb = I0 => { const I = buildPbpInputs(I0, PP); const S0 = runPbp(I, { n: NS, seed: SEED }); return keep(S0, I, summarizePbp(S0, I)); };
        const run = { drive413: () => dr(In2), pbp413: () => pb(In2), driveNew: () => dr(InD), pbp2New: () => pb(InD), driveG: () => dr(InG), ...(InV ? { driveV: () => dr(InV), pbpV: () => pb(InV) } : {}), drive4131: () => dr(InO), pbp4131: () => pb(InO) };
        for (const [k, f] of Object.entries(run)) { if ((ENG && !ENG.includes(k)) || !KS.includes(k)) continue; const s = f(); for (const p of live) prob[p.id][k] = 0; for (const x of s.players) if (prob[x.id]) prob[x.id][k] = x.anytime; else if (x.gsis) { const m = live.find(p => p.gsis === x.gsis); if (m) prob[m.id][k] = x.anytime; }
          if (DUMP && s.__S) dumpTeams(DUMP, S, W, gid, k, s.__S, s.__I, live);
          if (k === 'driveNew' || k === 'pbp2New') { const su = surprise(s.__S, s.players); sur[k] = { p: r3(su.pOutside), share: r3(su.shareOutside), ls: su.longshots.map(x => ({ n: x.name, t: x.team, p: x.pos, pr: r3(x.p) })) }; } }
      }
      if (DUMP) DUMP.push({ S, W, gid, eng: 'actual', act: act.map(x => ({ id: x.id, team: x.team, pos: x.pos, td: x.td, n: x.name })) });
      const roleOf = new Map(); if (InD) for (const t of InD.teams) for (const p of t.players) if (p.gsis) roleOf.set(p.gsis, STAR_SLOTS.has(p.slot) ? 'star' : 'role');
      const isRole = p => (p.gsis && roleOf.get(p.gsis)) !== 'star'; // unlisted / depth players = role
      const scored = new Set(live.filter(p => p.y).map(p => p.id)); const roleSc = live.filter(p => p.y && isRole(p)).length; const rec = { gid, w: W, away: gm.away, home: gm.home, score: [gm.as, gm.hs], picks: {}, hits: {}, actual: act.map(x => ({ n: x.name, t: x.team, p: x.pos, td: x.td })), out: P.filter(p => p.avail.factor === 0 && (p.lambda > 0 || p.vol.targets + p.vol.carries > 3)).length, surprise: sur, roleSc, scorers: scored.size };
      for (const k of KS) { const cand = live.filter((p, i) => prob[p.id][k] != null && (k !== 'sleeper' || prob[p.id][k] > 0) && (SIM_KS.has(k) || k === 'naive' || i < legacyN)); if (cand.length < 4 || (k === 'sleeper' && cand.length < 8)) continue;
        const top = cand.sort((a, b) => prob[b.id][k] - prob[a.id][k] || b.lambda - a.lambda).slice(0, 4); rec.picks[k] = top.map(p => ({ id: p.id, n: p.name, t: p.team, p: p.pos, pr: k === 'naive' ? null : r3(prob[p.id][k]), hit: scored.has(p.id) ? 1 : 0, role: isRole(p) ? 1 : 0, sl: p.gsis ? (InD?.teams.flatMap(t => t.players).find(q => q.gsis === p.gsis)?.slot || null) : null })); rec.hits[k] = top.filter(p => scored.has(p.id)).length; }
      games.push(rec);
      for (const p of live) players.push({ w: W, gid, pos: p.pos === 'FB' ? 'RB' : p.pos, y: p.y, legacy: !p.extra, role: isRole(p) ? 1 : 0, ...Object.fromEntries(KS.filter(k => k !== 'naive').map(k => [k, prob[p.id][k] ?? null])) });
      process.stderr.write('.');
    }
    process.stderr.write(` ${S}w${W}\n`);
  }
  return { games, players, detail, blends, betas };
}
function top4Table(games) { const out = {}; for (const k of KS) { const g = games.filter(x => x.hits[k] != null); if (!g.length) continue; const h = g.map(x => x.hits[k]);
  const exp = g.map(x => x.picks[k].reduce((a, p) => a + (p.pr || 0), 0));
  out[k] = { games: g.length, hitsPerGame: r3(mean(h)), precision: r3(mean(h) / 4), ge1: r3(mean(h.map(x => x >= 1 ? 1 : 0))), ge2: r3(mean(h.map(x => x >= 2 ? 1 : 0))), ge3: r3(mean(h.map(x => x >= 3 ? 1 : 0))), expectedHits: k === 'naive' ? null : r3(mean(exp)), rolePicksPerGame: r3(mean(g.map(x => x.picks[k].filter(p => p.role).length))), roleHitRate: (() => { const R = g.flatMap(x => x.picks[k].filter(p => p.role)); return R.length ? r3(mean(R.map(p => p.hit))) : null; })(), roleScorersInTop4: r3(g.reduce((a, x) => a + x.picks[k].filter(p => p.role && p.hit).length, 0) / Math.max(1, g.reduce((a, x) => a + (x.roleSc || 0), 0))), se: r3(Math.sqrt(mean(h.map(x => (x - mean(h)) ** 2)) / g.length)) }; }
  // head-to-head on the same games (sleeper subset too)
  const both = games.filter(x => x.hits.sleeper != null); out.sleeperSubset = Object.fromEntries(KS.map(k => [k, r3(mean(both.map(x => x.hits[k] ?? 0)))])); out.sleeperSubset.games = both.length;
  return out; }
function brierTable(rows) { const K = KS.filter(k => k !== 'naive'); const grp = {};
  const sc = (R, k) => { R = R.filter(r => r[k] != null); return R.length ? { n: R.length, brier: r4(mean(R.map(r => (r[k] - r.y) ** 2))), logLoss: r5(mean(R.map(r => -(r.y ? Math.log(clampP(r[k])) : Math.log(1 - clampP(r[k])))))), meanP: r4(mean(R.map(r => r[k]))), rate: r4(mean(R.map(r => r.y))) } : null; };
  for (const [name, R] of [['all', rows], ...['RB', 'WR', 'TE', 'QB'].map(p => [p, rows.filter(r => r.pos === p)])]) grp[name] = Object.fromEntries(K.filter(k => k !== 'sleeper').map(k => [k, sc(R, k)]));
  const S = rows.filter(r => r.sleeper > 0); grp.withSleeper = Object.fromEntries(K.map(k => [k, sc(S, k)])); return grp; }
function allocLL(detail, blends) { // log-likelihood per TD of the actual scorer under the model split vs the walk-forward blend
  let m = 0, b = 0, n = 0; for (const t of detail) { const B = blends.find(x => x.w === t.W) || { alpha: 0, beta: {} }; if (!t.tds) continue;
    const v = t.c.map(x => Math.pow(Math.max(x[1], 1e-5), 1 - B.alpha) * Math.pow(Math.max(x[2], 1e-5), B.alpha) * Math.exp(B.beta?.[x[0]] || 0)); const Z = v.reduce((a, c) => a + c, 0); const Zm = t.c.reduce((a, x) => a + x[1], 0) || 1;
    t.c.forEach((x, i) => { if (x[3]) { m += x[3] * Math.log(Math.max(1e-5, x[1] / Zm)); b += x[3] * Math.log(v[i] / Z); n += x[3]; } }); }
  return { tds: n, model: r4(m / n), blend: r4(b / n) }; }
const posMix = (detail, blends) => { const E = { model: {}, blend: {}, actual: {} }; for (const t of detail) { const B = blends.find(x => x.w === t.W) || { alpha: 0, beta: {} };
  const v = t.c.map(x => Math.pow(Math.max(x[1], 1e-5), 1 - B.alpha) * Math.pow(Math.max(x[2], 1e-5), B.alpha) * Math.exp(B.beta?.[x[0]] || 0)); const Z = v.reduce((a, c) => a + c, 0) || 1, Zm = t.c.reduce((a, x) => a + x[1], 0) || 1;
  t.c.forEach((x, i) => { E.model[x[0]] = (E.model[x[0]] || 0) + t.tds * x[1] / Zm; E.blend[x[0]] = (E.blend[x[0]] || 0) + t.tds * v[i] / Z; E.actual[x[0]] = (E.actual[x[0]] || 0) + x[3]; }); }
  for (const k of Object.keys(E)) for (const p of Object.keys(E[k])) E[k][p] = Math.round(E[k][p]); return E; };
const t0 = Date.now();
const wk = S => [...new Set([...G.values()].filter(g => g.season === S).map(g => g.week))].sort((a, b) => a - b);
const ENG = process.env.ENGINES ? process.env.ENGINES.split(',') : null;
const DUMP = process.env.DUMP ? [] : null;
// per team-game: sim TD count distribution, each player's share of the team's simulated TDs, his sim anytime chance, depth role, actual TDs
function dumpTeams(out, S, W, gid, eng, Sim, I, live) {
  for (let k = 0; k < 2; k++) { const T = I.teams[k]; const P = Sim.P[k], b = Sim.base[k]; const tot = new Float64Array(P), any = new Float64Array(P); const hist = new Array(12).fill(0);
    for (let g = 0; g < Sim.n; g++) { let c = 0; for (let i = 0; i < P; i++) { const v = Sim.G.td[g * Sim.NP + b + i]; tot[i] += v; if (v > 0) any[i]++; c += v; } hist[Math.min(11, c)]++; }
    const ttot = tot.reduce((a, x) => a + x, 0) || 1; const byId = new Map(T.players.map((p, i) => [String(p.id), i]));
    const lv = live.filter(p => p.team === T.team);
    out.push({ S, W, gid, eng, team: T.team, hist: hist.map(x => x / Sim.n), pl: lv.map(p => { const i = byId.get(p.id); return { id: p.id, n: p.name, pos: p.pos, tgt: p.vol.targets, car: p.vol.carries, lam: p.lambda, sh: i == null ? 0 : tot[i] / ttot, any: i == null ? 0 : any[i] / Sim.n, td: p.td }; }) }); } }
const ONLY = arg('--weeks', null)?.split(',').map(Number);
const B25 = DO25 ? await season(2025, wk(2025).filter(w => w >= 2), []) : { games: [], players: [], detail: [], blends: [] };
const B26 = await season(2026, wk(2026).filter(w => !ONLY || ONLY.includes(w)), B25.detail);
const summ = B => ({ games: B.games.length, weeks: [...new Set(B.games.map(g => g.w))], top4: top4Table(B.games), anytime: brierTable(B.players.filter(r => r.legacy)), anytimeRosterPool: brierTable(B.players), roleScorerShare: r3(B.games.reduce((a, g) => a + g.roleSc, 0) / Math.max(1, B.games.reduce((a, g) => a + g.scorers, 0))), scorerSplit: allocLL(B.detail, B.blends), tdsByPosition: posMix(B.detail, B.blends), blendByWeek: B.blends, ...(process.env.BYWEEK ? { byWeek: Object.fromEntries([...new Set(B.players.map(r => r.w))].map(w => [w, brierTable(B.players.filter(r => r.w === w)).all])) } : {}) });
const best = s => Object.entries(s.top4).filter(([k]) => KS.includes(k)).sort((a, b) => b[1].hitsPerGame - a[1].hitsPerGame)[0]?.[0];
const S26 = summ(B26), S25 = DO25 ? summ(B25) : null;
const out = { generated: new Date().toISOString(), tdShareVersion: TD_SHARE_VERSION, simPbpVersion: SIM_PBP_VERSION, simsPerGame: SIMS ? NS : 0, seconds: Math.round((Date.now() - t0) / 1000), shippedBlend: TD_BLEND,
  note: 'Walk-forward: every input for week W (weekly roster, injuries, team drives / play-by-play / td-share fits, recent usage, prior-season rates) uses data before W only. Hit = a top-4 pick scored a rushing or receiving TD. The sims read no betting-market data (no Vegas totals, spreads, implied totals, win probabilities, Sleeper or sportsbook prices); assertMarketFree throws otherwise. driveNew / pbp2New = 4.14.0 sims (nflverse weekly roster as the pre-game roster, a player\'s rates carried across a team change, rookie / depth priors, 1% per-player floor); drive4131 / pbp4131 = 4.13.1 as shipped; driveNew includes a per-game team TD multiplier (Gamma, sd 0.18) for each team; drive413 / pbp413 = 4.13.0 (model inputs + TD-budget anchor, comparison only). model = shipped anytime chance and sleeper = published price, both comparison baselines only, never sim inputs; naive = season TD leaders. Sims pick from the whole pre-game roster; anytime = Brier / log loss over the model\'s player universe (comparable with model / sleeper), anytimeRosterPool = over the full pre-game roster (players a sim did not list count as 0). Role = anyone outside QB1 / RB1 / WR1 / WR2 / TE1 of the 4.15 depth order (this season’s touches per game played, shrunk toward last season’s per-game usage from nflverse pbp, usage-prior-1; 4.14 used this season only, so stars who missed early games were tagged role). prev = the 4.14.0 headline rows from the archive this run replaced.',
  // 4.15.0: the previous release's headline rows (PREV=<old archive json>), kept so the card can show before / after
  prev: process.env.PREV ? (() => { const P = JSON.parse(fs.readFileSync(process.env.PREV, 'utf8')); const pick = s => s ? { games: s.games, top4: { driveNew: s.top4?.driveNew || null, pbp2New: s.top4?.pbp2New || null }, logLoss: { driveNew: s.anytime?.all?.driveNew?.logLoss ?? null, pbp2New: s.anytime?.all?.pbp2New?.logLoss ?? null } } : null; return { version: process.env.PREV_VERSION || '4.14.0', season2026: pick(P.season2026), season2025: pick(P.season2025) }; })() : null,
  season2026: { ...S26, best: best(S26) }, season2025: S25 ? { ...S25, best: best(S25) } : null,
  games2026: B26.games.map(g => ({ gid: g.gid, w: g.w, a: g.away, h: g.home, sc: g.score, sim: g.picks.driveNew || g.picks.model, simHits: g.hits.driveNew ?? g.hits.model, pbp: g.picks.pbp2New ? g.picks.pbp2New.map(p => p.n) : null, pbpHits: g.hits.pbp2New ?? null, modelHits: g.hits.model, sleeperHits: g.hits.sleeper ?? null, naiveHits: g.hits.naive, oldHits: g.hits.drive4131 ?? null, v4131: g.picks.drive4131 ? g.picks.drive4131.map(p => p.n) : null, actual: g.actual, out: g.out, sur: g.surprise?.driveNew || null, pbpSur: g.surprise?.pbp2New || null })) };
if (!process.env.NO_WRITE) { fs.mkdirSync(path.join(ROOT, 'archive', 'sim'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'archive', 'sim', 'top4-backtest-2026.json'), JSON.stringify(out)); }
fs.writeFileSync(process.env.DETAIL || '/tmp/top4-detail.json', JSON.stringify({ B25, B26 })); if (DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(DUMP));
console.log(JSON.stringify({ ...out, games2026: out.games2026.length }, null, 1));
