// ENDZONE game simulator (app 4.9.0). Research / UI only: nothing here feeds the live anytime chance, MODEL_VERSION or the
// challenger gate. Plays a matchup out drive by drive N times from PRE-GAME inputs only:
//   - the model's per-player TD intensity (lambda, after budget + caps) and its projected targets / carries / receptions /
//     yards (+ lead / behind scenario volumes) from this week's slate;
//   - the weekly drive file (archive/drives/<s>/w<w>.json): league drive-result mix by game state, each offense's and each
//     defense's result mix (shrunk), real drives as plays / targets / carries templates, and validated drive patterns
//     (FDR + out-of-sample, strong / moderate only) as bounded touch-share multipliers on matching drives.
// Game state: score, quarter + clock, two-minute drives, possession alternation (opening kick, 2nd-half kick), OT.
// A short pilot (2 x 1,500 games) calibrates per team: TD rate -> model team lambda, seconds per play -> expected drives,
// touch volume / per-player shares / catch rate / yards -> the model's projected means. Seeded PRNG = reproducible.
export const SIM_VERSION = 'sim-1';
export const RESULTS = ['TD', 'FG', 'MFG', 'Punt', 'TO', 'Downs', 'Half', 'Safety'];
const RI = Object.fromEntries(RESULTS.map((r, i) => [r, i])); const NR = RESULTS.length;
const TD = 0, FG = 1, MFG = 2, PUNT = 3, TO = 4, DOWNS = 5, HALF = 6, SAF = 7;
export const SLOTS = 16;
// per-drive histogram stats (bins 0..max, values above max fold into max)
export const DSTATS = { tgt: 8, rec: 8, recYd: 60, car: 12, rushYd: 60, tch: 14, td: 1 };
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
function mixIdx(x, L, k = 60) { return RESULTS.map((_, r) => x && L.pAll[r] > 0 ? ((x.c[r] + k * L.pAll[r]) / (x.n + k)) / L.pAll[r] : 1); }

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
// history-only fallback (team not on this week's slate): per-game means over its last 6 games in the drive file
function historyPlayers(D, team, L) {
  const T = D?.teams?.[team]; if (!T) return []; const G = T.games.slice(-6); const g = Math.max(1, G.length); const acc = new Map();
  let teamTd = 0; for (const gm of G) for (const d of gm.d) { if (d[5] === 'TD') teamTd++; for (const x of d[8]) { const a = acc.get(x[0]) || [0, 0, 0, 0, 0, 0, 0]; a[0] += x[1]; a[1] += x[2]; a[2] += x[3]; a[3] += x[4]; a[4] += x[5]; a[5] += x[7]; a[6] += x[1] + x[4]; acc.set(x[0], a); } }
  const totT = [...acc.values()].reduce((s, a) => s + a[6], 0) || 1; const tdpg = teamTd / g;
  return [...acc.entries()].filter(([, a]) => a[6] / g >= 0.4).map(([pi, a]) => { const pe = T.people[pi]; const sh = a[6] / totT; const lam = 0.5 * (a[5] / g) + 0.5 * tdpg * sh;
    return { id: pe[3] || pe[0], gsis: pe[0], name: pe[1], pos: pe[2], lam, chance: 1 - Math.exp(-lam), tgt: a[0] / g, car: a[3] / g, rec: a[1] / g, recYd: a[2] / g, rushYd: a[4] / g,
      rushTd: DEFAULT_RUSH_TD[pe[2]] ?? 0.3, passShare: 0, passTdExp: null, lead: null, behind: null, pats: patternsFor(D, pe[0]), history: true }; });
}
// sideFor(team) -> { players, opp, teamLambda, tdBudget } from the slate (the team's own game this week) or null
export function buildSimInputs(D, { away, home, sideFor = () => null, lines = null, gameId = null }) {
  const L = leaguePriors(D); const teams = [away, home].map((team, k) => {
    const opp = k ? away : home; const S = sideFor(team); let src = 'model', note = null; let players;
    if (S && S.players?.length) {
      players = S.players.filter(p => !(p.avail?.factor === 0) && ((p.vol?.targets || 0) + (p.vol?.carries || 0) > 0.05 || (p.lambda || 0) > 0.003 || p.pos === 'QB')).map(p => modelPlayer(p, D));
      if (S.opp && S.opp !== opp) { // custom matchup: rescale TD intensity by the two defenses' shrunk TD-per-drive allowed
        const a = D?.defense?.[opp]?.shrunk?.tdPer, b = D?.defense?.[S.opp]?.shrunk?.tdPer; const f = a && b ? clamp(a / b, 0.75, 1.33) : 1;
        for (const p of players) { p.lam *= f; p.chance = 1 - Math.exp(-p.lam); } src = 'model-adjusted'; note = `${team}'s model inputs are from its real game vs ${S.opp}; TD intensity rescaled ×${f.toFixed(2)} for ${opp}'s defense (TD per drive allowed). Volumes unchanged.`;
      }
    } else { players = historyPlayers(D, team, L); src = 'history'; note = `${team} has no model inputs this week (bye or not on the slate): per-game volumes and TD rates from its last 6 games in the drive file, shrunk toward its team TD rate.`; }
    players = players.filter(p => p.tgt + p.car > 0.02 || p.lam > 0.002 || p.passShare > 0);
    const teamLambda = sum(players, p => p.lam);
    const off = D?.offense?.[team], df = D?.defense?.[opp];
    const dpg = off?.dpg != null && df?.dpg != null ? (off.dpg + df.dpg) / 2 : (L.dpg || 10.8);
    const pfOf = (sel) => { const t = sum(players, p => sel(p)?.t ?? p.tgt), c = sum(players, p => sel(p)?.c ?? p.car); return t + c > 0 ? t / (t + c) : L.passAll; };
    const pf = [pfOf(() => null), pfOf(p => p.lead), pfOf(p => p.behind)];
    return { team, opp, src, note, players, teamLambda, tdBudget: S?.tdBudget ?? null, modelTeamLambda: S?.teamLambda ?? null, dpg,
      offIdx: mixIdx(L.off[team], L), defIdx: mixIdx(L.def[opp], L), pool: L.off[team]?.pool || RESULTS.map(() => []), pf,
      tgtTot: sum(players, p => p.tgt), carTot: sum(players, p => p.car) };
  });
  // both teams get (nearly) the same number of possessions: target = mean of the two expected counts, shrunk toward league
  const tgtDrives = 0.7 * (teams[0].dpg + teams[1].dpg) / 2 + 0.3 * (L.dpg || 10.8);
  return { version: SIM_VERSION, gameId, away, home, lines, teams, targetDrives: +tgtDrives.toFixed(2),
    league: { bucket: L.bucket, pAll: L.pAll, pool: L.pool, rrRes: L.rrRes, rrBk: L.rrBk, dpg: L.dpg, ppd: L.ppd, tdPerGame: L.tdPerGame, fgPerGame: L.fgPerGame, passAll: L.passAll } };
}

// ---------- engine
function makeEngine(I) {
  const T = I.teams.map(t => {
    const P = t.players.length; const pl = t.players;
    const wT = [pl.map(p => p.tgt), pl.map(p => p.lead?.t ?? p.tgt), pl.map(p => p.behind?.t ?? p.tgt)];
    const wC = [pl.map(p => p.car), pl.map(p => p.lead?.c ?? p.car), pl.map(p => p.behind?.c ?? p.car)];
    const lamW = pl.map(p => p.lam); const qbs = pl.map(p => p.passShare || 0);
    const cr = pl.map(p => p.tgt > 0 ? clamp(p.rec / p.tgt, 0.2, 0.95) : 0.65);
    const ypr = pl.map(p => p.rec > 0.05 ? clamp(p.recYd / p.rec, 2, 30) : 9);
    const ypc = pl.map(p => p.car > 0.05 ? clamp(p.rushYd / p.car, -1, 12) : 4);
    return { P, pl, wT, wC, lamW, lamTot: lamW.reduce((a, b) => a + b, 0), qbs, qbTot: qbs.reduce((a, b) => a + b, 0), cr, ypr, ypc,
      tdMul: clamp(t.teamLambda / Math.max(0.3, I.targetDrives * I.league.pAll[TD]), 0.15, 3), touchMul: 1, pfOdds: 1, ownW: t.pool.map(p => p.length / (p.length + 15)) };
  });
  return { I, T, spp: 3600 / Math.max(60, 2 * I.targetDrives * I.league.ppd) * 0.97 };
}
function probsFor(E, k, b) { // drive-result probabilities for team k in bucket b
  const I = E.I, t = I.teams[k], base = I.league.bucket[b]; const p = new Array(NR); let rest = 0;
  for (let r = 1; r < NR; r++) { p[r] = base[r] * (r === FG || r === MFG || r === PUNT || r === TO || r === DOWNS ? Math.sqrt(t.offIdx[r] * t.defIdx[r]) : 1); rest += p[r]; }
  const pTd = clamp(base[TD] * E.T[k].tdMul, 0.01, 0.75); for (let r = 1; r < NR; r++) p[r] *= (1 - pTd) / rest; p[TD] = pTd; return p;
}
function sampleR(p, R) { let u = R(); for (let r = 0; r < NR; r++) { u -= p[r]; if (u < 0) return r; } return PUNT; }
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
export function simulate(I, { n = 10000, seed = 1, record = true, E = null } = {}) {
  E = E || makeEngine(I); const R = makeRng(seed); const L = I.league; const TT = E.T;
  const NP = TT[0].P + TT[1].P; const base = [0, TT[0].P];
  const G = {}; for (const k of GSTATS) G[k] = new Int16Array(n * NP);
  const H = record ? new Uint32Array(NP * SLOTS * NB) : null;
  const slotN = new Uint32Array(2 * SLOTS), slotR = new Uint32Array(2 * SLOTS * NR);
  const score = new Int16Array(n * 2), half = new Int16Array(n * 2), drives = new Uint8Array(n * 2), tds = new Uint8Array(n * 2), fgs = new Uint8Array(n * 2);
  const firstTd = new Int16Array(n), firstScore = new Int8Array(n), ot = new Uint8Array(n), leadCh = new Uint8Array(n), q4trail = new Int8Array(n);
  const tdDriveSlot = new Uint8Array(n * 2); // team's first TD drive number (0 = none)
  const logs = [];
  const probs = [0, 1].map(k => [0, 1, 2, 3].map(b => probsFor(E, k, b)));
  const anyPats = TT.map(t => t.pl.some(p => p.pats?.length));
  const tmp = TT.map(t => ({ tgt: new Int16Array(t.P), rec: new Int16Array(t.P), recYd: new Int16Array(t.P), car: new Int16Array(t.P), rushYd: new Int16Array(t.P), td: new Int8Array(t.P), w1: new Float64Array(t.P), w2: new Float64Array(t.P) }));
  for (let gi = 0; gi < n; gi++) {
    const sc = [0, 0], dn = [0, 0]; let hf = 1, tl = 1800, isOt = false; const recv0 = R() < 0.5 ? 0 : 1; let pos = recv0; const otPoss = [0, 0];
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
      let r = sampleR(probs[k][b], R); let guard = 0;
      while (r === HALF && tl > 300 && guard++ < 20) r = sampleR(probs[k][b], R); // 'end of half' only when the clock can actually run out
      if (r === HALF && tl > 300) r = PUNT;
      const own = ti.pool[r]; const pl = (own.length && R() < t.ownW[r]) ? own : L.pool[r]; const tp = pl.length ? pl[(R() * pl.length) | 0] : [6, 3, 3];
      const tl0 = tl; let secs = tp[0] * E.spp * (b === 1 ? 0.42 : b === 2 ? 1.2 : b === 3 ? 0.75 : 1) * (0.75 + 0.5 * R()) + 6;
      if (secs >= tl && r !== HALF) { if (b !== 1 && (r === TD || r === FG) ? R() < 0.4 : (r === TD || r === FG) ? R() < 0.75 : false) { /* scored before the clock ran out */ } else r = HALF; secs = tl; }
      tl -= secs; if (r === HALF) tl = 0;
      // touches
      let tt = sround((tp[1] + tp[2]) * t.touchMul, R); const pf0 = clamp(ti.pf[scn] * L.rrRes[r] * L.rrBk[b], 0.05, 0.95), pf = pf0 * t.pfOdds / (1 - pf0 + pf0 * t.pfOdds);
      let ng = 0; for (let i = 0; i < tt; i++) if (R() < pf) ng++; let nc = tt - ng;
      let scorer = -1, rushTd = false;
      if (r === TD && t.lamTot > 0) { scorer = pickW(t.lamW, t.lamTot, R); rushTd = R() < t.pl[scorer].rushTd; if (rushTd) { if (nc === 0) { nc = 1; if (ng > 0) ng--; } nc--; } else { if (ng === 0) { ng = 1; if (nc > 0) nc--; } ng--; } }
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
      if (r === TD) { sc[k] += 6 + (R() < XP ? 1 : 0); if (ftd < 0) ftd = scorer >= 0 ? base[k] + scorer : -2 - k; if (!tdSlot[k]) tdSlot[k] = Math.min(255, dno); }
      else if (r === FG) sc[k] += 3; else if (r === SAF) sc[o] += 2;
      else if (r === TO && R() < DEF_TD_ON_TO) { sc[o] += 7; next = k; if (ftd < 0) ftd = -4 - o; }
      else if (r === PUNT && R() < RET_TD_ON_PUNT) { sc[o] += 7; next = k; if (ftd < 0) ftd = -4 - o; }
      if (fsc < 0 && (sc[0] || sc[1])) fsc = sc[0] > sc[1] ? 0 : 1;
      const ld = Math.sign(sc[0] - sc[1]); if (ld !== 0 && lead !== 0 && ld !== lead) lch++; if (ld !== 0) lead = ld;
      // record
      slotN[k * SLOTS + slot]++; slotR[(k * SLOTS + slot) * NR + r]++;
      const lg = log ? [k, dno, qtr, tl0, r, tp[0], sc[0], sc[1], []] : null;
      for (const i of touched) {
        const gix = gi * NP + base[k] + i;
        G.tgt[gix] += X.tgt[i]; G.rec[gix] += X.rec[i]; G.recYd[gix] += X.recYd[i]; G.car[gix] += X.car[i]; G.rushYd[gix] += X.rushYd[i]; G.td[gix] += X.td[i];
        if (H) { const h = ((base[k] + i) * SLOTS + slot) * NB; const put = (key, v) => { H[h + DOFF[key] + clamp(v, 0, DSTATS[key])]++; };
          put('tgt', X.tgt[i]); put('rec', X.rec[i]); put('recYd', X.recYd[i]); put('car', X.car[i]); put('rushYd', X.rushYd[i]); put('tch', X.rec[i] + X.car[i]); put('td', X.td[i]); }
        if (lg) lg[8].push([i, X.tgt[i], X.rec[i], X.recYd[i], X.car[i], X.rushYd[i], X.td[i]]);
        X.tgt[i] = X.rec[i] = X.recYd[i] = X.car[i] = X.rushYd[i] = X.td[i] = 0;
      }
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
  return { n, seed, NP, base, P: [TT[0].P, TT[1].P], G, H, slotN, slotR, score, half, drives, tds, firstTd, firstScore, ot, leadCh, q4trail, tdDriveSlot, logs, spp: E.spp,
    eng: { tdMul: TT.map(t => t.tdMul), touchMul: TT.map(t => t.touchMul), pfOdds: TT.map(t => t.pfOdds) } };
}
// pilot calibration: TD rate -> team lambda, clock -> expected drives, volumes / shares / catch rate / yards -> model means
export function calibrate(I, { pilots = 2, n = 1500, seed = 7 } = {}) {
  const E = makeEngine(I); const hist = [];
  for (let it = 0; it < pilots; it++) {
    const S = simulate(I, { n, seed: seed + it * 101, record: false, E });
    const m = means(S); let dAvg = 0;
    for (let k = 0; k < 2; k++) {
      const t = E.T[k], ti = I.teams[k]; const st = m.team[k]; dAvg += st.drives / 2;
      if (st.td > 0 && ti.teamLambda > 0) t.tdMul = clamp(t.tdMul * (ti.teamLambda / st.td), 0.05, 4);
      const want = ti.tgtTot + ti.carTot, got = st.tgt + st.car; if (got > 0 && want > 0) t.touchMul = clamp(t.touchMul * want / got, 0.4, 2.5);
      // team pass/run split: the scenario mix (lead → run) can drift the split away from the model's projected volume; fix it in odds space
      if (ti.tgtTot > 0.5 && ti.carTot > 0.5 && st.tgt > 0.5 && st.car > 0.5) t.pfOdds = clamp(t.pfOdds * (ti.tgtTot / ti.carTot) / (st.tgt / st.car), 0.4, 2.5);
      for (let i = 0; i < t.P; i++) {
        const p = t.pl[i], s = m.pl[S.base[k] + i]; const f = (want, got, lo = 0.4, hi = 2.5) => (want > 0.02 && got > 0.02) ? clamp(want / got, lo, hi) : 1;
        const ft = f(p.tgt, s.tgt), fc = f(p.car, s.car); for (const w of t.wT) w[i] *= ft; for (const w of t.wC) w[i] *= fc;
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
export function runSim(I, { n = 10000, seed = 1, pilots = 3, pilotN = 1200 } = {}) {
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
export function summarize(S, I) {
  const n = S.n; const A = I.away, B = I.home; const M = means(S);
  let wa = 0, wb = 0, tie = 0, otN = 0; const tot = new Int16Array(n), mar = new Int16Array(n); const fs = new Map();
  for (let g = 0; g < n; g++) { const a = S.score[g * 2], b = S.score[g * 2 + 1]; if (a > b) wa++; else if (b > a) wb++; else tie++; tot[g] = a + b; mar[g] = b - a; if (S.ot[g]) otN++; const key = a > b ? `${a}-${b}` : `${b}-${a}`; const kk = `${a > b ? A : b > a ? B : 'tie'}|${key}`; fs.set(kk, (fs.get(kk) || 0) + 1); }
  const L = I.lines || null; const line = L?.known ? { spreadHome: L.homeSpread ?? (L.awaySpread != null ? -L.awaySpread : null), total: L.totalKnown ? L.total : null } : null;
  const over = line?.total != null ? pAtLeast(tot, line.total + 0.01) : null; const homeCover = line?.spreadHome != null ? (() => { let c = 0; for (const m of mar) if (m + line.spreadHome > 0) c++; return c / n; })() : null;
  const hist = (arr, w) => { const m = new Map(); for (const v of arr) { const b = Math.floor(v / w) * w; m.set(b, (m.get(b) || 0) + 1); } return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([b, c]) => [b, c / n]); };
  const top = [...fs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, c]) => { const [w, s] = k.split('|'); return { winner: w, score: s, p: c / n }; });
  const team = [0, 1].map(k => { const sc = new Int16Array(n), h = new Int16Array(n), dr = new Int16Array(n), td = new Int16Array(n); for (let g = 0; g < n; g++) { sc[g] = S.score[g * 2 + k]; h[g] = S.half[g * 2 + k]; dr[g] = S.drives[g * 2 + k]; td[g] = S.tds[g * 2 + k]; }
    const tdDist = new Array(7).fill(0); for (const v of td) tdDist[Math.min(6, v)]++;
    const slots = []; for (let s = 0; s < SLOTS; s++) { const hn = S.slotN[k * SLOTS + s]; if (!hn) break; const r = {}; RESULTS.forEach((nm, ri) => { r[nm] = S.slotR[(k * SLOTS + s) * NR + ri] / hn; }); slots.push({ n: s + 1, happen: hn / n, ...r }); }
    return { team: k ? B : A, pts: dist(sc), halfPts: dist(h), drives: dist(dr), td: dist(td), tdDist: tdDist.map(c => c / n), slots, mean: M.team[k] }; });
  // players
  const players = []; for (let k = 0; k < 2; k++) for (let i = 0; i < S.P[k]; i++) { const j = S.base[k] + i; const p = I.teams[k].players[i]; const m = M.pl[j];
    players.push({ j, k, team: k ? B : A, id: p.id, gsis: p.gsis, name: p.name, pos: p.pos, model: { chance: p.chance, lam: p.lam, tgt: p.tgt, car: p.car, rec: p.rec, recYd: p.recYd, rushYd: p.rushYd, passTd: p.passTdExp }, history: !!p.history,
      anytime: m.anytime, twoPlus: m.twoPlus, td: m.td, passTd: p.pos === 'QB' ? m.passTd : null, rec: dist(playerArr(S, j, 'rec')), recYd: dist(playerArr(S, j, 'recYd')), car: dist(playerArr(S, j, 'car')), rushYd: dist(playerArr(S, j, 'rushYd')), tgt: m.tgt, pats: p.pats || [] }); }
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
  return { n, seed: S.seed, away: A, home: B, version: SIM_VERSION, ms: S.ms, pilot: S.pilot, line, win: { away: wa / n, home: wb / n, tie: tie / n, ot: otN / n }, over, homeCover,
    total: dist(tot), margin: dist(mar), totHist: hist(tot, 3), marHist: hist(mar, 3), top, team, players, firstTd, pairs: pairs.slice(0, 40), whenScores, scripts, combos,
    example: ex >= 0 ? { g: ex, score: [S.score[ex * 2], S.score[ex * 2 + 1]], drives: S.logs[ex] } : null, targetDrives: I.targetDrives, notes: I.teams.map(t => t.note).filter(Boolean) };
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
export { RES_TXT as RESULT_TEXT };
