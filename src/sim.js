// ENDZONE game simulator (app 4.9.0; 4.9.2 = team-style, free-running by default — see below). Research / UI only: nothing here feeds the live anytime chance, MODEL_VERSION or the
// challenger gate. Plays a matchup out drive by drive N times from PRE-GAME inputs only:
//   - the model's per-player TD intensity (lambda, after budget + caps) and its projected targets / carries / receptions /
//     yards (+ lead / behind scenario volumes) from this week's slate;
//   - the weekly drive file (archive/drives/<s>/w<w>.json): league drive-result mix by game state, each offense's and each
//     defense's result mix (shrunk), real drives as plays / targets / carries templates, and validated drive patterns
//     (FDR + out-of-sample, strong / moderate only) as bounded touch-share multipliers on matching drives.
// Game state: score, quarter + clock, two-minute drives, possession alternation (opening kick, 2nd-half kick), OT.
// A short pilot (2 x 1,500 games) calibrates per team: TD rate -> model team lambda, seconds per play -> expected drives,
// touch volume / per-player shares / catch rate / yards -> the model's projected means. Seeded PRNG = reproducible.
// 4.9.2: each offense and each defense now comes from its own 2026 drives, opponent-adjusted (src/team-strength.js: ridge
// log-odds fit, recency-weighted, pre-game only). Default mode 'free': drive results, pace, plays per drive, pass rate by game
// script and two-minute scoring come from that fit and are NOT pinned to the model's TD budget / volumes — the model only
// supplies who is on the field and how a team's targets / carries / TDs are shared (so injuries and roles carry through).
// Mode 'anchored' keeps the 4.9.0/4.9.1 behaviour (TD rate -> model team lambda, volume / pass split -> model) for comparison.
export const SIM_VERSION = 'sim-2';
export const SIM_MODES = ['free', 'anchored'];
export const RESULTS = ['TD', 'FG', 'MFG', 'Punt', 'TO', 'Downs', 'Half', 'Safety'];
const RI = Object.fromEntries(RESULTS.map((r, i) => [r, i])); const NR = RESULTS.length;
const TD = 0, FG = 1, MFG = 2, PUNT = 3, TO = 4, DOWNS = 5, HALF = 6, SAF = 7;
export const SLOTS = 16;
// per-drive histogram stats (bins 0..max, values above max fold into max)
export const DSTATS = { tgt: 8, rec: 8, recYd: 60, car: 12, rushYd: 60, tch: 14, td: 1, recYdC: 60, rushYdC: 60 }; // *C = yards on drives where he caught / carried (4.9.1 medians)
const DKEYS = Object.keys(DSTATS); const DOFF = {}; let NB = 0; for (const k of DKEYS) { DOFF[k] = NB; NB += DSTATS[k] + 1; }
export const GSTATS = ['tgt', 'rec', 'recYd', 'car', 'rushYd', 'td', 'passTd'];
export const STAT_LBL = { rec: 'Receptions', recYd: 'Rec yds', car: 'Carries', rushYd: 'Rush yds', tch: 'Touches', td: 'TDs', tgt: 'Targets' };
export const SIM_PRESETS = [['rec', 1], ['rec', 2], ['recYd', 20], ['rushYd', 10], ['rushYd', 20]];
export const GAME_PRESETS = [['rec', 4], ['rec', 6], ['recYd', 50], ['recYd', 80], ['rushYd', 50], ['rushYd', 80], ['td', 2]];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const PAT_SUBS = new Set(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'open', 'h1later', 'first2H', 'lead2H', 'trail2H', 'twoMin']);
const XP = 0.945, DEF_TD_ON_TO = 0.055, RET_TD_ON_PUNT = 0.006;

// ---------- PRNG (sfc32) + samplers
export function makeRng(seed) {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = (seed >>> 0) ^ 0xdeadbeef;
  const R = () => { a |= 0; b |= 0; c |= 0; d |= 0; const t = (((a + b) | 0) + d) | 0; d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0; return (t >>> 0) / 4294967296; };
  for (let i = 0; i < 15; i++) R(); return R;
}
export const hashSeed = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
function normal(R) { let u = 0; while (u === 0) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R()); }
export function gamma(R, k) { // Marsaglia-Tsang, mean k, scale 1
  if (k < 1) return gamma(R, k + 1) * Math.pow(R() || 1e-12, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = normal(R); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = R(); if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
const sround = (x, R) => { const f = Math.floor(x); return f + (R() < x - f ? 1 : 0); };
function pickW(w, tot, R) { let u = R() * tot; for (let i = 0; i < w.length; i++) { u -= w[i]; if (u < 0) return i; } return w.length - 1; }

// ---------- league / team priors from the weekly drive file (cached per file object)
export const bucketOfDrive = d => ((d[3] & 2) ? 1 : (d[9] >= 4 && d[2] >= 9) ? 2 : (d[9] >= 4 && d[2] <= -9) ? 3 : 0); // 0 normal, 1 two-minute, 2 Q4 up 9+, 3 Q4 down 9+
const PRI = new WeakMap();
import { blendShares, TD_BLEND, TD_SHARE_VERSION } from './td-share.js';
import { teamStrength, matchup } from './team-strength.js';
import { availability } from './roster.js';
import { priorOf } from './usage-prior.js';
import { dispFor, temper, anchorFor, surprise, DISP_VERSION } from './usage-var.js';
export function leaguePriors(D) {
  if (D && PRI.has(D)) return PRI.get(D);
  const bk = [0, 1, 2, 3].map(() => new Array(NR).fill(0)); const all = new Array(NR).fill(0); const pool = RESULTS.map(() => []);
  const off = {}, def = {}; const pr = RESULTS.map(() => [0, 0]), pb = [0, 1, 2, 3].map(() => [0, 0]);
  let drives = 0, games = 0, plays = 0, tgt = 0, car = 0;
  const mk = () => ({ n: 0, games: 0, c: new Array(NR).fill(0), pool: RESULTS.map(() => []) });
  for (const [t, T] of Object.entries(D?.teams || {})) {
    const o = off[t] = off[t] || mk();
    for (const g of T.games || []) {
      games++; o.games++; const x = def[g.opp] = def[g.opp] || mk(); x.games++;
      for (const d of g.d) {
        const r = RI[d[5]]; if (r == null) continue; const b = bucketOfDrive(d); const tp = [d[4], d[6], d[7]];
        drives++; plays += d[4]; tgt += d[6]; car += d[7]; bk[b][r]++; all[r]++; o.c[r]++; o.n++; x.c[r]++; x.n++; pool[r].push(tp); o.pool[r].push(tp);
        pr[r][0] += d[6]; pr[r][1] += d[6] + d[7]; pb[b][0] += d[6]; pb[b][1] += d[6] + d[7];
      }
    }
  }
  const pAll = all.map(c => c / Math.max(1, drives));
  const bucket = bk.map(c => { const n = c.reduce((a, b) => a + b, 0); return c.map((v, r) => (v + 40 * pAll[r]) / (n + 40)); });
  const passAll = tgt / Math.max(1, tgt + car);
  const L = { drives, games, dpg: drives / Math.max(1, games), ppd: plays / Math.max(1, drives), tdPerGame: all[TD] / Math.max(1, games), fgPerGame: all[FG] / Math.max(1, games),
    pAll, bucket, pool, passAll, rrRes: pr.map(([a, b]) => b > 20 ? clamp((a / b) / passAll, 0.6, 1.4) : 1), rrBk: pb.map(([a, b]) => b > 20 ? clamp((a / b) / passAll, 0.7, 1.4) : 1), off, def };
  if (D) PRI.set(D, L); return L;
}
// shrunk result-mix index (non-TD outcomes) for an offense or a defense: (count + k*league) / (n + k) / league
export function mixIdx(x, L, k = 60) { return RESULTS.map((_, r) => x && L.pAll[r] > 0 ? ((x.c[r] + k * L.pAll[r]) / (x.n + k)) / L.pAll[r] : 1); }

// ---------- inputs (main thread; plain JSON so they can be posted to the worker)
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
const compSplit = c => { if (!c) return null; let r = 0, t = 0; for (const [k, v] of Object.entries(c)) { if (k[0] === 'r') r += v || 0; else if (k[0] === 't') t += v || 0; } return r + t > 0 ? r / (r + t) : null; };
const DEFAULT_RUSH_TD = { RB: 0.78, FB: 0.6, QB: 1, WR: 0.04, TE: 0.01 };
function patternsFor(D, gsis) {
  const row = gsis ? D?.players?.[gsis] : null; const out = [];
  for (const t of row?.patterns || []) {
    if (!(t.rel === 'strong' || t.rel === 'moderate') || !PAT_SUBS.has(t.sub) || !(t.rest > 0) || !(t.shr >= 0)) continue;
    const m = clamp(t.shr / t.rest, 0.4, 2.5); const w = t.rel === 'strong' ? 1 : 0.5; const mult = Math.exp(w * Math.log(m));
    out.push({ sub: t.sub, metric: t.metric, rel: t.rel, mult: +mult.toFixed(3), text: t.text });
  }
  return out;
}
function modelPlayer(p, D) {
  const v = p.vol || {}, V = p.volume || {}; const tgt = +v.targets || 0, car = +v.carries || 0;
  const lam = Number.isFinite(p.lambda) ? p.lambda : (p.chance > 0 ? -Math.log(1 - Math.min(0.95, p.chance)) : 0);
  const rec = V.rec?.mean ?? tgt * 0.65, recYd = V.recYd?.mean ?? tgt * 7.5, rushYd = V.rushYd?.mean ?? car * 4.2;
  const sc = p.scenarios || {}; const scn = k => sc[k] && sc[k].targets != null ? { t: +sc[k].targets || 0, c: +sc[k].carries || 0 } : null;
  const gsis = p.gsis || D?.bySleeper?.[p.id] || null;
  return { id: String(p.id), gsis, name: p.name, pos: p.pos, lam: Math.max(0, lam), chance: p.chance ?? (1 - Math.exp(-lam)), tgt, car, rec: Math.min(rec, tgt || rec), recYd, rushYd,
    rushTd: compSplit(p.components) ?? DEFAULT_RUSH_TD[p.pos] ?? 0.3, passShare: p.pos === 'QB' ? (p.passTd?.attemptShare ?? 0) : 0, passTdExp: p.passTd?.expected ?? null,
    lead: scn('lead'), behind: scn('behind'), pats: patternsFor(D, gsis) };
}
// 4.13.1 data-players (model-free default): every player input comes from the real drive file only (no model lambda, chance, volumes,
// scenarios or TD budget). Recency-weighted per-game means over the team's last 8 games (weight 0.8^age), players whose latest game
// in the file was for another team are dropped, QB pass share from recent appearances, then rosterNow (Sleeper roster / injury report)
// drops players who left or are out and scales doubtful / questionable ones. TD rate = half own TD/g, half team TD/g x touch share.
// data players' scorer split = td-share-1 alone (recency-weighted red-zone / goal-line shares, real plays only; alpha 1, no position fudge).
// Walk-forward 2025 (200 sims): alpha 1 no-beta LL .3681 drive / .3673 pbp vs alpha .3 .3765 / .3710, alpha .6 .3703 / .3667.
export const DATA_BLEND = { alpha: 1, beta: {} };
const HIST_N = 8, HIST_DECAY = 0.8; const lastTeamCache = new WeakMap(); // walk-forward 2025: 8 / 0.8 vs 17 / 0.9 vs 4 / 0.8 within noise on log loss; 8 / 0.8 best top-4 hits const lastTeamCache = new WeakMap();
function lastTeams(D) {
  let m = lastTeamCache.get(D); if (m) return m; m = new Map();
  for (const [tm, T] of Object.entries(D?.teams || {})) T.games.forEach(gm => { for (const d of gm.d) for (const x of d[8]) { const g = T.people[x[0]]?.[0]; if (!g) continue; const c = m.get(g); if (!c || gm.w > c.w || (gm.w === c.w && c.t !== tm && (gm.game || '') > (c.game || ''))) m.set(g, { t: tm, w: gm.w, game: gm.game }); } });
  lastTeamCache.set(D, m); return m;
}
// 4.14.0 player universe: rostered skill players the team's own drive file does not cover (week-1 signings, trades, returning
// players, rookies) used to get no chance at all. Walk-forward they scored 9.5% of 2026 TDs. Now: (a) carry-forward = the player's
// own recency-weighted per-game line from his last 8 games for ANY team in the file (last season's file in week 1), TD rate shrunk
// to his share of the new team's touches; (b) no history = a small rookie / depth prior by position. Both need rosterNow (today's
// roster: [team, injury, practice, status, pos, name]); the split then goes through td-share-1 like everyone else.
export const DATA_OPTS = { carry: true, rookie: { RB: [0.5, 1.2], WR: [1.2, 0.05], TE: [0.8, 0], QB: [0, 0.3], FB: [0.2, 0.3] }, floor: 0.01, depthCal: null, tdSd: 0.18, priorK: 4 };
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
const byGsisCache = new WeakMap();
function linesByGsis(D) { let m = byGsisCache.get(D); if (m) return m; m = new Map();
  for (const [tm, T] of Object.entries(D?.teams || {})) for (const gm of T.games || []) { const pg = new Map();
    for (const d of gm.d) for (const x of d[8]) { const g = T.people[x[0]]?.[0]; if (!g) continue; const v = pg.get(g) || [0, 0, 0, 0, 0, 0, 0]; v[0] += x[1]; v[1] += x[2]; v[2] += x[3]; v[3] += x[4]; v[4] += x[5]; v[5] += x[7]; v[6] += x[1] + x[4]; pg.set(g, v); }
    for (const [g, v] of pg) { const a = m.get(g) || []; a.push({ t: tm, ord: (gm.season || 0) * 100 + (gm.w || 0), game: gm.game || '', v, pe: T.people.find(q => q[0] === g) }); m.set(g, a); } }
  for (const a of m.values()) a.sort((x, y) => x.ord - y.ord || (x.game > y.game ? 1 : -1)); byGsisCache.set(D, m); return m; }
function extraPlayers(D, team, rosterNow, have, tdpg, touchPg, o, UP = null) {
  if (!rosterNow) return []; const L = linesByGsis(D); const out = []; const seen = new Set();
  for (const [k, r] of Object.entries(rosterNow)) { if (!/^00-/.test(k) || seen.has(k)) continue; seen.add(k); const [tm, , , , pos0, name, exp] = r; if (tm !== team || have.has(k)) continue;
    const hist = L.get(k); const pos = pos0 || hist?.[hist.length - 1]?.pe?.[2]; if (!SKILL.has(pos)) continue;
    let s, src;
    const U = priorOf(UP, k);
    if (o.carry && hist?.length) { const G = hist.slice(-HIST_N); let W = 0; s = [0, 0, 0, 0, 0, 0, 0]; G.forEach((h, i) => { const w = Math.pow(HIST_DECAY, G.length - 1 - i); W += w; for (let j = 0; j < 7; j++) s[j] += w * h.v[j]; }); s = s.map(x => x / W); src = 'carry'; }
    else if (o.carryPrior && U && U.g >= 3 && U.tgt + U.car >= 1) { const f = o.carryPrior; const [cr, ypr, ypc] = POS_EFF[pos] || POS_EFF.WR; // 4.15.0: no drive-file history but a real last season (pbp): his per-game line there, shrunk by f
      s = [f * U.tgt, f * U.tgt * cr, f * U.tgt * cr * ypr, f * U.car, f * U.car * ypc, f * U.td, f * (U.tgt + U.car)]; src = 'season'; }
    else if (o.rookie?.[pos] && !(o.rookieOnly && !(exp === 0 || (exp == null && !hist?.length && o.rookieOnly === 'loose')))) { const [t, c] = o.rookie[pos]; s = [t, t * 0.6, t * 6, c, c * 4, 0, t + c]; src = 'prior'; } else continue;
    if (s[6] < 0.2 && pos !== 'QB') { const [t, c] = o.rookie?.[pos] || [0.3, 0.3]; s = [Math.max(s[0], t * 0.5), s[1], s[2], Math.max(s[3], c * 0.5), s[4], s[5], 0]; s[6] = s[0] + s[3]; }
    const sh = touchPg > 0 ? s[6] / touchPg : 0; const own = src === 'carry' || src === 'season' ? s[5] : 0; const lam = 0.5 * own + 0.5 * tdpg * sh; const pe = hist?.[hist.length - 1]?.pe;
    out.push({ id: String(pe?.[3] || k), gsis: k, name: name || pe?.[1] || k, pos, lam, chance: 1 - Math.exp(-lam), tgt: s[0], car: s[3], rec: s[1], recYd: s[2], rushYd: s[4], rushTd: DEFAULT_RUSH_TD[pos] ?? 0.3, passShare: 0,
      qbScore: 0, passTdExp: null, lead: null, behind: null, pats: patternsFor(D, k), history: true, newcomer: src, depthKey: depthKeyOf(s[6], hist?.length ? Math.min(HIST_N, hist.length) : 0, U, o) }); }
  return out; }
// 4.15.0 depth key (star / role tag + depth order): touches per game he PLAYED this season, shrunk toward his last-season touches per
// game played (real pbp, usage-prior-1) with weight K games, so a star who missed games or is new to the drive file keeps his standing.
const POS_EFF = { RB: [0.78, 7.5, 4.3], WR: [0.63, 12.5, 6], TE: [0.7, 10.5, 4], QB: [0.6, 8, 4.5], FB: [0.75, 7, 3.5] }; // catch rate, yd/rec, yd/carry (league-typical)
function depthKeyOf(cur, n, U, o) { const K = o?.priorK ?? 0; if (!U || !(K > 0) || !(U.g >= 2)) return cur; const pr = U.tgt + U.car; const k = K * Math.min(1, U.g / 8); return (cur * n + pr * k) / (n + k); }
export function dataPlayers(D, team, rosterNow = null, o = DATA_OPTS, UP = null) {
  const T = D?.teams?.[team]; if (!T) return []; const G = T.games.slice(-HIST_N); if (!G.length) return []; const LT = lastTeams(D); const acc = new Map();
  let teamTd = 0, W = 0; G.forEach((gm, gi) => { const w = Math.pow(HIST_DECAY, G.length - 1 - gi); W += w; const seen = new Set(), here = new Set();
    for (const d of gm.d) { if (d[5] === 'TD') teamTd += w; for (const x of d[8]) { const a = acc.get(x[0]) || { s: [0, 0, 0, 0, 0, 0, 0], qb: 0, qbC: 0, gw: 0, n: 0 }; const s = a.s; if (!here.has(x[0])) { here.add(x[0]); a.gw += w; a.n += 1; }
      s[0] += w * x[1]; s[1] += w * x[2]; s[2] += w * x[3]; s[3] += w * x[4]; s[4] += w * x[5]; s[5] += w * x[7]; s[6] += w * (x[1] + x[4]); acc.set(x[0], a);
      if (gi >= G.length - 3) { if (!seen.has(x[0])) { seen.add(x[0]); a.qb += [0.15, 0.4, 1][gi - (G.length - 3)] ?? 0; } a.qbC += x[4] * ([0.15, 0.4, 1][gi - (G.length - 3)] ?? 0); } } } });
  const totT = [...acc.values()].reduce((s, a) => s + a.s[6], 0) || 1; const tdpg = teamTd / W;
  let pl = [...acc.entries()].filter(([pi, a]) => { const pe = T.people[pi]; const lt = LT.get(pe[0]); return (a.s[6] / W >= 0.4 || pe[2] === 'QB') && !(lt && lt.t !== team && rosterNow?.[pe[0]]?.[0] !== team); }).map(([pi, a]) => { const pe = T.people[pi]; const s = a.s; const sh = s[6] / totT; const gp = Math.min(1, a.gw / W); const f = o?.pg ? 1 / Math.max(gp, 0.5) : 1; const lam = f * (0.5 * (s[5] / W) + 0.5 * tdpg * sh); const nG = a.n; // gp = (recency-weighted) share of the team's games he played; pg: rates per game played (missed games don't dilute a returning starter)
    return { id: String(pe[3] || pe[0]), gsis: pe[0], name: pe[1], pos: pe[2], lam, chance: 1 - Math.exp(-lam), tgt: f * s[0] / W, car: f * s[3] / W, rec: f * s[1] / W, recYd: f * s[2] / W, rushYd: f * s[4] / W, gp,
      rushTd: DEFAULT_RUSH_TD[pe[2]] ?? 0.3, passShare: 0, qbScore: pe[2] === 'QB' ? a.qb * (1 + 0.1 * a.qbC) : 0, passTdExp: null, lead: null, behind: null, pats: patternsFor(D, pe[0]), history: true,
      depthKey: depthKeyOf((s[6] / W) / Math.max(0.25, gp), nG, priorOf(UP, pe[0]), o) }; });
  if (o && (o.carry || o.rookie) && rosterNow) pl.push(...extraPlayers(D, team, rosterNow, new Set(pl.map(p => p.gsis)), tdpg, totT / W, o, UP));
  pl = pl.map(p => rosterCheck(p, team, rosterNow)).filter(Boolean);
  const qbs = pl.filter(p => p.pos === 'QB' && p.qbScore > 0); const qs = qbs.reduce((s, p) => s + p.qbScore, 0);
  if (qs > 0) { for (const p of qbs) p.passShare = p.qbScore / qs; const keep = qbs.filter(p => p.passShare >= 0.1), k2 = keep.reduce((s, p) => s + p.passShare, 0); for (const p of qbs) p.passShare = keep.includes(p) ? +(p.passShare / k2).toFixed(3) : 0; }
  pl = pl.filter(p => p.pos !== 'QB' || p.passShare > 0 || p.tgt + p.car >= 0.4); for (const p of pl) delete p.qbScore; return pl;
}
function historyPlayers(D, team, L, rosterNow = null) { return dataPlayers(D, team, rosterNow); }
export function rosterCheck(p, team, rosterNow) {
  if (!rosterNow) return p; const r = rosterNow[p.gsis] || rosterNow[p.id]; if (!r) return p;
  const [tm, injury, practice, status] = r; if (tm && tm !== team) return null;
  const av = availability({ injury, practice, status }); if (av.excluded || !(av.factor > 0)) return null; if (av.factor >= 1) return p;
  const f = av.factor; return { ...p, lam: p.lam * f, chance: 1 - Math.exp(-p.lam * f), tgt: p.tgt * f, car: p.car * f, rec: p.rec * f, recYd: p.recYd * f, rushYd: p.rushYd * f, avail: av.status };
}
// 4.14.0 depth slot of each available player within his position by recent touches (QB: pass-share starter vs backup)
export function depthSlots(players) { const c = {}; const k = new Array(players.length).fill(null);
  const key = p => p.depthKey ?? (p.tgt + p.car) / Math.max(0.25, p.gp ?? 1); // 4.15.0: depthKey (before the injury-report scaling) when set; touches per game he played, so a starter back from injury still ranks as the starter
  players.map((p, i) => i).sort((a, b) => key(players[b]) - key(players[a])).forEach(i => { const p = players[i]; const pos = p.pos === 'FB' ? 'RB' : p.pos;
    if (pos === 'QB') { k[i] = (p.passShare || 0) >= 0.5 ? 'QB1' : 'QB2'; return; } if (!['RB', 'WR', 'TE'].includes(pos)) return; c[pos] = (c[pos] || 0) + 1; k[i] = pos + Math.min(c[pos], pos === 'WR' ? 4 : 3); });
  return k; }
// optional per-slot multipliers on each player's TD rate (team total kept) and a minimum share floor taken out of the team total
export const STAR_SLOTS = new Set(['QB1', 'RB1', 'WR1', 'WR2', 'TE1']); // display tag only: anyone else in the team's depth order is a role player
function applyDepth(players, o) { const ks = depthSlots(players); players.forEach((p, i) => { p.slot = ks[i]; p.role = ks[i] && STAR_SLOTS.has(ks[i]) ? 'star' : 'role'; });
  const lt = sum(players, p => p.lam); if (!(lt > 0)) return; let v = players.map(p => p.lam);
  if (o.depthCal) { const k = depthSlots(players); v = v.map((x, i) => x * (k[i] ? (o.depthCal[k[i]] ?? 1) : 1)); }
  if (o.floor > 0) { const z = v.reduce((a, b) => a + b, 0) || 1; v = v.map(x => Math.max(x / z, o.floor)); }
  const z = v.reduce((a, b) => a + b, 0) || 1; players.forEach((p, i) => { p.lam = lt * v[i] / z; p.chance = 1 - Math.exp(-p.lam); if (p.tdShare != null) p.tdShare = +(v[i] / z).toFixed(4); }); }
// 4.14.0 "strictly on probability": the default sim reads NO betting-market data (no Vegas totals / spreads / implied totals / win
// probabilities, no Sleeper or sportsbook prices, nothing derived from them: the model's TD budget comes from implied points, so it is out too).
// Throws if any market-derived number could reach an engine. Display-only joins (modelChance, modelTeamLambda) are allowed: no engine reads them.
const MARKET_KEYS = ['lines', 'spread', 'implied', 'total', 'published', 'odds', 'moneyline', 'winProb', 'vegas', 'market'];
export function assertMarketFree(I) { const bad = [];
  if (I.source !== 'data') bad.push(`source ${I.source}`); if (I.lines != null) bad.push('lines');
  for (const t of I.teams || []) { if (t.tdBudget != null) bad.push(`${t.team} tdBudget`); if (t.pfModel != null) bad.push(`${t.team} pfModel`);
    for (const k of MARKET_KEYS) if (t[k] != null) bad.push(`${t.team}.${k}`); for (const p of t.players) for (const k of MARKET_KEYS) if (p[k] != null) bad.push(`${p.name}.${k}`); }
  const d = I.disp || {}; for (const e of ['drive', 'pbp']) if (d[e]?.anchor) bad.push(`${e} anchor`);
  if (bad.length) throw new Error('market / model data in sim inputs: ' + bad.join(', ')); return true; }
// sideFor(team) -> { players, opp, teamLambda, tdBudget } from the slate (the team's own game this week) or null
export function buildSimInputs(D, { away, home, sideFor = () => null, gameId = null, mode = 'free', tsOpts = null, tdShare = null, tdBlend = null, rosterNow = null, disp = null, source = null, dataOpts = null, usagePrior = null }) {
  const src0 = source || (mode === 'anchored' ? 'model' : 'data'); // 4.13.1: free mode = data players, no model numbers reach the engine
  const L = leaguePriors(D); const TS = teamStrength(D, tsOpts || {}); const teams = [away, home].map((team, k) => {
    const opp = k ? away : home; const S = sideFor(team); let src = 'model', note = null; let players;
    let modelRef = null; // display-only: the model's chance per player, joined by id AFTER the sim inputs are built (never read by an engine)
    if (src0 === 'data') { players = dataPlayers(D, team, rosterNow, dataOpts || DATA_OPTS, usagePrior); src = 'data'; note = `${team}: volumes, TD rates and QB from its last ${HIST_N} games in the drive file (recency-weighted), checked against today's roster and injury report. No model numbers.`;
      if (S && S.players?.length) { modelRef = new Map(); for (const q of S.players) { const c = q.chance ?? (Number.isFinite(q.lambda) ? 1 - Math.exp(-q.lambda) : null); const g = q.gsis || D?.bySleeper?.[q.id]; if (c != null) { modelRef.set(String(q.id), c); if (g) modelRef.set(g, c); } } }
    } else if (S && S.players?.length) {
      players = S.players.filter(p => !(p.avail?.factor === 0) && ((p.vol?.targets || 0) + (p.vol?.carries || 0) > 0.05 || (p.lambda || 0) > 0.003 || p.pos === 'QB')).map(p => modelPlayer(p, D));
      if (S.opp && S.opp !== opp) { // custom matchup: rescale TD intensity by the two defenses' shrunk TD-per-drive allowed
        const a = D?.defense?.[opp]?.shrunk?.tdPer, b = D?.defense?.[S.opp]?.shrunk?.tdPer; const f = a && b ? clamp(a / b, 0.75, 1.33) : 1;
        for (const p of players) { p.lam *= f; p.chance = 1 - Math.exp(-p.lam); } src = 'model-adjusted'; note = `${team}'s model inputs are from its real game vs ${S.opp}; TD intensity rescaled ×${f.toFixed(2)} for ${opp}'s defense (TD per drive allowed). Volumes unchanged.`;
      }
    } else { players = historyPlayers(D, team, L, rosterNow); src = 'history'; note = `${team} has no model inputs this week (bye or not on the slate): per-game volumes and TD rates from its last 6 games in the drive file, shrunk toward its team TD rate.`; }
    players = players.filter(p => p.tgt + p.car > 0.02 || p.lam > 0.002 || p.passShare > 0);
    // 4.12.0 td-share-1: who scores the team's TDs = the model's split blended with recency-weighted red-zone / goal-line shares
    // (src/td-share.js, fitted on weeks before this one) and a TE bias fix. The team's TD total (sum of lambdas) is unchanged.
    let tdInfo = null;
    if (tdShare && (src !== 'history' || src0 === 'data')) { const B0 = tdBlend || (src0 === 'data' ? DATA_BLEND : TD_BLEND); const bs = blendShares(players, tdShare, opp, B0);
      if (bs) { const lt = sum(players, p => p.lam); players.forEach((p, i) => { p.lamModel = p.lam; p.lam = lt * bs[i].share; p.tdShare = +bs[i].share.toFixed(4); if (bs[i].rushFrac != null) p.rushTd = bs[i].rushFrac; });
        tdInfo = { version: TD_SHARE_VERSION, through: tdShare.through ?? null, alpha: B0.alpha, known: bs.filter(x => x.known).length }; } }
    if (src0 === 'data') applyDepth(players, dataOpts || DATA_OPTS);
    const teamLambda = sum(players, p => p.lam);
    if (modelRef) for (const p of players) { const c = modelRef.get(p.gsis) ?? modelRef.get(p.id); p.modelChance = c ?? null; }
    const M = matchup(TS, team, opp); // opponent-adjusted: this offense vs this defense, by game state
    const pfOf = (sel) => { const t = sum(players, p => sel(p)?.t ?? p.tgt), c = sum(players, p => sel(p)?.c ?? p.car); return t + c > 0 ? t / (t + c) : L.passAll; };
    const pfModel = [pfOf(() => null), pfOf(p => p.lead), pfOf(p => p.behind)];
    return { team, opp, src, note, players, teamLambda, tdShare: tdInfo, tdBudget: src0 === 'data' ? null : (S?.tdBudget ?? null), tdData: +(M.dpg * [0, 1, 2, 3].reduce((a, b) => a + (TS.league.bShare?.[b] ?? (b ? 0 : 1)) * M.mix[b][0], 0)).toFixed(3), modelTeamLambda: S?.teamLambda ?? null, source: src0, dpg: M.dpg,
      mix: M.mix, ppdF: M.ppdF, pf: mode === 'anchored' ? pfModel : M.pf, pfTeam: M.pf, pfModel: src0 === 'data' ? null : pfModel, profile: TS.profiles[team] ? { off: TS.profiles[team].off, lines: TS.profiles[team].lines.off, raw: TS.profiles[team].raw.off } : null,
      defProfile: TS.profiles[opp] ? { team: opp, def: TS.profiles[opp].def, lines: TS.profiles[opp].lines.def, raw: TS.profiles[opp].raw.def } : null,
      tgtTot: sum(players, p => p.tgt), carTot: sum(players, p => p.car) };
  });
  // both teams get (nearly) the same number of possessions: target = mean of the two opponent-adjusted pace estimates (ridge-shrunk to league)
  const tgtDrives = (teams[0].dpg + teams[1].dpg) / 2;
  return { version: SIM_VERSION, mode, source: src0, disp, dispVersion: DISP_VERSION, ts: { version: TS.version, maxW: TS.maxW, drives: TS.nDrives, opts: TS.opts }, gameId, away, home, lines: null, tdSd: src0 === 'data' ? ((dataOpts || DATA_OPTS).tdSd || 0) : 0, teams, targetDrives: +tgtDrives.toFixed(2),
    league: { bucket: L.bucket, pAll: L.pAll, pool: L.pool, rrRes: L.rrRes, rrBk: L.rrBk, dpg: L.dpg, ppd: L.ppd, tdPerGame: L.tdPerGame, fgPerGame: L.fgPerGame, passAll: L.passAll } };
}

// ---------- engine
function makeEngine(I) {
  const free = I.mode !== 'anchored';
  const T = I.teams.map(t => {
    const P = t.players.length; const pl = t.players;
    const wT = [pl.map(p => p.tgt), pl.map(p => p.lead?.t ?? p.tgt), pl.map(p => p.behind?.t ?? p.tgt)];
    const wC = [pl.map(p => p.car), pl.map(p => p.lead?.c ?? p.car), pl.map(p => p.behind?.c ?? p.car)];
    const lam0 = pl.map(p => p.lam), lt0 = lam0.reduce((a, b) => a + b, 0); const dp = dispFor(I, 'drive'); const lamS = temper(lam0, dp.tau); // 4.13.0 usage-var-1
    const lamW = lamS.map(x => x * lt0); const qbs = pl.map(p => p.passShare || 0);
    const cr = pl.map(p => p.tgt > 0 ? clamp(p.rec / p.tgt, 0.2, 0.95) : 0.65);
    const ypr = pl.map(p => p.rec > 0.05 ? clamp(p.recYd / p.rec, 2, 30) : 9);
    const ypc = pl.map(p => p.car > 0.05 ? clamp(p.rushYd / p.car, -1, 12) : 4);
    return { P, pl, wT, wC, lamW, lamTot: lamW.reduce((a, b) => a + b, 0), lamS, kap: dp.kappa, qbs, qbTot: qbs.reduce((a, b) => a + b, 0), cr, ypr, ypc,
      tdMul: free ? 1 : clamp(t.teamLambda / Math.max(0.3, I.targetDrives * avgTd(t)), 0.15, 3), touchMul: t.ppdF || 1, pfOdds: 1, ppdF: t.ppdF || 1 };
  });
  return { I, T, free, spp: 3600 / Math.max(60, 2 * I.targetDrives * I.league.ppd) * 0.97 };
}
const avgTd = t => t.mix ? (0.8 * t.mix[0][TD] + 0.2 * t.mix[1][TD]) : 0.23;
function probsFor(E, k, b) { // drive-result probabilities for team k in bucket b: opponent-adjusted team mix (x tdMul in anchored mode only)
  const t = E.I.teams[k], base = t.mix ? t.mix[b] : E.I.league.bucket[b]; const p = base.slice(); if (E.T[k].tdMul === 1) return p;
  let rest = 0; for (let r = 1; r < NR; r++) rest += p[r];
  // 4.13.0: when the TD-level anchor scales a bucket up, its TD chance stays under 36% and never becomes the single likeliest result (realism ceiling)
  const up = E.T[k].tdMul > 1; let pTd = clamp(base[TD] * E.T[k].tdMul, 0.01, up ? Math.max(base[TD], 0.36) : 0.75);
  if (up) { let pm = 0; for (let r = 1; r < NR; r++) pm = Math.max(pm, p[r]); if (base[TD] < pm) pTd = Math.min(pTd, Math.max(base[TD], 0.98 * pm / (rest + pm))); }
  for (let r = 1; r < NR; r++) p[r] *= (1 - pTd) / rest; p[TD] = pTd; return p;
}
function sampleR(p, R) { let u = R(); for (let r = 0; r < NR; r++) { u -= p[r]; if (u < 0) return r; } return PUNT; }
// 4.14.0 (option, off unless I.tdSd > 0): this game's TD-drive multiplier m ~ Gamma(mean 1, sd tdSd) per team, so a team can have a big or a
// quiet scoring day as a whole (real team TD counts vary more than independent drives give); non-TD results share the rest
function sampleRm(p, m, R) { if (m === 1) return sampleR(p, R); const pt = Math.min(0.75, p[TD] * m); if (R() < pt) return TD; let u = R() * (1 - p[TD]);
  for (let r = 1; r < NR; r++) { u -= p[r]; if (u < 0) return r; } return PUNT; }
// pattern multiplier for one player on one drive context
function patMult(pats, ctx, kind) {
  let m = 1; for (const t of pats) {
    if (kind === 'T' && t.metric === 'carShare') continue; if (kind === 'C' && t.metric === 'tgtShare') continue;
    const s = t.sub; let hit = false;
    if (s[0] === 'd' && s.length <= 3 && s !== 'd') hit = ctx.n === +s.slice(1);
    else if (s === 'open') hit = ctx.n <= 2; else if (s === 'h1later') hit = ctx.half === 1 && ctx.n >= 3; else if (s === 'first2H') hit = ctx.first2H;
    else if (s === 'lead2H') hit = ctx.half === 2 && ctx.diff > 0; else if (s === 'trail2H') hit = ctx.half === 2 && ctx.diff < 0; else if (s === 'twoMin') hit = ctx.two;
    if (hit) m *= t.mult;
  }
  return m;
}
const LOGN = 400;
const TDAGG = 8; // tdAgg layout: 0 rush, 1 receiving, 2-5 Q1-Q4, 6 OT, 7 two-minute drive
export function simulate(I, { n = 10000, seed = 1, record = true, E = null } = {}) {
  E = E || makeEngine(I); const R = makeRng(seed); const L = I.league; const TT = E.T;
  const NP = TT[0].P + TT[1].P; const base = [0, TT[0].P];
  const G = {}; for (const k of GSTATS) G[k] = new Int16Array(n * NP);
  const H = record ? new Uint32Array(NP * SLOTS * NB) : null;
  const slotN = new Uint32Array(2 * SLOTS), slotR = new Uint32Array(2 * SLOTS * NR);
  const score = new Int16Array(n * 2), half = new Int16Array(n * 2), drives = new Uint8Array(n * 2), tds = new Uint8Array(n * 2), fgs = new Uint8Array(n * 2);
  const firstTd = new Int16Array(n), firstScore = new Int8Array(n), ot = new Uint8Array(n), leadCh = new Uint8Array(n), q4trail = new Int8Array(n);
  const tdDriveSlot = new Uint8Array(n * 2); // team's first TD drive number (0 = none)
  // 4.9.1: drive-N cards and TD-scorer patterns
  const kick = new Uint8Array(n); // team (0 away / 1 home) that receives the opening kickoff (coin flip, 50/50)
  const gRes = new Uint8Array(n * 2 * SLOTS).fill(255); // result of each team's drive N per game (255 = no such drive)
  const ftdTeam = new Int16Array(n * 2).fill(-1); // each team's first TD scorer (player index j; -2 = TD with no listed scorer)
  const slotPlays = new Float64Array(2 * SLOTS), slotYds = new Float64Array(2 * SLOTS); // summed plays / skill-player scrimmage yards by drive number
  const tdAgg = new Uint32Array(NP * TDAGG); // per player: rushing TDs, receiving TDs, TDs by quarter (Q1..Q4, OT), two-minute-drive TDs
  const logs = [];
  const probs = [0, 1].map(k => [0, 1, 2, 3].map(b => probsFor(E, k, b)));
  const tdA = E.I.tdSd > 0 ? 1 / (E.I.tdSd * E.I.tdSd) : 0; const gmul = [1, 1];
  const anyPats = TT.map(t => t.pl.some(p => p.pats?.length));
  const tmp = TT.map(t => ({ tgt: new Int16Array(t.P), rec: new Int16Array(t.P), recYd: new Int16Array(t.P), car: new Int16Array(t.P), rushYd: new Int16Array(t.P), td: new Int8Array(t.P), w1: new Float64Array(t.P), w2: new Float64Array(t.P), lw: new Float64Array(t.P), lt: 0 }));
  for (let gi = 0; gi < n; gi++) {
    // 4.13.0: this game's TD-scorer split ~ Dirichlet(kappa * share) (usage-var-1); Infinity keeps the fixed split
    for (let k = 0; k < 2; k++) { const t = TT[k], X = tmp[k]; if (!isFinite(t.kap) || !(t.lamTot > 0)) continue; let s = 0; for (let i = 0; i < t.P; i++) { const v = t.lamS[i] > 0 ? gamma(R, t.kap * t.lamS[i]) : 0; X.lw[i] = v; s += v; } X.lt = s; }
    if (tdA > 0) for (let k = 0; k < 2; k++) gmul[k] = gamma(R, tdA) / tdA;
    const sc = [0, 0], dn = [0, 0]; let hf = 1, tl = 1800, isOt = false; const recv0 = R() < 0.5 ? 0 : 1; kick[gi] = recv0; let pos = recv0; const otPoss = [0, 0];
    let ftd = -1, fsc = -1, lead = 0, lch = 0, first2H = false; const log = gi < LOGN ? [] : null; let safety = 0; let tdSlot = [0, 0];
    let trailedQ4 = 0;
    for (;;) {
      if (++safety > 80) break;
      if (tl <= 0) {
        if (!isOt && hf === 1) { hf = 2; tl = 1800; pos = 1 - recv0; half[gi * 2] = sc[0]; half[gi * 2 + 1] = sc[1]; first2H = true; continue; }
        if (!isOt && sc[0] === sc[1]) { isOt = true; tl = 600; pos = R() < 0.5 ? 0 : 1; continue; }
        break;
      }
      if (isOt && otPoss[0] >= 1 && otPoss[1] >= 1 && sc[0] !== sc[1]) break;
      const k = pos, o = 1 - k, t = TT[k], ti = I.teams[k]; dn[k]++; const dno = dn[k]; const slot = Math.min(dno, SLOTS) - 1; if (isOt) otPoss[k]++;
      const diff = sc[k] - sc[o]; const el = isOt ? 3600 : (hf - 1) * 1800 + (1800 - tl); const qtr = isOt ? 5 : Math.min(4, 1 + Math.floor(el / 900));
      if (qtr === 4 && !isOt && tl <= 900 && trailedQ4 === 0 && sc[0] !== sc[1]) trailedQ4 = sc[0] < sc[1] ? 1 : 2;
      const two = tl <= 120; const b = two ? 1 : (qtr >= 4 && diff >= 9) ? 2 : (qtr >= 4 && diff <= -9) ? 3 : 0;
      const scn = hf === 2 && !isOt ? (diff >= 8 ? 1 : diff <= -8 ? 2 : 0) : 0;
      let r = sampleRm(probs[k][b], gmul[k], R); let guard = 0;
      while (r === HALF && tl > 300 && guard++ < 20) r = sampleRm(probs[k][b], gmul[k], R); // 'end of half' only when the clock can actually run out
      if (r === HALF && tl > 300) r = PUNT;
      const pl = L.pool[r]; const tp0 = pl.length ? pl[(R() * pl.length) | 0] : [6, 3, 3]; const tp = [tp0[0] * t.ppdF, tp0[1], tp0[2]]; // league drive template for this result, stretched to the matchup's plays per drive
      const tl0 = tl; let secs = tp[0] * E.spp * (b === 1 ? 0.42 : b === 2 ? 1.2 : b === 3 ? 0.75 : 1) * (0.75 + 0.5 * R()) + 6;
      if (secs >= tl && r !== HALF) { if (b !== 1 && (r === TD || r === FG) ? R() < 0.4 : (r === TD || r === FG) ? R() < 0.75 : false) { /* scored before the clock ran out */ } else r = HALF; secs = tl; }
      tl -= secs; if (r === HALF) tl = 0;
      // touches
      let tt = sround((tp[1] + tp[2]) * t.touchMul, R); const pf0 = clamp(ti.pf[scn] * L.rrRes[r] * L.rrBk[b], 0.05, 0.95), pf = pf0 * t.pfOdds / (1 - pf0 + pf0 * t.pfOdds);
      let ng = 0; for (let i = 0; i < tt; i++) if (R() < pf) ng++; let nc = tt - ng;
      let scorer = -1, rushTd = false;
      if (r === TD && t.lamTot > 0) { scorer = isFinite(t.kap) && tmp[k].lt > 0 ? pickW(tmp[k].lw, tmp[k].lt, R) : pickW(t.lamW, t.lamTot, R); rushTd = R() < t.pl[scorer].rushTd; if (rushTd) { if (nc === 0) { nc = 1; if (ng > 0) ng--; } nc--; } else { if (ng === 0) { ng = 1; if (nc > 0) nc--; } ng--; } }
      const X = tmp[k]; const touched = [];
      const ctx = { n: dno, half: hf, first2H, diff, two };
      let wT = t.wT[scn], wC = t.wC[scn];
      if (anyPats[k]) { for (let i = 0; i < t.P; i++) { const ps = t.pl[i].pats; X.w1[i] = ps.length ? wT[i] * patMult(ps, ctx, 'T') : wT[i]; X.w2[i] = ps.length ? wC[i] * patMult(ps, ctx, 'C') : wC[i]; } wT = X.w1; wC = X.w2; }
      let sT = 0, sC = 0; for (let i = 0; i < t.P; i++) { sT += wT[i]; sC += wC[i]; }
      const touch = i => { if (X.tgt[i] === 0 && X.car[i] === 0 && X.td[i] === 0) touched.push(i); };
      for (let j = 0; j < ng && sT > 0; j++) { const i = pickW(wT, sT, R); touch(i); X.tgt[i]++; if (R() < t.cr[i]) { X.rec[i]++; X.recYd[i] += Math.round(gamma(R, 1.3) * t.ypr[i] / 1.3); } }
      for (let j = 0; j < nc && sC > 0; j++) { const i = pickW(wC, sC, R); touch(i); X.car[i]++; X.rushYd[i] += Math.round(gamma(R, 1.2) * (t.ypc[i] + 2.5) / 1.2 - 2.5); }
      let passer = -1;
      if (scorer >= 0) { touch(scorer); X.td[scorer]++;
        if (rushTd) { X.car[scorer]++; X.rushYd[scorer] += 1 + Math.floor(-Math.log(R() || 1e-9) * 5); }
        else { X.tgt[scorer]++; X.rec[scorer]++; X.recYd[scorer] += 2 + Math.round(gamma(R, 1) * 12); if (t.qbTot > 0) passer = pickW(t.qbs, t.qbTot, R); } }
      // points + next possession
      let next = o;
      if (r === TD) { sc[k] += 6 + (R() < XP ? 1 : 0); if (ftd < 0) ftd = scorer >= 0 ? base[k] + scorer : -2 - k; if (ftdTeam[gi * 2 + k] === -1) ftdTeam[gi * 2 + k] = scorer >= 0 ? base[k] + scorer : -2;
        if (scorer >= 0) { const a = (base[k] + scorer) * TDAGG; tdAgg[a + (rushTd ? 0 : 1)]++; tdAgg[a + 1 + qtr]++; if (two) tdAgg[a + 7]++; } if (!tdSlot[k]) tdSlot[k] = Math.min(255, dno); }
      else if (r === FG) sc[k] += 3; else if (r === SAF) sc[o] += 2;
      else if (r === TO && R() < DEF_TD_ON_TO) { sc[o] += 7; next = k; if (ftd < 0) ftd = -4 - o; }
      else if (r === PUNT && R() < RET_TD_ON_PUNT) { sc[o] += 7; next = k; if (ftd < 0) ftd = -4 - o; }
      if (fsc < 0 && (sc[0] || sc[1])) fsc = sc[0] > sc[1] ? 0 : 1;
      const ld = Math.sign(sc[0] - sc[1]); if (ld !== 0 && lead !== 0 && ld !== lead) lch++; if (ld !== 0) lead = ld;
      // record
      slotN[k * SLOTS + slot]++; slotR[(k * SLOTS + slot) * NR + r]++; slotPlays[k * SLOTS + slot] += tp[0]; if (dno <= SLOTS) gRes[(gi * 2 + k) * SLOTS + slot] = r;
      let dYds = 0;
      const lg = log ? [k, dno, qtr, tl0, r, tp[0], sc[0], sc[1], []] : null;
      for (const i of touched) {
        const gix = gi * NP + base[k] + i;
        G.tgt[gix] += X.tgt[i]; G.rec[gix] += X.rec[i]; G.recYd[gix] += X.recYd[i]; G.car[gix] += X.car[i]; G.rushYd[gix] += X.rushYd[i]; G.td[gix] += X.td[i];
        if (H) { const h = ((base[k] + i) * SLOTS + slot) * NB; const put = (key, v) => { H[h + DOFF[key] + clamp(v, 0, DSTATS[key])]++; };
          put('tgt', X.tgt[i]); put('rec', X.rec[i]); put('recYd', X.recYd[i]); put('car', X.car[i]); put('rushYd', X.rushYd[i]); put('tch', X.rec[i] + X.car[i]); put('td', X.td[i]); if (X.rec[i]) put('recYdC', X.recYd[i]); if (X.car[i]) put('rushYdC', X.rushYd[i]); }
        if (lg) lg[8].push([i, X.tgt[i], X.rec[i], X.recYd[i], X.car[i], X.rushYd[i], X.td[i]]);
        dYds += X.recYd[i] + X.rushYd[i]; X.tgt[i] = X.rec[i] = X.recYd[i] = X.car[i] = X.rushYd[i] = X.td[i] = 0;
      }
      slotYds[k * SLOTS + slot] += dYds;
      if (passer >= 0) { G.passTd[gi * NP + base[k] + passer]++; if (lg) lg.push(passer); }
      if (log) log.push(lg);
      if (first2H) first2H = false;
      pos = next;
      if (isOt && r !== TD && r !== FG && r !== SAF && otPoss[0] >= 1 && otPoss[1] >= 1 && sc[0] !== sc[1]) break;
    }
    score[gi * 2] = sc[0]; score[gi * 2 + 1] = sc[1]; drives[gi * 2] = dn[0]; drives[gi * 2 + 1] = dn[1];
    firstTd[gi] = ftd; firstScore[gi] = fsc; ot[gi] = isOt ? 1 : 0; leadCh[gi] = lch; q4trail[gi] = trailedQ4; tdDriveSlot[gi * 2] = tdSlot[0]; tdDriveSlot[gi * 2 + 1] = tdSlot[1];
    if (log) logs.push(log);
  }
  for (let gi = 0; gi < n; gi++) for (let k = 0; k < 2; k++) { let c = 0; for (let i = 0; i < TT[k].P; i++) c += G.td[gi * NP + base[k] + i]; tds[gi * 2 + k] = c; }
  return { n, seed, NP, base, P: [TT[0].P, TT[1].P], G, H, slotN, slotR, score, half, drives, tds, firstTd, firstScore, ot, leadCh, q4trail, tdDriveSlot, kick, gRes, ftdTeam, slotPlays, slotYds, tdAgg, logs, spp: E.spp,
    eng: { mode: E.free ? 'free' : 'anchored', tdMul: TT.map(t => t.tdMul), touchMul: TT.map(t => t.touchMul), pfOdds: TT.map(t => t.pfOdds) } };
}
// pilot calibration. Both modes: clock -> the matchup's expected drives (history), per-player SHARES of the team's targets /
// carries and catch rate / yards per catch / per carry -> the model's projections. Anchored mode only (4.9.0/4.9.1):
// team TD rate -> model team lambda, team touches + pass/run split -> model volumes. Free mode leaves team TDs, touches and
// pass rate to the opponent-adjusted team fit.
export function calibrate(I, { pilots = 2, n = 1500, seed = 7 } = {}) {
  const E = makeEngine(I); const hist = []; const free = E.free; const anc = anchorFor(I, 'drive');
  for (let it = 0; it < pilots; it++) {
    const S = simulate(I, { n, seed: seed + it * 101, record: false, E });
    const m = means(S); let dAvg = 0;
    for (let k = 0; k < 2; k++) {
      const t = E.T[k], ti = I.teams[k]; const st = m.team[k]; dAvg += st.drives / 2;
      if (!free && st.td > 0 && ti.teamLambda > 0) t.tdMul = clamp(t.tdMul * (ti.teamLambda / st.td), 0.05, 4);
      // 4.13.0 TD-level anchor (free mode, usage-var-1): the team's simulated offensive (player-credited) TDs -> the model's pre-game TD budget
      if (free && anc > 0 && ti.tdBudget > 0) { let got = 0; for (let i = 0; i < t.P; i++) got += m.pl[S.base[k] + i].td; if (got > 0.2) { const prev = t.tdMul, tpd = st.drives > 0 ? st.td / st.drives : 0; let nx = clamp(prev * Math.pow(ti.tdBudget / got, anc), 0.25, 4); if (tpd > 0 && nx > prev) nx = Math.min(nx, Math.max(prev, prev * 0.33 / tpd)); t.tdMul = nx; } } // never past 0.33 TD per drive
      const want = ti.tgtTot + ti.carTot, got = st.tgt + st.car; if (!free && got > 0 && want > 0) t.touchMul = clamp(t.touchMul * want / got, 0.4, 2.5);
      // team pass/run split: the scenario mix (lead → run) can drift the split away from the model's projected volume; fix it in odds space
      if (!free && ti.tgtTot > 0.5 && ti.carTot > 0.5 && st.tgt > 0.5 && st.car > 0.5) t.pfOdds = clamp(t.pfOdds * (ti.tgtTot / ti.carTot) / (st.tgt / st.car), 0.4, 2.5);
      for (let i = 0; i < t.P; i++) {
        const p = t.pl[i], s = m.pl[S.base[k] + i]; const f = (want, got, lo = 0.4, hi = 2.5) => (want > 0.02 && got > 0.02) ? clamp(want / got, lo, hi) : 1;
        // free mode: compare SHARES (player / team), so the team's total stays the sim's own
        const ft = free ? f(ti.tgtTot > 0 ? p.tgt / ti.tgtTot : 0, st.tgt > 0 ? s.tgt / st.tgt : 0) : f(p.tgt, s.tgt), fc = free ? f(ti.carTot > 0 ? p.car / ti.carTot : 0, st.car > 0 ? s.car / st.car : 0) : f(p.car, s.car); for (const w of t.wT) w[i] *= ft; for (const w of t.wC) w[i] *= fc;
        if (p.tgt > 0.05 && s.tgt > 0.05) t.cr[i] = clamp(t.cr[i] * f(p.rec / p.tgt, s.rec / s.tgt, 0.7, 1.4), 0.1, 0.98);
        if (p.rec > 0.05 && s.rec > 0.05) t.ypr[i] = clamp(t.ypr[i] * f(p.recYd / p.rec, s.recYd / s.rec, 0.5, 1.8), 0.5, 40);
        if (p.car > 0.05 && s.car > 0.05) { const w = p.rushYd / p.car + 2.5, g = s.rushYd / s.car + 2.5; if (w > 0 && g > 0) t.ypc[i] = clamp((t.ypc[i] + 2.5) * clamp(w / g, 0.5, 1.8) - 2.5, -1.5, 15); }
      }
    }
    if (dAvg > 0) E.spp *= clamp(Math.pow(dAvg / I.targetDrives, 1.3), 0.7, 1.4);
    hist.push({ drives: +dAvg.toFixed(2), td: m.team.map(x => +x.td.toFixed(3)) });
  }
  return { E, pilots: hist };
}
// per-player / per-team means of a run (used by the pilot and the calibration report)
export function means(S) {
  const pl = []; for (let j = 0; j < S.NP; j++) { const o = {}; for (const k of GSTATS) { let s = 0; for (let g = 0; g < S.n; g++) s += S.G[k][g * S.NP + j]; o[k] = s / S.n; } let a = 0, two = 0; for (let g = 0; g < S.n; g++) { const v = S.G.td[g * S.NP + j]; if (v >= 1) a++; if (v >= 2) two++; } o.anytime = a / S.n; o.twoPlus = two / S.n; pl.push(o); }
  const team = [0, 1].map(k => { let pts = 0, dr = 0, td = 0, tg = 0, ca = 0; for (let g = 0; g < S.n; g++) { pts += S.score[g * 2 + k]; dr += S.drives[g * 2 + k]; td += S.tds[g * 2 + k]; } for (let i = 0; i < S.P[k]; i++) { tg += pl[S.base[k] + i].tgt; ca += pl[S.base[k] + i].car; } return { pts: pts / S.n, drives: dr / S.n, td: td / S.n, tgt: tg, car: ca }; });
  return { pl, team };
}
export function runSim(I, { n = 10000, seed = 1, pilots = 3, pilotN = 1200, mode = null } = {}) {
  if (mode && !SIM_MODES.includes(mode)) throw new Error(`unknown sim mode ${mode}`);
  if (mode && mode !== I.mode) I = { ...I, mode };
  const t0 = Date.now(); const { E, pilots: ph } = calibrate(I, { pilots, n: pilotN, seed: seed + 9 }); const t1 = Date.now();
  const S = simulate(I, { n, seed, E }); S.pilot = ph; S.ms = { pilot: t1 - t0, sim: Date.now() - t1 }; return S;
}

// ---------- summaries (pure; worker or main thread)
const qt = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : null;
export function playerArr(S, j, stat) { const a = new Int16Array(S.n); const G = S.G[stat]; for (let g = 0; g < S.n; g++) a[g] = G[g * S.NP + j]; return a; }
export function dist(arr) { const s = Float64Array.from(arr).sort(); let m = 0; for (const v of s) m += v; return { mean: m / s.length, p10: qt(s, 0.1), p25: qt(s, 0.25), med: qt(s, 0.5), p75: qt(s, 0.75), p90: qt(s, 0.9) }; }
export const pAtLeast = (arr, th) => { let c = 0; for (const v of arr) if (v >= th) c++; return c / arr.length; };
export const playerGameStat = (S, j, stat) => stat === 'tch' ? (() => { const a = playerArr(S, j, 'rec'), b = playerArr(S, j, 'car'); for (let i = 0; i < a.length; i++) a[i] += b[i]; return a; })() : playerArr(S, j, stat);
// per drive number: P(team has that drive), P(stat >= th on it) (unconditional and given the drive happens), mean
export function playerDriveTable(S, j, stat, th, maxSlots = 12) {
  const k = j >= S.base[1] && S.P[1] ? 1 : 0; const out = [];
  for (let s = 0; s < Math.min(SLOTS, maxSlots); s++) {
    const happen = S.slotN[k * SLOTS + s]; if (!happen) break; const h = (j * SLOTS + s) * NB + DOFF[stat]; let hit = 0, tot = 0, touchedD = 0;
    for (let v = 0; v <= DSTATS[stat]; v++) { const c = S.H[h + v]; if (v >= th) hit += c; tot += v * c; }
    const ht = (j * SLOTS + s) * NB + DOFF.tch; for (let v = 1; v <= DSTATS.tch; v++) touchedD += S.H[ht + v];
    const tdh = (j * SLOTS + s) * NB + DOFF.td; const td = S.H[tdh + 1];
    out.push({ n: s + 1, happen: happen / S.n, pHit: th <= 0 ? happen / S.n : hit / S.n, pHitGiven: th <= 0 ? 1 : hit / happen, mean: tot / happen, pTouch: touchedD / happen, pTd: td / happen, last: s === SLOTS - 1 });
  }
  return out;
}
const RES_TXT = { TD: 'TD', FG: 'FG', MFG: 'missed FG', Punt: 'punt', TO: 'turnover', Downs: 'downs', Half: 'end of half', Safety: 'safety' };
// 4.14.0 display only: the finished sim's score distribution vs the betting line (never an input; the engines and summarize() don't see it)
export function vsMarket(S, L) { if (!S?.score || !L?.known) return { line: null, over: null, homeCover: null }; const n = S.n || S.score.length / 2;
  const line = { spreadHome: L.homeSpread ?? (L.awaySpread != null ? -L.awaySpread : null), total: L.totalKnown ? L.total : null }; let o = 0, c = 0;
  for (let g = 0; g < n; g++) { const a = S.score[g * 2], b = S.score[g * 2 + 1]; if (line.total != null && a + b >= line.total + 0.01) o++; if (line.spreadHome != null && b - a + line.spreadHome > 0) c++; }
  return { line, over: line.total != null ? o / n : null, homeCover: line.spreadHome != null ? c / n : null }; }
export function summarize(S, I) {
  const n = S.n; const A = I.away, B = I.home; const M = means(S);
  let wa = 0, wb = 0, tie = 0, otN = 0; const tot = new Int16Array(n), mar = new Int16Array(n); const fs = new Map();
  for (let g = 0; g < n; g++) { const a = S.score[g * 2], b = S.score[g * 2 + 1]; if (a > b) wa++; else if (b > a) wb++; else tie++; tot[g] = a + b; mar[g] = b - a; if (S.ot[g]) otN++; const key = a > b ? `${a}-${b}` : `${b}-${a}`; const kk = `${a > b ? A : b > a ? B : 'tie'}|${key}`; fs.set(kk, (fs.get(kk) || 0) + 1); }
  const line = null, over = null, homeCover = null; // 4.14.0: the sim never reads the betting market; vsMarket() compares AFTER the run, display only
  const hist = (arr, w) => { const m = new Map(); for (const v of arr) { const b = Math.floor(v / w) * w; m.set(b, (m.get(b) || 0) + 1); } return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([b, c]) => [b, c / n]); };
  const top = [...fs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, c]) => { const [w, s] = k.split('|'); return { winner: w, score: s, p: c / n }; });
  const team = [0, 1].map(k => { const sc = new Int16Array(n), h = new Int16Array(n), dr = new Int16Array(n), td = new Int16Array(n); for (let g = 0; g < n; g++) { sc[g] = S.score[g * 2 + k]; h[g] = S.half[g * 2 + k]; dr[g] = S.drives[g * 2 + k]; td[g] = S.tds[g * 2 + k]; }
    const tdDist = new Array(7).fill(0); for (const v of td) tdDist[Math.min(6, v)]++;
    const slots = []; for (let s = 0; s < SLOTS; s++) { const hn = S.slotN[k * SLOTS + s]; if (!hn) break; const r = {}; RESULTS.forEach((nm, ri) => { r[nm] = S.slotR[(k * SLOTS + s) * NR + ri] / hn; }); slots.push({ n: s + 1, happen: hn / n, ...r }); }
    return { team: k ? B : A, pts: dist(sc), halfPts: dist(h), drives: dist(dr), td: dist(td), tdDist: tdDist.map(c => c / n), slots, mean: M.team[k] }; });
  // players
  const players = []; for (let k = 0; k < 2; k++) for (let i = 0; i < S.P[k]; i++) { const j = S.base[k] + i; const p = I.teams[k].players[i]; const m = M.pl[j];
    players.push({ j, k, team: k ? B : A, id: p.id, gsis: p.gsis, name: p.name, pos: p.pos, model: I.source === 'data' ? { chance: p.modelChance ?? null, lam: p.modelChance != null ? -Math.log(1 - Math.min(0.999, p.modelChance)) : null } : { chance: p.chance, lam: p.lam, tgt: p.tgt, car: p.car, rec: p.rec, recYd: p.recYd, rushYd: p.rushYd, passTd: p.passTdExp }, simLam: p.lam, slot: p.slot || null, role: p.role || null, newcomer: p.newcomer || null, history: !!p.history && I.source !== 'data',
      anytime: m.anytime, twoPlus: m.twoPlus, td: m.td, passTd: p.pos === 'QB' ? m.passTd : null, rec: dist(playerArr(S, j, 'rec')), recYd: dist(playerArr(S, j, 'recYd')), car: dist(playerArr(S, j, 'car')), rushYd: dist(playerArr(S, j, 'rushYd')), tgt: m.tgt, pats: p.pats || [] }); }
  // 4.13.0: "surprise scorer" - chance a TD in this game comes from outside the sim's top 4 by anytime chance, and the likeliest longshots
  const surp = surprise(S, players, { top: 4, longshots: 3 });
  // first TD scorer
  const ft = new Map(); for (let g = 0; g < n; g++) ft.set(S.firstTd[g], (ft.get(S.firstTd[g]) || 0) + 1);
  const firstTd = [...ft.entries()].map(([j, c]) => ({ j, p: c / n, label: j >= 0 ? players.find(x => x.j === j)?.name : j === -1 ? 'No touchdown' : j <= -4 ? `${j === -4 ? A : B} defense / special teams` : `${j === -2 ? A : B} (other)` })).sort((x, y) => y.p - x.p);
  // correlations among the likeliest scorers
  const cand = players.filter(p => p.anytime >= 0.08).sort((x, y) => y.anytime - x.anytime).slice(0, 10); const sc = new Map(cand.map(p => [p.j, playerArr(S, p.j, 'td')]));
  const pairs = []; for (const a of cand) for (const b of cand) { if (a.j === b.j) continue; const xa = sc.get(a.j), xb = sc.get(b.j); let na = 0, nab = 0, nb0 = 0, nnot = 0; for (let g = 0; g < n; g++) { if (xa[g] > 0) { na++; if (xb[g] > 0) nab++; } else { nnot++; if (xb[g] > 0) nb0++; } }
    if (na < 50) continue; const pba = nab / na, pbn = nb0 / Math.max(1, nnot); pairs.push({ a: a.name, aj: a.j, b: b.name, bj: b.j, same: a.k === b.k, pB: b.anytime, pBgivenA: pba, pBgivenNotA: pbn, lift: pba - b.anytime }); }
  pairs.sort((x, y) => Math.abs(y.lift) - Math.abs(x.lift));
  const whenScores = cand.map(p => { const x = sc.get(p.j); let na = 0, ta = 0, tn = 0, win = 0; for (let g = 0; g < n; g++) { if (x[g] > 0) { na++; ta += tot[g]; const my = S.score[g * 2 + p.k], th = S.score[g * 2 + 1 - p.k]; if (my > th) win++; } else tn += tot[g]; }
    return { name: p.name, j: p.j, team: p.team, p: p.anytime, totalIf: na ? ta / na : null, totalIfNot: n - na ? tn / (n - na) : null, winIf: na ? win / na : null, win: p.k ? wb / n : wa / n }; });
  // game scripts
  const SCR = [['blowA', `${A} by 9+`], ['blowB', `${B} by 9+`], ['oneScore', 'One-score game (≤ 8)'], ['shootout', 'Shootout (55+ total)'], ['grind', 'Low scoring (≤ 37 total)'], ['comeback', 'Comeback: half-time leader loses'], ['wire', 'Half-time leader wins'], ['q4', '4th-quarter lead change or tie-break'], ['ot', 'Overtime']];
  const scr = Object.fromEntries(SCR.map(([k]) => [k, 0])); const combo = new Map();
  for (let g = 0; g < n; g++) { const a = S.score[g * 2], b = S.score[g * 2 + 1], ha = S.half[g * 2], hb = S.half[g * 2 + 1]; const m = b - a, t = a + b;
    if (m <= -9) scr.blowA++; if (m >= 9) scr.blowB++; if (Math.abs(m) <= 8) scr.oneScore++; if (t >= 55) scr.shootout++; if (t <= 37) scr.grind++;
    const hl = Math.sign(hb - ha), fl = Math.sign(m); if (hl && fl && hl !== fl) scr.comeback++; if (hl && hl === fl) scr.wire++; if (S.q4trail[g] && ((S.q4trail[g] === 1 && fl < 0) || (S.q4trail[g] === 2 && fl > 0) || fl === 0)) scr.q4++; if (S.ot[g]) scr.ot++;
    const w = fl < 0 ? A : fl > 0 ? B : 'Tie'; const kind = Math.abs(m) >= 9 ? 'comfortably' : 'in a one-score game'; const hs = hl === 0 ? 'tied at half' : (hl < 0 ? `${A} led at half` : `${B} led at half`); const ts = t >= 52 ? 'high total' : t <= 38 ? 'low total' : 'mid total';
    const key = w === 'Tie' ? `Tie · ${ts}` : `${hs} → ${w} wins ${kind} · ${ts}`; combo.set(key, (combo.get(key) || 0) + 1); }
  const scripts = SCR.map(([k, l]) => ({ k, label: l, p: scr[k] / n })); const combos = [...combo.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([l, c]) => ({ label: l, p: c / n }));
  // example game: the first logged game whose final score is the most common one (else closest to the medians)
  const modal = top[0]; let ex = -1; const medT = qt(Float64Array.from(tot).sort(), 0.5), medM = qt(Float64Array.from(mar).sort(), 0.5);
  for (let g = 0; g < S.logs.length && ex < 0; g++) { const a = S.score[g * 2], b = S.score[g * 2 + 1]; const key = a > b ? `${a}-${b}` : `${b}-${a}`; const w = a > b ? A : b > a ? B : 'tie'; if (modal && key === modal.score && w === modal.winner) ex = g; }
  if (ex < 0) { let best = 1e9; for (let g = 0; g < S.logs.length; g++) { const a = S.score[g * 2], b = S.score[g * 2 + 1]; const d = Math.abs(a + b - medT) + Math.abs(b - a - medM); if (d < best) { best = d; ex = g; } } }
  const out = { n, seed: S.seed, away: A, home: B, version: SIM_VERSION, ms: S.ms, pilot: S.pilot, line, win: { away: wa / n, home: wb / n, tie: tie / n, ot: otN / n }, over, homeCover,
    total: dist(tot), margin: dist(mar), totHist: hist(tot, 3), marHist: hist(mar, 3), top, team, players, surprise: surp, firstTd, pairs: pairs.slice(0, 40), whenScores, scripts, combos,
    example: ex >= 0 ? { g: ex, score: [S.score[ex * 2], S.score[ex * 2 + 1]], drives: S.logs[ex] } : null, targetDrives: I.targetDrives, notes: I.teams.map(t => t.note).filter(Boolean) };
  out.drive1 = [driveCard(S, out, 0, 0), driveCard(S, out, 1, 0)]; out.tdp = tdPatterns(S, out);
  out.mode = I.mode === 'anchored' ? 'anchored' : 'free'; Object.assign(out, simVsModel(out, I));
  return out;
}
// 4.9.2: team profiles, team TDs sim vs model budget, Top 4 TD scorers and the biggest player disagreements with the model
export function simVsModel(out, I) {
  const teams = I.teams.map((t, k) => { const T = out.team[k]; const modelTd = t.modelTeamLambda ?? null; /* 4.14.0: no model line -> null (was the sim's own lambda shown as the model's) */ return { team: t.team, opp: t.opp, src: t.src, simTd: T.mean.td, modelTd, diffTd: modelTd != null ? T.mean.td - modelTd : null, simPts: T.mean.pts, simDrives: T.mean.drives,
    passSim: T.mean.tgt + T.mean.car > 0 ? T.mean.tgt / (T.mean.tgt + T.mean.car) : null, passModel: t.pfModel?.[0] ?? null, off: t.profile, def: t.defProfile }; });
  const firstOf = j => out.firstTd.find(f => f.j === j)?.p ?? 0;
  const top4 = out.players.slice().sort((a, b) => b.anytime - a.anytime).slice(0, 4).map(p => { const T = teams[p.k]; const share = T.simTd > 0 ? p.td / T.simTd : 0; const mc = p.model.chance; const d = mc == null ? null : p.anytime - mc;
    const lg = I.league?.tdPerGame ?? null; const tag = p.role === 'role' ? `${p.slot || p.pos} role player` : p.role === 'star' ? `${p.slot || p.pos}` : p.pos;
    const teamWhy = lg != null && T.simTd - lg >= 0.3 ? `${T.team} out-scores the league norm (${lg.toFixed(1)} TDs) against ${poss(T.opp)} defense in the sim` : lg != null && lg - T.simTd >= 0.3 ? `even though ${T.team} sits below the league norm (${lg.toFixed(1)} TDs) against ${poss(T.opp)} defense` : null;
    const plWhy = p.newcomer === 'carry' ? `new to ${p.team}: his rates carry over from his recent games for another team` : p.newcomer === 'prior' ? `no recent NFL games, so a rookie / depth-chart prior for a ${p.pos}` : share >= 0.25 ? `he is ${poss(p.team)} main red-zone and goal-line option in recent games` : p.role === 'role' ? `not a headline name, but his red-zone and goal-line touches add up; TDs often come from outside the stars` : `his share of ${poss(p.team)} red-zone and goal-line work in recent games`;
    const why = `${tag}: ${plWhy}${teamWhy ? `; ${teamWhy}` : ''}`;
    return { j: p.j, name: p.name, pos: p.pos, team: p.team, anytime: p.anytime, model: p.model.chance, diff: d, role: p.role, slot: p.slot, newcomer: p.newcomer, twoPlus: p.twoPlus, first: firstOf(p.j), share,
      line: `${p.name} scores in ${pct(p.anytime)} of the ${out.n.toLocaleString()} sims${mc == null ? '' : ` (model ${pct(mc)}, shown for comparison)`} — he finishes ${pct(share)} of ${poss(p.team)} ${T.simTd.toFixed(1)} TDs a game here; ${why}.` }; });
  const gaps = out.players.filter(p => p.model.chance != null && (p.model.chance >= 0.05 || p.anytime >= 0.05)).map(p => ({ j: p.j, name: p.name, pos: p.pos, team: p.team, anytime: p.anytime, model: p.model.chance, diff: p.anytime - p.model.chance }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 5).filter(g => Math.abs(g.diff) >= 0.03);
  return { vs: { teams, top4, gaps } };
}
// auto-generated drive-number patterns from the sims (most likely drive per player for his main stat + biggest swings)
export function simPatterns(S, sum, { max = 8 } = {}) {
  const out = []; const pl = sum.players.filter(p => p.rec.mean + p.car.mean >= 1.5).sort((a, b) => (b.rec.mean + b.car.mean) - (a.rec.mean + a.car.mean)).slice(0, 10);
  for (const p of pl) {
    const [st, th] = p.car.mean > p.rec.mean * 1.5 ? ['rushYd', 10] : ['rec', 1]; const rows = playerDriveTable(S, p.j, st, th, 12).filter(r => r.happen >= 0.5);
    if (!rows.length) continue; const best = rows.slice().sort((a, b) => b.pHit - a.pHit)[0]; const avg = rows.reduce((s, r) => s + r.pHitGiven, 0) / rows.length;
    const swing = rows.slice().sort((a, b) => Math.abs(b.pHitGiven - avg) - Math.abs(a.pHitGiven - avg))[0];
    out.push({ j: p.j, name: p.name, team: p.team, stat: st, th, drive: best.n, p: best.pHit, given: best.pHitGiven, avg, happen: best.happen, swing: { drive: swing.n, given: swing.pHitGiven, happen: swing.happen } });
  }
  return out.sort((a, b) => b.p - a.p).slice(0, max);
}

// ---------- 4.9.1: drive-N cards and touchdown-scorer patterns (plain-sentence summaries of the raw sim arrays)
export const pct = x => x == null || !Number.isFinite(x) ? '—' : x > 0 && x < 0.005 ? '<1%' : x < 1 && x > 0.995 ? '>99%' : `${Math.round(x * 100)}%`;
const DRIVE_MIX = [['Punt', 'punt'], ['TD', 'touchdown'], ['FG', 'field goal'], ['TO', 'turnover'], ['Downs', 'turnover on downs'], ['MFG', 'missed field goal'], ['Half', 'end of half'], ['Safety', 'safety']];
const ORD = ['opening', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const driveName = s => s === 0 ? 'opening drive' : s < ORD.length ? `${ORD[s]} drive` : `drive ${s + 1}`;
const hMed = (S, h, from, max) => { let c = 0; for (let v = from; v <= max; v++) c += S.H[h + v]; if (!c) return null; let acc = 0; for (let v = from; v <= max; v++) { acc += S.H[h + v]; if (acc * 2 >= c) return v; } return max; };
const hGe = (S, h, max, th) => { let c = 0; for (let v = th; v <= max; v++) c += S.H[h + v]; return c; };
export const poss = nm => /s$/i.test(nm) ? `${nm}'` : `${nm}'s`;
const nameOf = (sum, j) => sum.players.find(p => p.j === j)?.name || '—';
// one team's drive N (0-based slot) across all sims: how it ends, length, who touches the ball, who scores, and what a TD there does to the game
export function driveCard(S, sum, k, slot = 0) {
  const n = S.n, T = k ? sum.home : sum.away, O = k ? sum.away : sum.home; const ks = k * SLOTS + slot; const hn = S.slotN[ks]; const dname = driveName(slot);
  let recv = 0, first = 0; for (let g = 0; g < n; g++) { if (S.kick[g] === k) recv++; if (S.firstScore[g] === k) first++; }
  const base = { team: T, opp: O, k, slot, drive: slot + 1, dname, happen: hn / n, recvKick: recv / n, scoresFirst: first / n };
  if (!hn) return { ...base, res: null, players: [], scorers: [], links: [], headline: [`${T} never gets a ${dname} in these sims.`] };
  const res = Object.fromEntries(RESULTS.map((r, ri) => [r, S.slotR[ks * NR + ri] / hn]));
  const plays = S.slotPlays[ks] / hn, yds = S.slotYds[ks] / hn;
  // TD rate on this drive when receiving vs kicking off, and what a TD here does to the game
  let nR = 0, tdR = 0, nK = 0, tdK = 0, nTd = 0, winTd = 0, win = 0, firstTd = 0; const last = slot === SLOTS - 1;
  const tdHere = new Uint8Array(n);
  for (let g = 0; g < n; g++) { const r = last ? null : S.gRes[(g * 2 + k) * SLOTS + slot]; const my = S.score[g * 2 + k], th = S.score[g * 2 + 1 - k]; if (my > th) win++;
    if (r === 255 || r === null) continue; const td = r === 0; if (S.kick[g] === k) { nR++; if (td) tdR++; } else { nK++; if (td) tdK++; }
    if (td) { tdHere[g] = 1; nTd++; if (my > th) winTd++; if (S.firstScore[g] === k) firstTd++; } }
  const players = sum.players.filter(p => p.k === k).map(p => { const h0 = (p.j * SLOTS + slot) * NB; const at = key => h0 + DOFF[key]; const f = (key, th) => hGe(S, at(key), DSTATS[key], th) / hn;
    return { j: p.j, name: p.name, pos: p.pos, pTouch: f('tch', 1), pTgt: f('tgt', 1), pRec1: f('rec', 1), pRec2: f('rec', 2), pRecYd10: f('recYd', 10), pCar1: f('car', 1), pCar2: f('car', 2), pRush10: f('rushYd', 10), pTd: f('td', 1),
      medRec: hMed(S, at('rec'), 1, DSTATS.rec), medRecYd: hMed(S, at('recYdC'), 0, DSTATS.recYdC), medCar: hMed(S, at('car'), 1, DSTATS.car), medRushYd: hMed(S, at('rushYdC'), 0, DSTATS.rushYdC) }; })
    .filter(p => p.pTouch >= 0.02 || p.pTd >= 0.005).sort((a, b) => b.pTd - a.pTd || b.pTouch - a.pTouch);
  const scorers = players.filter(p => p.pTd >= 0.005).slice(0, 5); const noName = Math.max(0, res.TD - players.reduce((s2, p) => s2 + p.pTd, 0));
  // if this drive ends in a TD: each likely scorer's anytime TD (both teams), vs normally
  const links = []; if (nTd >= 100 && !last) for (const p of sum.players.filter(x => x.anytime >= 0.08)) { const a = S.G.td; let c = 0; for (let g = 0; g < n; g++) if (tdHere[g] && a[g * S.NP + p.j] > 0) c++; const pi = c / nTd;
    links.push({ j: p.j, name: p.name, team: p.team, same: p.k === k, pIf: pi, p: p.anytime, diff: pi - p.anytime }); }
  links.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const top = scorers[0], rec = players.slice().sort((a, b) => b.pRec1 - a.pRec1)[0], car = players.slice().sort((a, b) => b.pCar1 - a.pCar1)[0];
  const headline = [];
  // 4.10.1: lead with the whole outcome mix, most likely first — a TD is one outcome among several (about 1 drive in 4-5), never the headline
  const mix = DRIVE_MIX.map(([r, l]) => ({ r, label: l, p: res[r] || 0 })).filter(x => x.p >= 0.005).sort((a, b) => b.p - a.p);
  headline.push(`${poss(T)} ${dname}${slot ? ' (when it gets one)' : ''} — most likely result: ${mix[0].label} (${pct(mix[0].p)}). All outcomes: ${mix.map(x => `${x.label} ${pct(x.p)}`).join(' · ')}.`);
  headline.push(`A TD on this drive: ${pct(res.TD)}${res.TD > 0 ? ` — about 1 in ${Math.max(1, Math.round(1 / res.TD))}` : ''}${top ? `; when it happens, ${top.name} is the likeliest scorer (${pct(top.pTd)} of sims${scorers[1] ? `, then ${scorers[1].name} ${pct(scorers[1].pTd)}` : ''})` : ''}. It averages ${plays.toFixed(1)} plays and ${Math.round(yds)} yards (skill-player catches and runs).`);
  if (rec || car) headline.push(`${car && car.pCar1 >= 0.05 ? `${car.name} gets a carry on it in ${pct(car.pCar1)} (10+ rush yds ${pct(car.pRush10)})` : ''}${car && car.pCar1 >= 0.05 && rec ? '; ' : ''}${rec ? `${rec.name} is the likeliest to catch a pass (${pct(rec.pRec1)}${rec.medRecYd != null ? `, median ${rec.medRecYd} yd${rec.medRecYd === 1 ? '' : 's'} when he does` : ''})` : ''}.`);
  if (slot === 0) headline.push(`${recv / n >= 0.5 ? T : O} receives the opening kickoff in ${pct(Math.max(recv / n, 1 - recv / n))} of sims (a coin flip; the other team gets the ball to start the 2nd half). ${T} opens with a TD in ${pct(nR ? tdR / nR : null)} when it receives vs ${pct(nK ? tdK / nK : null)} when it kicks off.`);
  if (nTd >= 100 && !last) headline.push(`In the ${pct(nTd / n)} of sims where this drive ends in a ${T} TD, ${T} wins ${pct(winTd / nTd)} (vs ${pct(win / n)} overall)${slot === 0 ? ` and scored first in ${pct(firstTd / nTd)} of those games — ${T} scores first in ${pct(first / n)} overall` : ''}.`);
  return { ...base, res, mix, plays, yds, tdRecv: nR ? tdR / nR : null, tdKick: nK ? tdK / nK : null, winIfTd: nTd ? winTd / nTd : null, win: win / n, players, scorers, noName, links: links.slice(0, 8), headline, last };
}
// touchdown-scorer patterns: first TD (game / each team), anytime / 2+ / 3+, when and how each player's TDs come, ranked links
export function tdPatterns(S, sum) {
  const n = S.n, A = sum.away, B = sum.home;
  const firstTeam = [0, 1].map(k => { const m = new Map(); for (let g = 0; g < n; g++) { const v = S.ftdTeam[g * 2 + k]; m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].map(([j, c]) => ({ j, p: c / n, label: j >= 0 ? nameOf(sum, j) : j === -1 ? `No ${k ? B : A} offensive TD` : `${k ? B : A} (other player)` })).sort((x, y) => y.p - x.p); });
  const fg = new Map(sum.firstTd.map(f => [f.j, f.p]));
  const cand = sum.players.filter(p => p.anytime >= 0.05).sort((a, b) => b.anytime - a.anytime).slice(0, 12);
  const players = cand.map(p => { const td = playerArr(S, p.j, 'td'); let three = 0, tot = 0; for (const v of td) { if (v >= 3) three++; tot += v; }
    const a = p.j * TDAGG; const ag = i => S.tdAgg[a + i]; const t2 = ag(0) + ag(1) || 1; let d13 = 0; for (let s2 = 0; s2 < 3; s2++) d13 += S.H[(p.j * SLOTS + s2) * NB + DOFF.td + 1];
    const ft = firstTeam[p.k].find(x => x.j === p.j);
    return { j: p.j, name: p.name, team: p.team, k: p.k, pos: p.pos, anytime: p.anytime, twoPlus: p.twoPlus, threePlus: three / n, perGame: tot / n, first: fg.get(p.j) || 0, firstTeam: ft ? ft.p : 0,
      rush: ag(0) / t2, recv: ag(1) / t2, half1: (ag(2) + ag(3)) / t2, q4: ag(5) / t2, ot: ag(6) / t2, two: ag(7) / t2, d13: d13 / t2, tds: tot }; });
  // pair links (pairs come pre-sorted by |lift| from summarize)
  const links = sum.pairs.filter(x => Math.abs(x.lift) >= 0.02).slice(0, 10).map(x => ({ ...x, text: `When ${x.a} scores, ${x.b} scores too in ${pct(x.pBgivenA)} of those games (vs ${pct(x.pB)} normally)${x.same ? ' — same team: each TD drive has one scorer, so teammates compete for the same TDs' : ' — opposite teams: a higher-scoring game lifts both'}.` }));
  // both-score combos
  const tdA = new Map(cand.map(p => [p.j, playerArr(S, p.j, 'td')])); const combos = [];
  for (let x = 0; x < cand.length; x++) for (let y = x + 1; y < cand.length; y++) { const a = tdA.get(cand[x].j), b = tdA.get(cand[y].j); let c = 0; for (let g = 0; g < n; g++) if (a[g] > 0 && b[g] > 0) c++; combos.push({ a: cand[x].name, b: cand[y].name, same: cand[x].k === cand[y].k, p: c / n }); }
  combos.sort((a, b) => b.p - a.p);
  // opening-drive TD → anytime TD
  const d1 = (sum.drive1 || []).map(c => ({ team: c.team, pTd: c.res?.TD ?? 0, links: c.links }));
  const d1links = d1.flatMap(d => d.links.map(l => ({ ...l, dteam: d.team, text: `If ${d.team} scores a TD on its opening drive, ${poss(l.name)} chance of scoring at some point goes from ${pct(l.p)} to ${pct(l.pIf)}${l.same ? '' : ` (${l.team} is the other team)`}.` }))).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  // scorer → win / total
  const wl = sum.whenScores.map(w => ({ ...w, dWin: (w.winIf ?? 0) - w.win, text: `When ${w.name} scores, ${w.team} wins ${pct(w.winIf)} (vs ${pct(w.win)} overall) and the game total averages ${w.totalIf?.toFixed(1) ?? '—'} (vs ${w.totalIfNot?.toFixed(1) ?? '—'} when he doesn't).` })).sort((a, b) => Math.abs(b.dWin) - Math.abs(a.dWin));
  // timing / type sentences
  const timing = players.slice(0, 8).map(p => ({ ...p, text: `${pct(p.half1)} of ${poss(p.name)} TDs come in the first half and ${pct(p.d13)} on ${p.team} drives 1–3 (${pct(p.q4)} in the 4th quarter${p.ot >= 0.005 ? `, ${pct(p.ot)} in OT` : ''}); ${pct(p.rush)} are rushing, ${pct(p.recv)} receiving.` }));
  // ranked key patterns
  const key = []; const f = sum.firstTd.filter(x => x.j >= 0);
  if (f.length) key.push(`${f[0].label} is the likeliest first TD scorer of the game (${pct(f[0].p)})${f[1] ? `, then ${f[1].label} (${pct(f[1].p)})` : ''}${f[2] ? ` and ${f[2].label} (${pct(f[2].p)})` : ''}.`);
  for (const c of (sum.drive1 || []).slice().sort((a, b) => (b.res?.TD ?? 0) - (a.res?.TD ?? 0))) if (c.res) key.push(`${c.team} scores a TD on its opening drive in ${pct(c.res.TD)} of games${c.scorers[0] ? ` — ${c.scorers[0].name} is the most likely scorer (${pct(c.scorers[0].pTd)})` : ''}.`);
  if (players[0]) { const p = players[0]; key.push(`${p.name} is the likeliest to score at any point (${pct(p.anytime)}); 2+ TDs ${pct(p.twoPlus)}, 3+ ${pct(p.threePlus)}.`); }
  if (combos[0]) key.push(`${combos[0].a} + ${combos[0].b} both score in ${pct(combos[0].p)} of games — the most common TD pair.`);
  if (links[0]) key.push(links[0].text);
  if (d1links[0]) key.push(d1links[0].text);
  if (wl[0]) key.push(wl[0].text);
  if (timing[0]) key.push(timing[0].text);
  return { firstTeam, players, links, combos: combos.slice(0, 8), d1links: d1links.slice(0, 8), winLinks: wl.slice(0, 8), timing, key };
}
export { RES_TXT as RESULT_TEXT };
