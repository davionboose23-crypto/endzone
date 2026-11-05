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
import fs from 'node:fs'; import path from 'node:path'; import { DATA_OPTS_417, assertSeasonOnly } from '../../src/sim.js';
import { fileURLToPath } from 'node:url';
import { loadTable, tableToD } from './table.mjs';
import { buildSimInputs, runSim, summarize, assertMarketFree, DATA_OPTS, STAR_SLOTS } from '../../src/sim.js';
import { rosterWeek, poolOf } from './roster-week.mjs';
import { fitPbp } from '../../src/pbp-fit.js';
import { parsePressure } from '../../src/pressure.js';
import { fitFloor, fitCal, applyPost } from '../../src/sim-post.js';
import { buildPbpInputs, runPbp, summarizePbp, pbpSummary, SIM_PBP_VERSION, SIM_PBP_TUNE } from '../../src/sim-pbp.js';
import { tallyGames, buildTdShare, fitBlend, fitDataBeta, blendShares, TD_SHARE_VERSION, TD_BLEND } from '../../src/td-share.js';
import { availability } from '../../src/roster.js';
import { surprise } from '../../src/usage-var.js';
import { loadPbpSeason } from '../pbp/lib.mjs';
import { buildUsagePrior } from '../../src/usage-prior.js';
import { fitContext, contextRows } from '../../src/game-context.js';
import { seasonPrior } from '../../src/team-strength.js';
const APP_V = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
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
const HIST3 = !!+(process.env.HIST3 || 0); // research: multi-year (2023-25) priors under 2026; off by default
const HIST3W = process.env.HIST3W ? JSON.parse(process.env.HIST3W) : { 2025: 0.5, 2024: 0.3, 2023: 0.15 }; // recency weights (2026 current = 1 via halfLife)
const HIST3_FADE = !!+(process.env.HIST3_FADE || 0); // research: fade priors out as 2026 sample grows
const TAB = {}; for (const s of (HIST3 ? [2023, 2024, 2025, 2026] : [2024, 2025, 2026])) TAB[s] = await loadPbpSeason(s);
const tallies = Object.values(TAB).flatMap(tallyGames);
const GROWS = csv(fs.readFileSync('/tmp/nflverse-games.csv', 'utf8')); // 4.15.0 ctx-1: scores / site / rest / roof / wind only (no market columns)
const CTXF = { 2025: fitContext(contextRows(GROWS, [2022, 2023, 2024])), 2026: fitContext(contextRows(GROWS, [2023, 2024, 2025])) };
const TSP = { 2025: fs.existsSync('/tmp/drv2024/table.json') ? seasonPrior(tableToD(JSON.parse(fs.readFileSync('/tmp/drv2024/table.json', 'utf8'))), 2024) : null, 2026: seasonPrior(tableToD(loadTable(ROOT, 2025)), 2025) }; // 4.15.0 prior-season team strength
console.error('ctx fits', JSON.stringify(CTXF));
const UPS = { 2025: buildUsagePrior(tallies, 2025), 2026: buildUsagePrior(tallies, 2026) }; // 4.15.0: last-season usage (pbp of S-1 only)
const loadDrvTab = s => { const a = path.join(ROOT, 'archive', 'drives', String(s), 'table.json'); if (fs.existsSync(a)) return JSON.parse(fs.readFileSync(a, 'utf8'));
  if (s === 2024 && fs.existsSync('/tmp/drv2024/table.json')) return JSON.parse(fs.readFileSync('/tmp/drv2024/table.json', 'utf8'));
  if (s === 2023 && fs.existsSync('/tmp/ez/drives-2023.json')) return JSON.parse(fs.readFileSync('/tmp/ez/drives-2023.json', 'utf8')); return null; };
function blendTsPrior(weights) { // research: weighted blend of seasonPrior across years (same team index union)
  const parts = Object.entries(weights).map(([s, w]) => { const T = loadDrvTab(+s); return T && w > 0 ? { w: +w, p: seasonPrior(tableToD(T), +s) } : null; }).filter(Boolean);
  if (!parts.length) return null; const teams = [...new Set(parts.flatMap(x => x.p.teams))].sort(); const idx = Object.fromEntries(teams.map((t, i) => [t, i])); const C = parts[0].p.O.length / parts[0].p.teams.length; const O = new Float64Array(teams.length * C), D = new Float64Array(teams.length * C), den = new Float64Array(teams.length);
  for (const { w, p } of parts) for (const t of p.teams) { const i = idx[t], j = p.idx[t]; if (j == null) continue; den[i] += w; for (let c = 0; c < C; c++) { O[i * C + c] += w * p.O[j * C + c]; D[i * C + c] += w * p.D[j * C + c]; } }
  for (let i = 0; i < teams.length; i++) if (den[i] > 0) for (let c = 0; c < C; c++) { O[i * C + c] /= den[i]; D[i * C + c] /= den[i]; }
  return { version: 'ts-blend-research', season: null, teams, idx, O: Array.from(O, v => +v.toFixed(4)), D: Array.from(D, v => +v.toFixed(4)), id: 'prior-hist3' }; }
const UP_HIST3 = HIST3 ? buildUsagePrior(tallies, 2026, { priorW: HIST3W }) : null;
const TSP_HIST3 = HIST3 ? blendTsPrior(HIST3W) : null;
const priorWAt = (W) => { if (!HIST3) return null; if (!HIST3_FADE) return HIST3W;
  // fade: full hist3 weights early (thin 2026), → null (season-only) by week 6+
  const thin = Math.max(0, (6 - W) / 4); if (thin <= 0) return null;
  return Object.fromEntries(Object.entries(HIST3W).map(([y, w]) => [y, +((+w) * (0.5 + 1.5 * thin)).toFixed(3)])); };
const s2g = new Map(); for (const T of Object.values(TAB)) for (const [i, p] of Object.entries(T.people)) if (p.sleeper) s2g.set(String(p.sleeper), T.pids[i]);
const inj = new Map(); for (const s of [2025, 2026]) for (const r of csv(await cached(`${NFLV}/injuries/injuries_${s}.csv`, `/tmp/nfl_injuries_${s}.csv`))) if (r.game_type === 'REG' || !r.game_type) inj.set(`${s}|${r.week}|${r.gsis_id}`, r);
function availOf(s, w, g) { const r = g && inj.get(`${s}|${w}|${g}`); if (!r || !r.report_status) return { factor: 1, status: null };
  const pr = (r.practice_status || '').toLowerCase(); const a = availability({ injury: r.report_status, practice: pr.includes('did not') ? 'DNP' : pr.includes('limited') ? 'Limited' : pr.includes('full') ? 'Full' : '' }); // 4.13.1: keys fixed (injury / practice); before, the report was silently ignored
  return { factor: a.factor, status: r.report_status }; }
// actual offensive rush/rec TD scorers per game & team (pbp)
const rtdOf = (S, W, team, id) => { const T = tallies.find(x => x.season === S && x.week === W && x.off === team); const x = T && id ? T.pl.get(id) : null; return x ? x.v[8] : 0; };
const scorersOf = (S, W, team) => { const T = tallies.find(x => x.season === S && x.week === W && x.off === team); return T ? [...T.pl.values()].filter(x => x.v[7] > 0).map(x => ({ id: x.id, name: x.name, pos: x.pos, td: x.v[7] })) : []; };
// naive: season TDs before W (week 1-2: prior season pace), ties by red-zone touches
const naiveOf = (S, W) => { const m = new Map(); for (const T of tallies) { const cur = T.season === S && T.week < W, prev = T.season === S - 1 && W <= 2; if (!cur && !prev) continue;
  for (const x of T.pl.values()) { const a = m.get(x.id) || { td: 0, rz: 0 }; a.td += x.v[7] * (cur ? 1 : 0.1); a.rz += (x.v[2] + x.v[5]) * (cur ? 1 : 0.1); m.set(x.id, a); } } return m; };
const clampP = p => Math.min(0.995, Math.max(0.005, p));
const NORM = process.env.NORM != null ? +process.env.NORM : 0; const normF = [];
const LG26 = (S, W) => { let td = 0; const g = new Set(); for (const T of tallies) if (T.season === S && T.week < W) { g.add(T.week + T.off); for (const x of T.pl.values()) td += x.v[7]; } return g.size ? 2 * td / g.size : 0; }; // per game (two teams)
process.on('exit', () => { if (NORM && normF.length) console.error('normF mean', (normF.reduce((a, b) => a + b, 0) / normF.length).toFixed(3)); });
const SEED = +(process.env.SEED || 11); // sim seed (paired variant checks re-run at a second seed)
const VAR = process.env.VAR_OPTS ? JSON.parse(process.env.VAR_OPTS) : null; // research variant of the 4.14 data options (engines driveV / pbpV)
if (process.env.PBP_QBRZ != null) SIM_PBP_TUNE.qbRz = +process.env.PBP_QBRZ; if (process.env.PBP_PRS != null) SIM_PBP_TUNE.prs = +process.env.PBP_PRS;
const PRESS = (() => { const f = path.join(ROOT, 'archive', 'pressure', 'advstats_week_pass_2026.csv'); return fs.existsSync(f) ? parsePressure(fs.readFileSync(f, 'utf8')) : null; })(); // 4.20.0 PFR pressure via nflverse (game-level)
const POST = { floor: !!+(process.env.POST_FLOOR ?? 0), cal: !!+(process.env.POST_CAL ?? 0) }; const postRows = [];
// 4.22 research: snap-share trend (nflverse snap_counts, weeks < target only) and same-position redistribution for players ruled out
const nmK = s => String(s || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z]/g, '');
const SNAPS = (() => { const f = path.join(ROOT, 'archive', 'snaps', 'snap_counts_2026.csv'); if (!fs.existsSync(f)) return null; const [h, ...ls] = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/); const c = h.split(',');
  const iW = c.indexOf('week'), iP = c.indexOf('player'), iT = c.indexOf('team'), iO = c.indexOf('offense_pct'), iG = c.indexOf('game_type'); const m = new Map();
  for (const l of ls) { const a = l.split(','); if (a[iG] !== 'REG') continue; const k = a[iT] + '|' + nmK(a[iP]); (m.get(k) || m.set(k, []).get(k)).push({ w: +a[iW], p: +a[iO] }); } return m; })();
const snapTrend = (team, name, W, k = 2) => { const r = (SNAPS?.get(team + '|' + nmK(name)) || []).filter(x => x.w < W).sort((a, b) => a.w - b.w); if (r.length < 2) return 1;
  const all = r.reduce((s, x) => s + x.p, 0) / r.length; const l3 = r.slice(-3); const rec = l3.reduce((s, x) => s + x.p, 0) / l3.length; if (all <= 0.02) return 1; return Math.min(2, Math.max(0.4, (rec * l3.length + all * k) / (l3.length + k) / all)); };
const SNAP_A = +(process.env.SNAP || 0), SNAP_L = +(process.env.SNAPL || 0), INJ = +(process.env.INJ || 0);
const snapAvg = (team, name, W) => { const r = (SNAPS?.get(team + '|' + nmK(name)) || []).filter(x => x.w < W); return r.length ? r.reduce((s, x) => s + x.p, 0) / r.length : null; };
// applied to the play-by-play inputs (each player's td-share weight lam steers who scores; tgt / car steer volume)
const RZF = process.env.RZF || null, RZB = +(process.env.RZB ?? 0.3), GATE = +(process.env.GATE ?? 0), LOGIT = +(process.env.LOGIT ?? 0); // 4.22 t73u research knobs
const RZFEAT = (RZF || GATE || LOGIT || process.env.LOWSNAP) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'archive', 'sim', 'rzfeat-2026.json'), 'utf8')) : null;
const rzf = (W, team, name) => RZFEAT?.[`${W}|${team}|${nmK(name)}`] || {};
const ZG = [[2, 3], [4, 5], [6, 7]];
const HVY = +(process.env.HVY ?? 0), HVYK = process.env.HVYK || 'hT', HVYPOS = (process.env.HVYPOS || 'TE,RB').split(','), HVYS = +(process.env.HVYS ?? 4); // t98u RotoBot 12-personnel RZ share knob (off)
const ROTO = HVY ? JSON.parse(fs.readFileSync(path.join(ROOT, 'archive', 'sim', 'rotobot-feat-2026.json'), 'utf8')) : null;
function featK(v, g, kind) { const c = kind === 'C'; if (v === 'i5') return c ? ['c', 'c10', 'c5'][g] : ['t', 't10', 't10'][g]; if (v === 'posk') return c ? 'cK' : 'tK'; if (v === 'rec') return c ? 'cR' : 'tR'; if (v === 'air') return c ? 'c' : 'AIR'; if (/^l\d$/.test(v)) return c ? null : 'tL' + v[1]; return c ? 'c' : 't'; }
const DEPTH = +(process.env.DEPTH ?? 1), LOWSNAP = +(process.env.LOWSNAP ?? 1), I5FLAT = +(process.env.I5FLAT ?? 1); // t80u

// t104u research (off unless DS=K): depth-slot shrinkage of each pbp player's TD weight (lam share) toward the 2026 league mean TD share of his
// position-depth slot (slot = rank within position by usage; prior from 2026 games before W only), weighted by his own sample (team TDs in games he played): (n*share + K*slot)/(n+K)
const DS = +(process.env.DS || 0), DSO = +(process.env.DSO || 0);
const slotKey = (pos, r) => (pos === 'FB' ? 'RB' : pos) + Math.min(r, pos === 'QB' ? 1 : pos === 'WR' ? 4 : 3);
function dsPrior(S, W) { const td = {}, ap = {}, n = new Map(), dvs = {}; let tot = 0, tg = 0;
  for (const T of tallies) { if (T.season !== S || T.week >= W) continue; tg++; const by = {}; for (const x of T.pl.values()) { const ps = x.pos === 'FB' ? 'RB' : x.pos; if (!['QB', 'RB', 'WR', 'TE'].includes(ps)) continue; (by[ps] ||= []).push(x); }
    let tt = 0; for (const x of T.pl.values()) tt += x.v[7]; tot += tt;
    for (const [ps, a] of Object.entries(by)) { a.sort((u, v) => (v.v[6] + v.v[3]) - (u.v[6] + u.v[3])); a.forEach((x, r) => { const k = slotKey(ps, r + 1); td[k] = (td[k] || 0) + x.v[7]; ap[k] = (ap[k] || 0) + 1; const D = (dvs[T.def] ||= {}); D[k] = (D[k] || 0) + x.v[7]; D._t = (D._t || 0) + x.v[7]; n.set(x.id, (n.get(x.id) || 0) + tt); }); } }
  const m = {}; for (const k in td) m[k] = td[k] / Math.max(1, tot); return { m, n, dvs, tot }; }
function tweakDS(I, W, S) { if (!DS && !DSO) return; const Pr = dsPrior(S, W); if (Pr.tot < 40) return;
  I.teams.forEach((t, k) => { const P = t.players; const L = P.reduce((a, p) => a + (p.lam || 0), 0); if (!(L > 0)) return; const cnt = {}; const opp = I.teams[1 - k].team || I.teams[1 - k].abbr;
    const ord = P.map((p, i) => [i, p.lam || 0]).sort((a, b) => b[1] - a[1]); const nw = new Array(P.length).fill(0);
    for (const [i] of ord) { const p = P[i]; const ps = p.pos === 'FB' ? 'RB' : p.pos; if (!['QB', 'RB', 'WR', 'TE'].includes(ps)) { nw[i] = (p.lam || 0) / L; continue; } cnt[ps] = (cnt[ps] || 0) + 1; const key = slotKey(ps, cnt[ps]);
      const sh = (p.lam || 0) / L; let v = sh; if (DS) { const n = Pr.n.get(p.gsis) || Pr.n.get(p.id) || 0; v = (n * sh + DS * (Pr.m[key] || 0)) / (n + DS); }
      if (DSO) { const D = Pr.dvs[opp]; if (D && D._t > 0 && Pr.m[key] > 0) { const kk = 8; const r = ((D[key] || 0) + kk * Pr.m[key]) / (D._t + kk) / Pr.m[key]; v *= Math.pow(r, DSO); } }
      nw[i] = v; }
    const z = nw.reduce((a, b) => a + b, 0); if (z > 0) P.forEach((p, i) => { const o = (p.lam || 0) / L; if (o > 0) p.dsm = Math.max(0.33, Math.min(3, (nw[i] / z) / o)); }); }); }
function tweak423(I, W) { if (!HVY && !RZF && !GATE && DEPTH === 1 && LOWSNAP === 1 && I5FLAT === 1) return; const X = I.pbp; if (!X?.usage) return;
  I.teams.forEach((ti, k) => { const pl = ti.players || []; let U = X.usage[k]; if (!U) return; X.usage[k] = U = U.map(u => ({ ...u, mt: [...u.mt], mc: [...u.mc] }));
    const F = pl.map(p => rzf(W, ti.team, p.name)); const nq = pl.map(p => p.pos !== 'QB');
    const rz = (i, m) => { for (let c = 2; c < 8; c++) { U[i].mt[c] *= m; U[i].mc[c] *= m; } };
    if (DEPTH !== 1) for (const ps of ['WR', 'TE']) { const ix = pl.map((p, i) => i).filter(i => pl[i].pos === ps).sort((a, b) => pl[b].tgt - pl[a].tgt); const sl = ps === 'WR' ? [1, 2] : [1, 2]; for (const r of sl) if (ix[r] != null) rz(ix[r], DEPTH); }

    if (HVY) pl.forEach((p, i) => { if (!HVYPOS.includes(p.pos)) return; const f = ROTO[`${W}|${ti.team}|${nmK(p.name)}`]; if (!f || f[HVYK] == null) return; const n = f[HVYK + 'n'] || 0; const m = 1 + HVY * f[HVYK] * n / (n + HVYS); for (let c = 2; c < 8; c++) U[i].mt[c] *= m; });
    if (LOWSNAP !== 1) pl.forEach((p, i) => { const sn = F[i].snap; if (nq[i] && sn != null && sn >= 0.2 && sn < 0.4) rz(i, LOWSNAP); });
    if (I5FLAT !== 1) { const rb = pl.map((p, i) => i).filter(i => pl[i].pos === 'RB').sort((a, b) => pl[b].car - pl[a].car)[0]; if (rb != null) for (const c of [6, 7]) U[rb].mc[c] *= I5FLAT; }
    if (GATE) pl.forEach((p, i) => { const sn = F[i].snap; if (nq[i] && sn != null && sn < GATE) for (let c = 2; c < 8; c++) { U[i].mt[c] *= sn / GATE; U[i].mc[c] *= sn / GATE; } });
    if (RZF) for (const kind of ['C', 'T']) ZG.forEach((cells, g) => { const key = featK(RZF, g, kind); if (!key) return; const ok = i => nq[i] && (!key.startsWith('tL') || ['WR', 'TE'].includes(pl[i].pos)); const vol = i => kind === 'C' ? pl[i].car * U[i].mc[cells[0]] : pl[i].tgt * U[i].mt[cells[0]];
      const cur = pl.map((p, i) => ok(i) ? vol(i) : 0); const cs = cur.reduce((x, y) => x + y, 0); if (!(cs > 0)) return;
      let tg = pl.map((p, i) => ok(i) ? (key === 'AIR' ? (['WR', 'TE'].includes(p.pos) ? 0.5 * (F[i].ez || 0) + 0.5 * (F[i].air || 0) : (F[i].t || 0)) : (F[i][key] || 0)) * (RZF === 'snapw' ? Math.sqrt(Math.min(1.2, (F[i].snap ?? 0.3) / 0.6)) : 1) : 0); const ts = tg.reduce((x, y) => x + y, 0); if (!(ts > 0)) return;
      pl.forEach((p, i) => { if (!ok(i)) return; const m = Math.min(2, Math.max(0.5, Math.pow((tg[i] / ts + 0.02) / (cur[i] / cs + 0.02), RZB) ** (1))); for (const c of cells) { if (kind === 'C') U[i].mc[c] *= m; else U[i].mt[c] *= m; } }); }); }); }
const lgRows = []; const lgt = x => Math.log(Math.max(1e-4, Math.min(1 - 1e-4, x)) / (1 - Math.max(1e-4, Math.min(1 - 1e-4, x))));
function fitLogit(rows, W) { const R = rows.filter(r => r.w < W); if (R.length < 300) return null; const d = R[0].x.length; let b = new Array(d).fill(0); b[0] = 1; const lam = 2;
  for (let it = 0; it < 25; it++) { const g = new Array(d).fill(0), H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (const r of R) { const z = r.x.reduce((a, x, k) => a + x * b[k], 0) + r.o0; const q = 1 / (1 + Math.exp(-z)); for (let a = 0; a < d; a++) { g[a] += (r.y - q) * r.x[a]; for (let c = 0; c < d; c++) H[a][c] += q * (1 - q) * r.x[a] * r.x[c]; } }
    for (let a = 1; a < d; a++) { g[a] -= lam * b[a]; H[a][a] += lam; } g[0] -= lam * (b[0] - 1); H[0][0] += lam;
    // solve H dx = g (gauss)
    const M = H.map((row, i) => [...row, g[i]]); for (let i = 0; i < d; i++) { let mx = i; for (let r = i + 1; r < d; r++) if (Math.abs(M[r][i]) > Math.abs(M[mx][i])) mx = r; [M[i], M[mx]] = [M[mx], M[i]]; for (let r = 0; r < d; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c <= d; c++) M[r][c] -= f * M[i][c]; } }
    b = b.map((v, i) => v + M[i][d] / M[i][i]); } return b; }
function tweak422(I, P, W) { if (!SNAP_A && !SNAP_L && !INJ) return; for (const ti of I.teams) { const pl = ti.players || [];
  for (const p of pl) { if (p.pos === 'QB') continue; let m = 1; if (SNAP_A) m *= Math.pow(snapTrend(ti.team, p.name, W), SNAP_A);
    if (SNAP_L) { const mates = pl.filter(q => q.pos === p.pos).map(q => snapAvg(ti.team, q.name, W)).filter(x => x != null); const v = snapAvg(ti.team, p.name, W); if (v != null && mates.length) { const mu = mates.reduce((s, x) => s + x, 0) / mates.length; m *= Math.min(2, Math.max(0.5, Math.pow((v + 0.1) / (mu + 0.1), SNAP_L))); } }
    if (m !== 1) { if (p.lam != null) p.lam *= m; p.tgt *= m; p.car *= m; } }
  if (INJ) for (const pos of ['RB', 'WR', 'TE']) { const on = pl.filter(p => p.pos === pos); if (!on.length) continue; const team = ti.team;
    const miss = P.filter(p => p.team === team && p.pos === pos && !(p.avail.factor > 0)).reduce((s, p) => s + (snapAvg(team, p.name, W) || 0), 0); if (!(miss > 0.3)) continue;
    const sn = on.map(p => snapAvg(team, p.name, W) || 0.05); const tot = sn.reduce((s, x) => s + x, 0);
    on.forEach((p, i) => { const m = 1 + INJ * miss * (sn[i] / tot) / Math.max(0.05, sn[i]); const mm = Math.min(1.6, m); if (p.lam != null) p.lam *= mm; p.tgt *= mm; p.car *= mm; }); } } } const ensRows = [];
if (process.env.PBP_TUNE) Object.assign(SIM_PBP_TUNE, JSON.parse(process.env.PBP_TUNE)); // t85u research knobs
if (process.env.PBP_DVP != null) SIM_PBP_TUNE.dvp = +process.env.PBP_DVP; if (process.env.PBP_LATE != null) SIM_PBP_TUNE.late = +process.env.PBP_LATE; // 4.19.0 research knobs
const KS = ['driveNew', 'pbp2New', 'drive417', 'pbp417', ...(HIST3 ? ['driveHist3', 'pbpHist3', ...(HIST3_FADE ? ['driveFade', 'pbpFade'] : [])] : []), ...(NORM ? ['driveN'] : []), ...(VAR ? ['driveV', 'pbpV'] : []), ...(process.env.TD_SD != null ? ['driveG'] : []), 'drive4131', 'pbp4131', 'drive413', 'pbp413', 'model', 'naive', 'sleeper']; // 4.14.0: driveNew / pbp2New = 4.14 (weekly roster + carried rates + rookie/depth priors + 1% floor); driveG = driveNew + per-game team TD multiplier (research); drive4131 / pbp4131 = 4.13.1 as shipped
if (process.env.KS_ONLY) { const keep = new Set(process.env.KS_ONLY.split(',')); for (let i = KS.length - 1; i >= 0; i--) if (!keep.has(KS[i])) KS.splice(i, 1); } // research: run a subset of engines
const SIM_KS = new Set(['driveNew', 'pbp2New', 'drive417', 'pbp417', 'driveHist3', 'pbpHist3', 'driveFade', 'pbpFade', 'driveN', 'driveV', 'pbpV', 'driveG', 'drive4131', 'pbp4131', 'drive413', 'pbp413']);
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
    // 4.18.0 season-only inputs (driveNew / pbp2New): this season's games before W only; 4.17 (drive417 / pbp417) keeps the prior-season inputs
    const PP26 = SIMS ? fitPbp([TAB[S]], { season: S, before: W, opts: { seasonOnly: true, pressure: PRESS, ...(process.env.PBP_HL ? { halfLife: +process.env.PBP_HL } : {}), ...(process.env.KUSE ? { kUse: +process.env.KUSE } : {}) } }) : null; const td26 = buildTdShare([TAB[S]], { season: S, before: W, opts: { seasonOnly: true, ...(process.env.TD_HL ? { halfLife: +process.env.TD_HL } : {}) } });
    const D26 = SIMS && W > 1 ? D : null; const CTX26 = { ...fitContext(contextRows(GROWS, [S], { before: W })), seasons: [S] };
    // research hist3: constant multi-year weights; fade: week-varying weights (null => season-only).
    const tabsH = HIST3 ? [2023, 2024, 2025, 2026].map(s => TAB[s]).filter(Boolean) : null;
    const pwH = (HIST3 && S === 2026) ? HIST3W : null;
    const pwF = (HIST3_FADE && S === 2026) ? priorWAt(W) : null;
    const PPHist = (SIMS && pwH && tabsH) ? fitPbp(tabsH, { season: S, before: W, opts: { priorW: pwH, pressure: PRESS } }) : null;
    const tdHist = (pwH && tabsH) ? buildTdShare(tabsH, { season: S, before: W, opts: { priorW: pwH } }) : null;
    const CTXHist = pwH ? { ...fitContext(contextRows(GROWS, [2023, 2024, 2025])), seasons: [2023, 2024, 2025] } : null;
    const UPHist = pwH ? buildUsagePrior(tallies, S, { priorW: pwH }) : null;
    const TSHist = pwH ? blendTsPrior(pwH) : null;
    const PPFade = (SIMS && pwF && tabsH) ? fitPbp(tabsH, { season: S, before: W, opts: { priorW: pwF, pressure: PRESS } }) : null;
    const tdFade = (pwF && tabsH) ? buildTdShare(tabsH, { season: S, before: W, opts: { priorW: pwF } }) : null;
    const CTXFade = pwF ? { ...fitContext(contextRows(GROWS, [2023, 2024, 2025])), seasons: [2023, 2024, 2025] } : null;
    const UPFade = pwF ? buildUsagePrior(tallies, S, { priorW: pwF }) : null;
    const TSFade = pwF ? blendTsPrior(pwF) : null;
    const B = fitBlend([...priorDetail, ...detail]); blends.push({ w: W, alpha: B.alpha, beta: B.beta, fitted: B.fitted, tds: B.n });
    const naive = naiveOf(S, W);
    for (const gid of [...new Set(R.map(r => r.gameId))]) {
      const gm = G.get(gid); if (!gm) continue; const GR = R.filter(r => r.gameId === gid && r.pos !== 'K');
      const P = GR.map(r => { const gsis = s2g.get(String(r.id)) || null; const av = availOf(S, W, gsis); const f = av.factor; const sc = x => x == null ? x : x * f;
        return { id: String(r.id), gsis, name: r.name, pos: r.pos, team: r.team, avail: { factor: f, status: av.status }, chance: f ? 1 - Math.exp(-(r.lambda || 0) * f) : 0, lambda: (r.lambda || 0) * f, components: r.components,
          vol: { ...r.vol, targets: sc(r.vol?.targets || 0), carries: sc(r.vol?.carries || 0) }, volume: r.volume, published: r.published, y: r.y ? 1 : 0, td: r.td || 0, teamLambda: r.teamLambda, tdBudget: r.tdBudget }; });
      const sideFor = t => { const pl = P.filter(p => p.team === t); return pl.length ? { players: pl, opp: t === gm.away ? gm.home : gm.away, teamLambda: pl[0].teamLambda, tdBudget: pl[0].tdBudget } : null; };
      if (process.env.MODELROWS) fs.appendFileSync(process.env.MODELROWS, P.filter(p => p.avail.factor > 0).map(p => JSON.stringify({ w: W, gid, team: p.team, name: p.name, pos: p.pos, model: p.chance, y: p.y, tgt: p.vol?.targets, car: p.vol?.carries }) + '\n').join('')); // t99u research dump
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
        const In417 = buildSimInputs(D, { away: gm.away, home: gm.home, gameId: gid, tdShare: td, rosterNow: rosterWeek(S, W, true), dataOpts: DATA_OPTS_417, usagePrior: UPS[S], tsPrior: W > 1 ? TSP[S] : null, ctx: { ...gm.ctx, fit: CTXF[S] }, ...tb }); // 4.17 as shipped (prior-season inputs)
        InD = D26 ? buildSimInputs(D26, { away: gm.away, home: gm.home, gameId: gid, tdShare: td26, rosterNow: rosterWeek(S, W, true), dataOpts: DATA_OPTS, ctx: { ...gm.ctx, fit: CTX26 }, ...tb }) : null; // 4.18 app default: this season only, model-free, market-free
        if (InD) assertSeasonOnly(InD); if (!InD) InD = In417; // week 1 has no this-season games: the season-only engines are skipped (run with --weeks 2,...)
        const InO = buildSimInputs(D, { away: gm.away, home: gm.home, gameId: gid, tdShare: td, rosterNow: rosterOf(S, W), dataOpts: OLD_OPTS, ...tb }); // 4.13.1 as shipped
        // research hist3 (constant weights) / fade (week-varying; season-only when pwF null)
        const InHist3 = (HIST3 && D && tdHist) ? buildSimInputs(D, { away: gm.away, home: gm.home, gameId: gid, tdShare: tdHist, rosterNow: rosterWeek(S, W, true), dataOpts: DATA_OPTS_417, usagePrior: UPHist || UP_HIST3, tsPrior: W > 1 ? (TSHist || TSP_HIST3) : null, ctx: { ...gm.ctx, fit: CTXHist || CTXF[S] }, ...tb }) : null;
        const InFade = !HIST3_FADE || !D ? null : (pwF && tdFade)
          ? buildSimInputs(D, { away: gm.away, home: gm.home, gameId: gid, tdShare: tdFade, rosterNow: rosterWeek(S, W, true), dataOpts: DATA_OPTS_417, usagePrior: UPFade, tsPrior: W > 1 ? TSFade : null, ctx: { ...gm.ctx, fit: CTXFade || CTXF[S] }, ...tb })
          : (D26 ? InD : null);
        for (const I0 of [InD, InO, In417, InHist3, InFade]) if (I0) assertMarketFree(I0); // throws on any model or betting-market source (no Vegas totals / spreads / implied / odds / Sleeper prices)
        const InG = { ...InD, tdSd: TD_SD };
        const InV = VAR && D26 ? buildSimInputs(D26, { away: gm.away, home: gm.home, gameId: gid, tdShare: td26, rosterNow: rosterWeek(S, W, true), dataOpts: { ...DATA_OPTS, ...VAR }, ctx: { ...gm.ctx, fit: CTX26 }, ...tb, ...(VAR.fitBeta ? { tdBlend: (() => { const F = fitDataBeta([...priorDetail, ...detail]); betas.push({ S, W, ...F }); return F; })() } : {}) }) : null; if (InV) assertMarketFree(InV);
        const keep = (S0, I0, sm) => Object.assign(sm, { __S: S0, __I: I0 });
        const dr = I0 => { const S0 = runSim(I0, { n: NS, seed: SEED, mode: 'free' }); return keep(S0, I0, summarize(S0, I0)); };
        const pb = (I0, P0) => { const PP0 = P0 ?? (I0.seasonOnly ? PP26 : PP); const I = buildPbpInputs(I0, PP0); if (I0.seasonOnly) { assertSeasonOnly(I); tweak422(I, P, W); tweak423(I, W); tweakDS(I, W, S); } const S0 = runPbp(I, { n: NS, seed: SEED }); return keep(S0, I, summarizePbp(S0, I)); };
        const run = { drive413: () => dr(In2), pbp413: () => pb(In2), driveNew: () => dr(InD), pbp2New: () => pb(InD), drive417: () => dr(In417), pbp417: () => pb(In417), ...(InHist3 ? { driveHist3: () => dr(InHist3), pbpHist3: () => pb(InHist3, PPHist) } : {}), ...(InFade ? { driveFade: () => dr(InFade), pbpFade: () => pb(InFade, pwF ? PPFade : PP26) } : {}), driveG: () => dr(InG), ...(InV ? { driveV: () => dr(InV), pbpV: () => pb(InV) } : {}), drive4131: () => dr(InO), pbp4131: () => pb(InO) };
        for (const [k, f] of Object.entries(run)) { if ((ENG && !ENG.includes(k)) || !KS.includes(k)) continue; const s = f(); for (const p of live) prob[p.id][k] = 0; for (const x of s.players) if (prob[x.id]) prob[x.id][k] = x.anytime; else { const m = (x.gsis && live.find(p => p.gsis === x.gsis)) || (NAMEMATCH && live.find(p => p.team === x.team && p.name === x.name && !prob[p.id][k])); if (m) prob[m.id][k] = x.anytime; }
          if (DUMP && s.__S) dumpTeams(DUMP, S, W, gid, k, s.__S, s.__I, live, k === 'pbp2New' ? pbpSummary(s.__S, s, s.__I) : null);
          if (k === 'driveNew' || k === 'pbp2New') { const su = surprise(s.__S, s.players); sur[k] = { p: r3(su.pOutside), share: r3(su.shareOutside), ls: su.longshots.map(x => ({ n: x.name, t: x.team, p: x.pos, pr: r3(x.p) })) }; } }
      }
      // 4.21 research: ensemble pbp2New with driveNew; ENS=<w> fixed weight on drive, ENS=fit picks w from earlier weeks' rows (log loss grid)
      if (process.env.ENS && prob[live[0]?.id]?.driveNew != null) { const ll = w => { let s = 0; for (const r of ensRows) { const q = Math.min(0.999, Math.max(1e-4, (1 - w) * r.a + w * r.b)); s -= r.y ? Math.log(q) : Math.log(1 - q); } return s; };
        const w = process.env.ENS === 'fit' ? (ensRows.length ? [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].reduce((b, x) => ll(x) < ll(b) ? x : b, 0) : 0.3) : +process.env.ENS;
        for (const p of live) { const a = prob[p.id].pbp2New || 0, b = prob[p.id].driveNew || 0; ensRows.push({ a, b, y: p.y ? 1 : 0 }); if (process.env.ENS_RANK) prob[p.id].pbpRank = a; prob[p.id].pbp2New = (1 - w) * a + w * b; } if (process.env.ENS === 'fit') console.error('ens w', W, w); }
      // 4.20.0 post layer on the default play-by-play sim (pbp2New): fits read earlier weeks' rows only
      if (prob[live[0]?.id]?.pbp2New != null) { const F = POST.floor ? fitFloor(postRows, W) : null, C = POST.cal ? fitCal(postRows, W) : null;
        for (const p of live) { const raw = prob[p.id].pbp2New; postRows.push({ w: W, pos: p.pos === 'FB' ? 'RB' : p.pos, p: raw, y: p.y ? 1 : 0 }); prob[p.id].pbp2New = applyPost(raw, p.pos, F, C); }  if (LOGIT) { const B = fitLogit(lgRows, W); for (const p of live) { const raw = prob[p.id].pbp2New; const f = rzf(W, p.team, p.name); const sn = f.snap ?? 0.3; const x = [lgt(raw), sn - 0.5, Math.max(0, 0.3 - sn), (f.c || 0), (f.t || 0)]; lgRows.push({ w: W, x, o0: 0, y: p.y ? 1 : 0 }); if (B) prob[p.id].pbp2New = 1 / (1 + Math.exp(-x.reduce((a, v, k) => a + v * B[k], 0))); } if (B && W === 8) console.error('logit', B.map(v => v.toFixed(3)).join(',')); } }
      // research (audit idea 2): driveN = driveNew with the game's summed TD intensity (sum of -ln(1-p)) rescaled to this season's league
      // offensive rush/rec TDs per game before W (2026 games only), NORM = shrink weight 0..1
      if (NORM && prob[live[0]?.id]?.driveNew != null) { const lg = LG26(S, W); const lam = live.map(p => -Math.log(1 - Math.min(0.995, prob[p.id].driveNew || 0))); const tot = lam.reduce((a, b) => a + b, 0);
        const f = tot > 0 && lg > 0 ? Math.pow(lg / tot, NORM) : 1; live.forEach((p, i) => { prob[p.id].driveN = 1 - Math.exp(-lam[i] * f); }); normF.push(f); }
      if (DUMP) DUMP.push({ S, W, gid, eng: 'actual', act: act.map(x => ({ id: x.id, team: x.team, pos: x.pos, td: x.td, n: x.name })) });
      const roleOf = new Map(); if (InD) for (const t of InD.teams) for (const p of t.players) if (p.gsis) roleOf.set(p.gsis, STAR_SLOTS.has(p.slot) ? 'star' : 'role');
      const isRole = p => (p.gsis && roleOf.get(p.gsis)) !== 'star'; // unlisted / depth players = role
      const scored = new Set(live.filter(p => p.y).map(p => p.id)); const roleSc = live.filter(p => p.y && isRole(p)).length; const rec = { gid, w: W, away: gm.away, home: gm.home, score: [gm.as, gm.hs], picks: {}, hits: {}, actual: act.map(x => ({ n: x.name, t: x.team, p: x.pos, td: x.td })), out: P.filter(p => p.avail.factor === 0 && (p.lambda > 0 || p.vol.targets + p.vol.carries > 3)).length, surprise: sur, roleSc, scorers: scored.size };
      for (const k of KS) { const cand = live.filter((p, i) => prob[p.id][k] != null && (k !== 'sleeper' || prob[p.id][k] > 0) && (SIM_KS.has(k) || k === 'naive' || i < legacyN)); if (cand.length < 4 || (k === 'sleeper' && cand.length < 8)) continue;
        const top = cand.sort((a, b) => (k === 'pbp2New' && prob[b.id].pbpRank != null ? prob[b.id].pbpRank - prob[a.id].pbpRank : prob[b.id][k] - prob[a.id][k]) || b.lambda - a.lambda).slice(0, 4); rec.picks[k] = top.map(p => ({ id: p.id, n: p.name, t: p.team, p: p.pos, pr: k === 'naive' ? null : r3(prob[p.id][k]), hit: scored.has(p.id) ? 1 : 0, role: isRole(p) ? 1 : 0, sl: p.gsis ? (InD?.teams.flatMap(t => t.players).find(q => q.gsis === p.gsis)?.slot || null) : null })); rec.hits[k] = top.filter(p => scored.has(p.id)).length; }
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
const DUMP = process.env.DUMP ? [] : null; const NAMEMATCH = !!+(process.env.NAMEMATCH || 0); // t89u: match sim players to pool rows by team + name when ids / gsis differ (scoring fix, research)
// per team-game: sim TD count distribution, each player's share of the team's simulated TDs, his sim anytime chance, depth role, actual TDs
function dumpTeams(out, S, W, gid, eng, Sim, I, live, PS) { const rzOf = new Map((PS?.players || []).map(x => [x.team + '|' + x.name, x]));
  for (let k = 0; k < 2; k++) { const T = I.teams[k]; const P = Sim.P[k], b = Sim.base[k]; const tot = new Float64Array(P), any = new Float64Array(P), rt = new Float64Array(P); const hist = new Array(12).fill(0);
    for (let g = 0; g < Sim.n; g++) { let c = 0; for (let i = 0; i < P; i++) { const v = Sim.G.td[g * Sim.NP + b + i]; tot[i] += v; rt[i] += Sim.G.rtd ? Sim.G.rtd[g * Sim.NP + b + i] : 0; if (v > 0) any[i]++; c += v; } hist[Math.min(11, c)]++; }
    const ttot = tot.reduce((a, x) => a + x, 0) || 1; const byId = new Map(T.players.map((p, i) => [String(p.id), i])); for (const [i, p] of T.players.entries()) if (p.gsis && !byId.has('g:' + p.gsis)) byId.set('g:' + p.gsis, i); const seen = new Set(); if (NAMEMATCH) { const byN = new Map(T.players.map((p, i) => [p.name, i])); for (const p of live) if (p.team === T.team && !byId.has(p.id) && byN.has(p.name)) byId.set(p.id, byN.get(p.name)); }
    const lv = live.filter(p => p.team === T.team);
    out.push({ S, W, gid, eng, team: T.team, hist: hist.map(x => x / Sim.n), pl: lv.map(p => { const i = byId.get(p.id); if (i != null) seen.add(i); return { id: p.id, n: p.name, pos: p.pos, tgt: p.vol.targets, car: p.vol.carries, lam: p.lambda, sh: i == null ? 0 : tot[i] / ttot, mt: i == null ? 0 : tot[i] / Sim.n, mr: i == null ? 0 : rt[i] / Sim.n, rtd: rtdOf(S, W, T.team, p.gsis), any: i == null ? 0 : any[i] / Sim.n, td: p.td, ...(rzOf.size ? (({ carRz, carI10, carI5, tgtRz, tgtI10 }) => ({ carRz, carI10, carI5, tgtRz, tgtI10 }))(rzOf.get(T.team + '|' + p.name) || {}) : {}) }; }) }); out[out.length - 1].lost = T.players.map((p, i) => ({ n: p.name, pos: p.pos, mt: tot[i] / Sim.n })).filter((x, i) => !seen.has(i) && x.mt > 0.005); } }
const ONLY = arg('--weeks', null)?.split(',').map(Number);
const B25 = DO25 ? await season(2025, wk(2025).filter(w => w >= 2), []) : { games: [], players: [], detail: [], blends: [] };
const B26 = await season(2026, wk(2026).filter(w => !ONLY || ONLY.includes(w)), B25.detail);
const summ = B => ({ games: B.games.length, weeks: [...new Set(B.games.map(g => g.w))], top4: top4Table(B.games), anytime: brierTable(B.players.filter(r => r.legacy)), anytimeRosterPool: brierTable(B.players), roleScorerShare: r3(B.games.reduce((a, g) => a + g.roleSc, 0) / Math.max(1, B.games.reduce((a, g) => a + g.scorers, 0))), scorerSplit: allocLL(B.detail, B.blends), tdsByPosition: posMix(B.detail, B.blends), blendByWeek: B.blends, ...(process.env.BYWEEK ? { byWeek: Object.fromEntries([...new Set(B.players.map(r => r.w))].map(w => [w, brierTable(B.players.filter(r => r.w === w)).all])) } : {}) });
const best = s => Object.entries(s.top4).filter(([k]) => KS.includes(k)).sort((a, b) => b[1].hitsPerGame - a[1].hitsPerGame)[0]?.[0];
const S26 = summ(B26), S25 = DO25 ? summ(B25) : null;
// 4.18.0: week buckets (early season = thin 2026 samples)
const bucket = (B, f) => { const g = B.games.filter(x => f(x.w)), p = B.players.filter(r => f(r.w)); if (!g.length) return null; const T = top4Table(g), A = brierTable(p).all;
  return { games: g.length, weeks: [...new Set(g.map(x => x.w))], hits: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v?.hitsPerGame ?? null])), logLoss: Object.fromEntries(Object.entries(A || {}).map(([k, v]) => [k, v?.logLoss ?? null])) }; };
S26.buckets = { early: bucket(B26, w => w <= 4), later: bucket(B26, w => w > 4) };
const out = { generated: new Date().toISOString(), tdShareVersion: TD_SHARE_VERSION, simPbpVersion: SIM_PBP_VERSION, simsPerGame: SIMS ? NS : 0, seconds: Math.round((Date.now() - t0) / 1000), shippedBlend: TD_BLEND,
  seasonOnly: true, note: '4.19.0: the play-by-play sim adds a defense-vs-position input (each 2026 defense\'s share of rushing / receiving TDs allowed to RB / WR / TE / QB before week W, shrunk toward league, exponent 0.5 on red-zone usage); a 3rd / 4th-down completion effect was tested and left off. 4.18.1: the play-by-play sim (pbp2New) is the default engine; the drive sim (driveNew) is the alternate. 4.18.0: the sims (driveNew / pbp2New) read 2026 data only: 2026 games before week W (drives, play-by-play params, td-share, game context), that week\'s roster and injury report; no 2025 usage, team strength, rates, patterns or shares (assertSeasonOnly). Week 1 is not scored (no 2026 games yet). drive417 / pbp417 = 4.17 as shipped (with 2025 priors). Walk-forward: every input for week W uses data before W only. Hit = a top-4 pick scored a rushing or receiving TD. The sims read no betting-market data (no Vegas totals, spreads, implied totals, win probabilities, Sleeper or sportsbook prices); assertMarketFree throws otherwise. driveNew / pbp2New = 4.14.0 sims (nflverse weekly roster as the pre-game roster, a player\'s rates carried across a team change, rookie / depth priors, 1% per-player floor); drive4131 / pbp4131 = 4.13.1 as shipped; driveNew includes a per-game team TD multiplier (Gamma, sd 0.18) for each team; drive413 / pbp413 = 4.13.0 (model inputs + TD-budget anchor, comparison only). model = shipped anytime chance and sleeper = published price, both comparison baselines only, never sim inputs; naive = season TD leaders. Sims pick from the whole pre-game roster; anytime = Brier / log loss over the model\'s player universe (comparable with model / sleeper), anytimeRosterPool = over the full pre-game roster (players a sim did not list count as 0). Role = anyone outside QB1 / RB1 / WR1 / WR2 / TE1 of the depth order (4.15+: this season’s touches per game played, shrunk toward last season’s per-game usage from nflverse pbp, usage-prior-1; 4.14 used this season only, so stars who missed early games were tagged role). prev = the ' + (process.env.PREV_VERSION || '4.14.0') + ' headline rows from the archive this run replaced. App ' + APP_V + ' (drive sim as of 4.16 slot calibration RB1 1.08 / TE1 1.15 / QB1 1.15): 4.17 tested RB goal-line sharpening, QB rushing-rate scaling, TE1 1.0 / 1.3, per-game TD swing sd 0.10 / 0.28 / 0.40, team red-zone TD-vs-FG habit and 4th-down aggressiveness with paired common-random-number runs (two seeds); none beat the shipped settings in both seasons, so all stay off.',
  // 4.15.0: the previous release's headline rows (PREV=<old archive json>), kept so the card can show before / after
  prev: process.env.PREV ? (() => { const P = JSON.parse(fs.readFileSync(process.env.PREV, 'utf8')); const pick = s => s ? { games: s.games, top4: { driveNew: s.top4?.driveNew || null, pbp2New: s.top4?.pbp2New || null }, logLoss: { driveNew: s.anytime?.all?.driveNew?.logLoss ?? null, pbp2New: s.anytime?.all?.pbp2New?.logLoss ?? null } } : null; return { version: process.env.PREV_VERSION || '4.14.0', season2026: pick(P.season2026), season2025: pick(P.season2025) }; })() : null,
  season2026: { ...S26, best: best(S26) }, season2025: S25 ? { ...S25, best: best(S25) } : null,
  games2026: B26.games.map(g => ({ gid: g.gid, w: g.w, a: g.away, h: g.home, sc: g.score, sim: g.picks.pbp2New || g.picks.driveNew || g.picks.model, simHits: g.hits.pbp2New ?? g.hits.driveNew ?? g.hits.model, drive: g.picks.driveNew ? g.picks.driveNew.map(p => p.n) : null, driveHits: g.hits.driveNew ?? null, // 4.18.1: per-game list = play-by-play (default engine)
    pbp: g.picks.pbp2New ? g.picks.pbp2New.map(p => p.n) : null, pbpHits: g.hits.pbp2New ?? null, modelHits: g.hits.model, sleeperHits: g.hits.sleeper ?? null, naiveHits: g.hits.naive, oldHits: g.hits.drive4131 ?? null, v4131: g.picks.drive4131 ? g.picks.drive4131.map(p => p.n) : null, actual: g.actual, out: g.out, sur: g.surprise?.pbp2New || g.surprise?.driveNew || null, driveSur: g.surprise?.driveNew || null })) };
if (!process.env.NO_WRITE) { fs.mkdirSync(path.join(ROOT, 'archive', 'sim'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'archive', 'sim', 'top4-backtest-2026.json'), JSON.stringify(out)); }
fs.writeFileSync(process.env.DETAIL || '/tmp/top4-detail.json', JSON.stringify({ B25, B26 })); if (DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(DUMP));
console.log(JSON.stringify({ ...out, games2026: out.games2026.length }, null, 1));
