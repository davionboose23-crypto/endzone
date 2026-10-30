// ENDZONE play-by-play simulator (app 4.10.0, beta; sim-pbp-2 since app 4.11.0). Research / UI only: never feeds the live anytime chance, MODEL_VERSION or
// the gate. Plays every snap of a matchup N times from PRE-GAME inputs only:
//   - play-level team rates from nflverse play-by-play (src/pbp-fit.js -> archive/pbp/<s>/w<w>.json, fitted only on games
//     BEFORE the week): pass rate by down x distance x field zone x game script (+ each offense's red-zone tilt), sacks,
//     scrambles, interceptions, completions, explosive plays and red-zone TD rates — each offense AND defense opponent-adjusted
//     and ridge-shrunk to league; pace; league yards pools, kicking, punting, returns, penalties, fourth-down habits, clock;
//   - player usage by field zone x down (who gets targets / carries outside the 20, 20-11, 10-6, inside the 5, early vs
//     late downs) from real plays, blended with the model's projections (who plays, injuries, roles, volumes).
// Game state: down, distance, yard line, clock (two-minute warning, hurry-up, timeouts, kneel-downs), score, kickoffs,
// punts, field goals by distance, turnovers with return spots, safeties, PAT / two-point choice, overtime (both teams possess).
// TDs are credited to the player who carried or caught the ball on the scoring play (passing TDs to the QB who threw it).
// Output uses the same raw structure as the drive sim (src/sim.js) so summarize / driveCard / tdPatterns work unchanged,
// plus field-position and red-zone arrays (S.pbp). Every game has its own seeded RNG, so any game can be replayed play by play.
import { makeRng, SLOTS, DSTATS, GSTATS, RESULTS, summarize, gamma } from './sim.js';
import { dispFor, temper, anchorFor, dataLevelFor } from './usage-var.js';
import { zoneOf, distB, scriptOf, passCell, ylB10, togoB4, uzOf, ucell, PBP_VERSION } from './pbp-common.js';
// sim-pbp-2 (app 4.11.0) adds, when the params carry the X2 block (src/pbp-fit.js): offense-vs-defense rates with a home-field
// term, the starting QB's own sack / scramble / interception / completion / explosive / yards effects, team fourth-down
// go-for-it and kicker-accuracy offsets, QB sneaks on 1-to-go (team rate, real yards pool), short-yardage run pools, team
// penalty rates (offense and defense), spikes in the two-minute drill with no timeouts, and a per-game form draw
// (SIM_PBP_TUNE.form). Params without X2, or opts.legacy, replay sim-pbp-1 exactly (tests/sim-pbp2.test.js).
export const SIM_PBP_VERSION = 'sim-pbp-2';
const NR = RESULTS.length; const TD = 0, FG = 1, MFG = 2, PUNT = 3, TO = 4, DOWNS = 5, HALF = 6, SAF = 7;
const DKEYS = Object.keys(DSTATS); const DOFF = {}; let NB = 0; for (const k of DKEYS) { DOFF[k] = NB; NB += DSTATS[k] + 1; }
const clamp = (x, a, b) => Math.max(a, Math.min(b, x)); const sig = x => 1 / (1 + Math.exp(-x)); const logit = p => Math.log(p / (1 - p));
const TDAGG = 8; const LOGN = 400;
export const SIM_PBP_TUNE = { clock: 1.06, rzAdj: 0.2, spread: 4, form: 0.2 };
// form (sim-pbp-2): game-day variance. Each offense draws one N(0, form) logit shift per simulated game, applied to completion,
// explosive-play and red-zone TD odds (and against sacks / interceptions), so a team can have a good or a bad day as a whole
// instead of every snap being independent. Tuned on 2025 only so the spread of simulated points matches real games.
const CLOCK = SIM_PBP_TUNE.clock, RZ_ADJ = SIM_PBP_TUNE.rzAdj; // CLOCK: gap tables are snap-to-snap averages, 1.06 reproduces 2025 snaps per team-game. RZ_ADJ: logit lift on red-zone TD per play so league-average sims match 2025 red-zone TD rate (sequencing: real trips get more snaps via defensive penalties)
const POS_CR = { WR: 0.63, TE: 0.7, RB: 0.77, FB: 0.75, QB: 0.6 }; const POS_YPR = { WR: 12.6, TE: 10.4, RB: 7.6, FB: 7, QB: 8 }; const POS_YPC = { RB: 4.3, QB: 4.8, WR: 6.5, TE: 3, FB: 3 };
const tdyoB = y => y <= 2 ? 0 : y <= 5 ? 1 : y <= 10 ? 2 : y <= 20 ? 3 : y <= 40 ? 4 : 5;
// ---------- matchup inputs (main thread): the per-team slices of the weekly params for this game; plain JSON for the worker
// opts.legacy = true replays sim-pbp-1 exactly (validation); sim-pbp-2 needs the X2 block of the weekly params (pbp-fit 4.11.0)
export function pbpMatchup(P, away, home, teams, opts = {}) {
  if (!P || P.kind !== 'pbp-params') return null; const ti = t => P.teams.indexOf(t); const X2 = !opts.legacy && P.X2 ? P.X2 : null; const M = X2 ? X2.M : P.M; const Mp = P.M;
  const g = (m, key, i) => (i >= 0 && m && m[key]) ? (m[key][i] || 0) : 0; const SP = SIM_PBP_TUNE.spread;
  const side = (o, d, h) => { const io = ti(o), id = ti(d); const hm = m => (X2 ? g(m, 'home', h) : 0);
    const add = m => r4(m.icept + SP * (g(m, 'off', io) + g(m, 'def', id)) + hm(m));
    return { team: o, opp: d, known: io >= 0 && id >= 0, pass: add(M.pass), passRz: r4(g(M.pass, 'offRz', io)), sack: add(M.sack), scr: add(M.scr), int: add(M.int), cmp: add(M.cmp), expP: add(M.expP), expR: add(M.expR), rzTd: add(M.rzTd), ydsR: M.ydsR ? r4(SP * (g(M.ydsR, 'off', io) + g(M.ydsR, 'def', id)) + hm(M.ydsR)) : 0, ydsC: M.ydsC ? r4(SP * (g(M.ydsC, 'off', io) + g(M.ydsC, 'def', id)) + hm(M.ydsC)) : 0,
      pace: r4(clamp((Mp.pace.icept + g(Mp.pace, 'off', io) + g(Mp.pace, 'def', id)) / Mp.pace.icept, 0.85, 1.15)) }; };
  const bySl = new Map(); for (const [g, u] of Object.entries(P.use.players)) if (u.s) bySl.set(String(u.s), g);
  const usage = teams.map(t => t.players.map(p => { const gk = p.gsis && P.use.players[p.gsis] ? p.gsis : bySl.get(String(p.id)); const u = gk ? P.use.players[gk] : null; const m = P.use.pos[p.pos] || P.use.pos.WR;
    return u ? { mt: u.mt, mc: u.mc, h: u.h, src: 'player' } : { mt: m?.t || Array(8).fill(1), mc: m?.c || Array(8).fill(1), h: null, src: 'position' }; }));
  return { version: P.version, season: P.season, week: P.week, through: P.through, nPlays: P.nPlays, base: { pass: M.pass.cell, passScript: M.pass.script, sackDd: M.sack.dd, sackZone: M.sack.zone, scrDist: M.scr.dist, scrZone: M.scr.zone,
    intDist: M.int.dist, intZone: M.int.zone, intScript: M.int.script, cmpDist: M.cmp.dist, cmpZone: M.cmp.zone, expP: M.expP.zone, expR: M.expR.zone, rzTd: M.rzTd.cell, paceIcept: Mp.pace.icept },
  side: [side(away, home, 0), side(home, away, 1)], usage, L: P.P, hist: P.hist ? [P.hist[away] || null, P.hist[home] || null] : null, x2: X2 ? matchupV2(P, X2, [away, home], teams, ti, g, SP) : null };
}
// sim-pbp-2 per-matchup extras: QB-specific passing effects for every QB on each roster, team fourth-down aggressiveness,
// kicker / field-goal accuracy, QB-sneak habit, penalty rates (offense fouls by the offense, defense fouls by the defense)
function matchupV2(P, X2, tm, teams, ti, g, SP) {
  const M = X2.M; const lg = q => Math.log(q / (1 - q));
  const qbFx = teams.map(t => t.players.map(p => { if (p.pos !== 'QB') return null; const qi = p.gsis ? X2.qbs.indexOf(p.gsis) : -1; if (qi < 0) return null;
    const v = { cmp: SP * g(M.cmp, 'qb', qi), int: SP * g(M.int, 'qb', qi), sack: SP * g(M.sack, 'qb', qi), scr: SP * g(M.scr, 'qb', qi), expP: SP * g(M.expP, 'qb', qi), dC: SP * g(M.ydsC, 'qb', qi) };
    for (const k of Object.keys(v)) v[k] = r4(v[k]); return v; }));
  return { form: SIM_PBP_TUNE.form, qbFx, go: tm.map(t => g(X2, 'go', ti(t))), fg: tm.map(t => g(X2, 'fgT', ti(t))),
    sneak: tm.map(t => r4(sig(lg(X2.sneak.rate) + g(X2.sneak, 't', ti(t))))), sneakY: X2.sneak.y, runSY: X2.runSY,
    pen: [[g(X2.pen, 'off', ti(tm[0])) || 1, g(X2.pen, 'def', ti(tm[1])) || 1], [g(X2.pen, 'off', ti(tm[1])) || 1, g(X2.pen, 'def', ti(tm[0])) || 1]] };
}
const r4 = x => Math.round(x * 1e4) / 1e4;
// ---------- engine (precomputed probability tables per team)
export function makePbpEngine(I) {
  const X = I.pbp; if (!X) throw new Error('play-by-play mode needs the weekly play-by-play params (archive/pbp)');
  const B = X.base, L = X.L;
  const T = I.teams.map((t, k) => {
    const s = X.side[k]; const pl = t.players; const P = pl.length; const U = X.usage[k];
    const pPass = new Float64Array(4 * 96); for (let sc = 0; sc < 4; sc++) for (let c = 0; c < 96; c++) pPass[sc * 96 + c] = sig(s.pass + B.pass[c] + B.passScript[sc] + ((c % 6) >= 3 ? s.passRz : 0));
    const pSack = new Float64Array(16 * 6); for (let a = 0; a < 16; a++) for (let z = 0; z < 6; z++) pSack[a * 6 + z] = sig(s.sack + B.sackDd[a] + B.sackZone[z]);
    const pScr = new Float64Array(24); for (let a = 0; a < 4; a++) for (let z = 0; z < 6; z++) pScr[a * 6 + z] = sig(s.scr + B.scrDist[a] + B.scrZone[z]);
    const pInt = new Float64Array(96); for (let a = 0; a < 4; a++) for (let z = 0; z < 6; z++) for (let sc = 0; sc < 4; sc++) pInt[(a * 6 + z) * 4 + sc] = sig(s.int + B.intDist[a] + B.intZone[z] + B.intScript[sc]);
    const lCmp = new Float64Array(24); for (let a = 0; a < 4; a++) for (let z = 0; z < 6; z++) lCmp[a * 6 + z] = s.cmp + B.cmpDist[a] + B.cmpZone[z] - Math.log(1 - (L.noTgt ?? 0.043)); // completion | targeted (the fit's base includes throwaways)
    const pExpP = B.expP.map(v => sig(s.expP + v)), pExpR = B.expR.map(v => sig(s.expR + v)), pRzTd = B.rzTd.map(v => sig(s.rzTd + v + RZ_ADJ));
    const pGl = new Float64Array(6); for (let K = 0; K < 3; K++) for (let b = 0; b < 2; b++) pGl[K * 2 + b] = sig(s.rzTd + B.rzTd[6 + K] + RZ_ADJ + (L.gl?.[K]?.[b] ?? 0));
    // usage weights per cell (8) — model volume x zone/down multiplier; QB designed carries ~45% of his projected carries (scrambles are separate)
    const qb = pl.map(p => p.pos === 'QB'); const wT = new Float64Array(P * 8), wC = new Float64Array(P * 8);
    for (let i = 0; i < P; i++) for (let c = 0; c < 8; c++) { wT[i * 8 + c] = (qb[i] ? 0 : pl[i].tgt) * (U[i].mt[c] ?? 1); wC[i * 8 + c] = pl[i].car * (qb[i] ? 0.45 : 1) * (U[i].mc[c] ?? 1); }
    const cOff = new Float64Array(P), yF = new Float64Array(P), cF = new Float64Array(P);
    for (let i = 0; i < P; i++) { const p = pl[i]; const cr = p.tgt > 0.3 ? clamp(p.rec / p.tgt, 0.3, 0.92) : POS_CR[p.pos] ?? 0.65; cOff[i] = 0.7 * (logit(cr) - logit(POS_CR[p.pos] ?? 0.65));
      yF[i] = p.rec > 0.3 && p.recYd > 0 ? clamp(Math.pow((p.recYd / p.rec) / (POS_YPR[p.pos] ?? 11), 0.7), 0.7, 1.4) : 1; cF[i] = p.car > 0.5 && Number.isFinite(p.rushYd) ? clamp(Math.pow(Math.max(1, p.rushYd / p.car) / (POS_YPC[p.pos] ?? 4.3), 0.6), 0.7, 1.35) : 1; }
    const qbs = pl.map(p => p.passShare || 0); let qbTot = qbs.reduce((a, b) => a + b, 0); if (qbTot <= 0) { const j = pl.findIndex(p => p.pos === 'QB'); if (j >= 0) { qbs[j] = 1; qbTot = 1; } }
    const V = X.x2; const v2 = V ? { qbFx: V.qbFx[k], go: V.go[k] || 0, fg: V.fg[k] || 0, sneak: V.sneak[k], penO: L.pen.off * V.pen[k][0], penD: L.pen.def * V.pen[k][1] } : null;
    return { P, pl, pPass, pSack, pScr, pInt, lCmp, pExpP, pExpR, pRzTd, pGl, dR: s.ydsR || 0, dC: s.ydsC || 0, wT, wC, cOff, yF, cF, qbs, qbTot, pace: s.pace, fT: new Float64Array(P).fill(1), fC: new Float64Array(P).fill(1), lvl: 0, v2 };
  });
  return { I, T, L, V: X.x2 || null, totW: null };
}
function cellTotals(E) { for (const t of E.T) { t.sT = new Float64Array(8); t.sC = new Float64Array(8); t.uT = new Float64Array(t.P * 8); t.uC = new Float64Array(t.P * 8);
  for (let c = 0; c < 8; c++) for (let i = 0; i < t.P; i++) { const a = t.wT[i * 8 + c] * t.fT[i], b = t.wC[i * 8 + c] * t.fC[i]; t.uT[c * t.P + i] = a; t.uC[c * t.P + i] = b; t.sT[c] += a; t.sC[c] += b; }
  const dp = dispFor(E.I, 'pbp'); t.kap = E.V ? dp.kappa : Infinity; t.dS = temper(t.pl.map(p => p.lam || 0), 1); if (isFinite(t.kap)) { t.uT0 = t.uT.slice(); t.uC0 = t.uC.slice(); } } }
// 4.13.0 usage-var-1: this game's red-zone usage (cells inside the 20) gets a per-player multiplier Gamma(kappa*s)/(kappa*s), s = his
// share of the team's TDs, so each simulated game has its own scorer split (Dirichlet-like around the mean); between the 20s is untouched
function perturbGame(E, R) { for (const t of E.T) { if (!isFinite(t.kap) || !t.uT0) continue; const P = t.P;
  for (let c = 2; c < 8; c++) { t.sT[c] = 0; t.sC[c] = 0; }
  for (let i = 0; i < P; i++) { const a = t.kap * t.dS[i]; const m = a > 0 ? gamma(R, a) / a : 1; for (let c = 2; c < 8; c++) { const j = c * P + i; const x = t.uT0[j] * m, y = t.uC0[j] * m; t.uT[j] = x; t.uC[j] = y; t.sT[c] += x; t.sC[c] += y; } } } }
const q = (arr, R) => arr[(R() * arr.length) | 0];
const adj = (p, a) => (a === 0 || !(p > 0 && p < 1) ? p : sig(Math.log(p / (1 - p)) + a));
const gauss = R => { let u = 0; while (u === 0) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R()); }; // shift a precomputed probability on the logit scale (form / QB)
const ZA = { cmp: 0, int: 0, sack: 0, scr: 0, expP: 0, expR: 0, rz: 0, dC: 0 };
// situational counters per team (sim-pbp-2 Situations card)
export const SIT = ['d3', 'd3c', 'd4', 'd4c', 'fga', 'fgm', 'punt', 'sack', 'int', 'fum', 'expP', 'expR', 'sneak', 'sneakC', 'pen', 'spike', 'plays', 'yds'];
const SI = Object.fromEntries(SIT.map((k, i) => [k, i])); const NS = SIT.length;
function pickCell(u, s, c, P, R) { if (!(s > 0)) return -1; let x = R() * s; const o = c * P; for (let i = 0; i < P; i++) { x -= u[o + i]; if (x < 0) return i; } return P - 1; }
// ---------- one game. W = output writer (arrays for the whole run) or null; log = array for a play-by-play replay or null
function playGame(E, R, gi, W, log) {
  perturbGame(E, R);
  const I = E.I, L = E.L, TT = E.T; const NP = TT[0].P + TT[1].P; const base = [0, TT[0].P];
  const sc = [0, 0], dn = [0, 0], to = [3, 3]; let hf = 1, tl = 1800, tmw = false; const recv0 = R() < 0.5 ? 0 : 1; let pos = recv0; const otPoss = [0, 0];
  const qbG = TT.map(t => { if (!(t.qbTot > 0)) return -1; let x = R() * t.qbTot; for (let i = 0; i < t.P; i++) { x -= t.qbs[i]; if (x < 0) return i; } return t.P - 1; });
  // sim-pbp-2: this game's adjustments per offense = the QB who plays (his own passing effects) + a game-day form draw
  const V = E.V; const AJ = [0, 1].map(kk => { if (!V) return ZA; const f = V.form > 0 ? V.form * gauss(R) : 0; const fx = qbG[kk] >= 0 ? TT[kk].v2.qbFx[qbG[kk]] : null;
    return { cmp: f + (fx?.cmp || 0), int: -f + (fx?.int || 0), sack: -f + (fx?.sack || 0), scr: fx?.scr || 0, expP: f + (fx?.expP || 0), expR: f, rz: f, dC: fx?.dC || 0, f }; });
  const sit = W && W.sit ? W.sit : null; const st = (kk, key, v = 1) => { if (sit) sit[kk * NS + SI[key]] += v; };
  let ftd = -1, fsc = -1, lead = 0, lch = 0, trailedQ4 = 0; const ftdT = [-1, -1]; const tdSlot = [0, 0]; const dlog = W && gi < LOGN ? [] : null;
  const X = [0, 1].map(k => ({ tgt: new Int16Array(TT[k].P), rec: new Int16Array(TT[k].P), recYd: new Int16Array(TT[k].P), car: new Int16Array(TT[k].P), rushYd: new Int16Array(TT[k].P), td: new Int8Array(TT[k].P), touched: [] }));
  let rzG = [0, 0], rzTdG = [0, 0], i10G = [0, 0];
  const qtrOf = () => hf === 3 ? 5 : (hf - 1) * 2 + (tl > 900 ? 1 : 2);
  const clk = () => { const s = Math.max(0, Math.round(hf === 3 ? tl : tl > 900 ? tl - 900 : tl)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const ev = (o) => { if (log) log.push({ q: qtrOf(), clk: clk(), sc: [sc[0], sc[1]], ...o }); };
  const runClock = (g) => { if (hf <= 2 && !tmw && tl > 120 && tl - g < 120) { tl = 120; tmw = true; ev({ t: 'note', txt: 'Two-minute warning' }); return; } tl -= g; };
  let kickTo = recv0; let needKick = true; let onside = false; let yl = 75, down = 1, togo = 10; let k = pos; let guard = 0; let gameOver = false;
  const touch = (kk, i) => { const x = X[kk]; if (x.tgt[i] === 0 && x.car[i] === 0 && x.td[i] === 0) x.touched.push(i); };
  const score = (kk, pts) => { sc[kk] += pts; if (fsc < 0 && (sc[0] || sc[1])) fsc = sc[0] > sc[1] ? 0 : 1; const ld = Math.sign(sc[0] - sc[1]); if (ld !== 0 && lead !== 0 && ld !== lead) lch++; if (ld !== 0) lead = ld; };
  const pat = (kk) => { const d = sc[kk] - sc[1 - kk]; const late = hf >= 2 && (hf === 3 || tl <= 840); const go2 = late && [-16, -13, -10, -5, -2, 1, 5, 12].includes(d);
    if (go2) { const ok = R() < L.two; if (ok) score(kk, 2); ev({ t: 'pat', k: kk, two: 1, ok }); } else { const ok = R() < L.xp; if (ok) score(kk, 1); ev({ t: 'pat', k: kk, two: 0, ok }); } };
  const halfOver = () => { // returns true when the game is over
    if (hf === 1) { hf = 2; tl = 1800; tmw = false; to[0] = to[1] = 3; kickTo = 1 - recv0; needKick = true; onside = false; ev({ t: 'note', txt: 'Halftime' }); if (W) { W.half[gi * 2] = sc[0]; W.half[gi * 2 + 1] = sc[1]; } return false; }
    if (hf === 2 && sc[0] === sc[1]) { hf = 3; tl = 600; to[0] = to[1] = 2; kickTo = R() < 0.5 ? 0 : 1; needKick = true; onside = false; ev({ t: 'note', txt: 'Overtime' }); return false; }
    return true;
  };
  while (!gameOver && guard++ < 400) {
    // ---- kickoff
    if (needKick) { needKick = false; const kicker = 1 - kickTo; let recv = kickTo; runClock(4);
      const d = sc[kicker] - sc[recv]; const tryOnside = hf === 2 && tl <= 300 && d < 0 && d >= -16;
      if (tryOnside && R() < 0.12) { recv = kicker; yl = 55; ev({ t: 'ko', k: kicker, onside: 1, rec: 1 }); }
      else if (R() < L.koTd) { score(recv, 6); ev({ t: 'ko', k: kicker, ret: recv, td: 1 }); if (ftd < 0) ftd = -4 - recv; if (W) { W.tdSrc[recv * 4 + 3]++; } pat(recv); kickTo = kicker; needKick = true; if (hf === 3 && sc[0] !== sc[1] && otPoss[0] + otPoss[1] >= 1) break; continue; }
      else { yl = tryOnside ? 50 + ((R() * 8) | 0) : clamp(q(L.koStart, R), 1, 99); ev({ t: 'ko', k: kicker, ret: recv, yl }); }
      pos = recv; down = 1; togo = Math.min(10, yl);
    }
    if (tl <= 0) { if (halfOver()) break; continue; }
    // ---- drive
    k = pos; const o = 1 - k; const t = TT[k], x = X[k]; dn[k]++; const dno = dn[k]; const slot = Math.min(dno, SLOTS) - 1; if (hf === 3) otPoss[k]++;
    const startYl = yl, tl0 = tl, q0 = qtrOf(), hf0 = hf, two = tl <= 120 && hf <= 2; let plays = 0, res = -1, rz = false, i10 = false, tdKind = -1, tdYo = 0, scorer = -1, passer = -1;
    if (q0 === 4 && trailedQ4 === 0 && sc[0] !== sc[1]) trailedQ4 = sc[0] < sc[1] ? 1 : 2;
    ev({ t: 'drive', k, dno, yl });
    for (let pg = 0; pg < 60; pg++) {
      if (tl <= 0) { res = HALF; break; }
      if (yl <= 20 && !rz) { rz = true; } if (yl <= 10) i10 = true;
      const sd = sc[k] - sc[o]; const qtr = qtrOf(); const S = hf === 3 ? (sd < 0 ? 2 : 0) : scriptOf(qtr, tl, sd); const z = zoneOf(yl); const db = distB(togo);
      // kneel-downs
      const kneelsLeft = 4 - down; const burn = Math.max(0, kneelsLeft - to[o]) * 40 + 2;
      if ((hf === 2 && sd > 0 && down <= 3 && tl <= burn) || (hf === 1 && tl <= 30 && yl >= 70 && down <= 3)) {
        plays++; yl = Math.min(99, yl + 1); ev({ t: 'kneel', k, down, togo, yl }); if (to[o] > 0 && hf === 2) { to[o]--; runClock(2); } else runClock(Math.min(tl, 40)); down++; togo++; continue; }
      // fourth down / end-of-half field goal
      const fgDist = yl + 18; const pFg = fgDist > 66 ? 0 : sig(L.fg.a + L.fg.b * (fgDist - 40) + (t.v2 ? t.v2.fg : 0));
      let choice = 0; // 0 play, 1 FG, 2 punt
      const lastPlay = hf <= 2 && tl <= (to[k] > 0 ? 8 : 20); // end of half: kick it now (offense out of time)
      if (lastPlay && pFg > 0.25 && (hf === 1 || (sd <= 0 && sd >= -3))) choice = 1;
      else if (down === 4) {
        const late2 = hf >= 2 && tl <= 300;
        if (hf === 2 && tl <= 120 && sd < 0) choice = (sd >= -3 && pFg > 0.4) ? 1 : 0;
        else if (late2 && sd < -8) choice = (yl < 60 || tl <= 180) ? 0 : 2;
        else if (hf === 1 && tl <= 30) choice = pFg > 0.3 ? 1 : yl <= 45 ? 0 : 2;
        else if (hf === 3 && sd < 0) choice = (sd >= -3 && pFg > 0.5) ? 1 : 0;
        else { const c = L.fourth[ylB10(yl) * 4 + togoB4(togo)]; if (!c) throw new Error(`4th ${yl} ${togo} ${down}`); const u = R();
          let g0 = c[0], g1 = c[1]; if (t.v2 && t.v2.go) { const gn = adj(clamp(c[0], 0.002, 0.998), t.v2.go); const sc2 = (1 - gn) / Math.max(1e-6, 1 - c[0]); g0 = gn; g1 = c[1] * sc2; } // team go-for-it habit
          choice = u < g0 ? 0 : u < g0 + g1 ? 1 : 2;
          if (choice === 1 && pFg < 0.2) choice = yl <= 40 ? 0 : 2; if (choice === 2 && yl < 35) choice = pFg > 0.4 ? 1 : 0; }
      }
      if (choice === 1) { plays++; const good = R() < pFg; st(k, 'fga'); if (good) st(k, 'fgm'); ev({ t: 'fg', k, dist: fgDist, good, down, togo, yl }); runClock(5);
        if (good) { score(k, 3); res = FG; } else { res = MFG; } break; }
      if (choice === 2) { plays++; const b = L.punt[ylB10(yl)]; runClock(9); st(k, 'punt');
        if (R() < b.td) { score(o, 6); ev({ t: 'punt', k, yl, td: 1 }); res = PUNT; if (ftd < 0) ftd = -4 - o; if (W) W.tdSrc[o * 4 + 3]++; pat(o); kickTo = k; needKick = true; break; }
        const ny = clamp(q(b.y, R), 1, 99); ev({ t: 'punt', k, yl, ny }); res = PUNT; yl = ny; break; }
      // pre-snap penalties
      const up = R(); const pO = t.v2 ? t.v2.penO : L.pen.off, pD = t.v2 ? t.v2.penD : L.pen.def;
      if (up < pO) { st(k, 'pen'); let y = q(L.pen.offY, R); y = Math.min(y, Math.floor((100 - yl) / 2)); yl += y; togo += y; ev({ t: 'pen', k, off: 1, y, down, togo, yl }); runClock(S === 3 ? 0 : 11); continue; }
      if (up < pO + pD) { let y = q(L.pen.defY, R); y = Math.min(y, Math.max(0, Math.floor(yl / 2))); yl -= y; togo -= y; const auto = R() < L.pen.def1st;
        if (auto || togo <= 0) { down = 1; togo = Math.min(10, yl); } ev({ t: 'pen', k, off: 0, y, down, togo, yl }); runClock(S === 3 ? 0 : 11); continue; }
      // the snap
      plays++; const c8 = ucell(yl, down); let yds = 0, kind = 0, j = -1, td = false, turnover = 0, cat = 0, ob = false, sacked = false, sneak = false; const A = AJ[k];
      const passP = t.pPass[S * 96 + passCell(down, togo, yl)]; if (down === 3) st(k, 'd3'); else if (down === 4) st(k, 'd4');
      if (R() < passP) {
        if (R() < adj(t.pSack[((Math.min(4, down) - 1) * 4 + db) * 6 + z], A.sack)) { sacked = true; kind = 3; yds = q(L.sackY, R); if (R() < L.fum.sack) turnover = 2; st(k, 'sack'); }
        else if (R() < adj(t.pScr[db * 6 + z], A.scr)) { kind = 2; j = qbG[k];
          if (z >= 3) { if (R() < adj(z === 5 ? t.pGl[2 * 2 + (yl <= 2 ? 0 : 1)] : t.pRzTd[(z - 3) * 3 + 2], A.rz + t.lvl)) { yds = yl; td = true; } else yds = Math.min(q(L.rzNon[(z - 3) * 3 + 2], R), yl - 1); } else { yds = q(L.scrO, R); if (yds >= yl) { yds = yl; td = true; } }
          if (!td && R() < L.fum.scr) turnover = 2; }
        else { kind = 1; j = pickCell(t.uT, t.sT[c8], c8, t.P, R);
          if (R() < adj(t.pInt[(db * 6 + z) * 4 + S], A.int)) { turnover = 1; }
          else if (R() < (L.noTgt ?? 0.043)) { j = -1; cat = 1; } // thrown away / no intended receiver
          else if (R() < sig(t.lCmp[db * 6 + z] + (j >= 0 ? t.cOff[j] : 0) + A.cmp)) {
            if (z >= 3) { if (R() < adj(z === 5 ? t.pGl[1 * 2 + (yl <= 2 ? 0 : 1)] : t.pRzTd[(z - 3) * 3 + 1], A.rz + t.lvl)) { yds = yl; td = true; } else yds = Math.min(q(L.rzNon[(z - 3) * 3 + 1], R), yl - 1); }
            else { const ex = R() < adj(t.pExpP[z], A.expP); if (ex) st(k, 'expP'); yds = ex ? q(L.cmpX[z], R) : q(L.cmpN[z], R) + Math.floor(t.dC + A.dC + R()); if (yds > 0 && j >= 0) yds = Math.round(yds * t.yF[j]); if (yds >= yl) { yds = yl; td = true; } }
            kind = 4; if (!td && R() < L.fum.cmp) turnover = 2;
          } else { cat = 1; }
        }
      } else if (V && togo <= 1 && qbG[k] >= 0 && R() < t.v2.sneak) { // sim-pbp-2: QB sneak on 1-to-go (league sneak yards; a TD if he crosses the line)
        kind = 0; j = qbG[k]; sneak = true; st(k, 'sneak'); yds = q(V.sneakY, R); if (yds >= yl) { yds = yl; td = true; } if (yds >= togo) st(k, 'sneakC'); if (!td && R() < L.fum.run) turnover = 2;
      } else { kind = 0; j = pickCell(t.uC, t.sC[c8], c8, t.P, R);
        if (z >= 3) { if (R() < adj(z === 5 ? t.pGl[0 * 2 + (yl <= 2 ? 0 : 1)] : t.pRzTd[(z - 3) * 3], A.rz + t.lvl)) { yds = yl; td = true; } else yds = Math.min(q(L.rzNon[(z - 3) * 3], R), yl - 1); }
        else if (V && togo <= 2) { yds = q(V.runSY[z], R) + Math.floor(t.dR + R()); if (yds > 0 && j >= 0) yds = Math.round(yds * t.cF[j]); if (yds >= yl) { yds = yl; td = true; } } // short yardage: stacked-box run pool
        else { const ex = R() < adj(t.pExpR[z], A.expR); if (ex) st(k, 'expR'); yds = ex ? q(L.runX[z], R) : q(L.runN[z], R) + Math.floor(t.dR + R()); if (yds > 0 && j >= 0) yds = Math.round(yds * t.cF[j]); if (yds >= yl) { yds = yl; td = true; } }
        if (!td && R() < L.fum.run) turnover = 2; }
      if (turnover === 1) st(k, 'int'); else if (turnover === 2) st(k, 'fum');
      if (!turnover) { st(k, 'plays'); st(k, 'yds', yds); }
      // tallies (targets / carries / catches / yards) and zone usage
      const uz = uzOf(yl);
      if (j >= 0) { touch(k, j); const gj = base[k] + j;
        if (kind === 1 || kind === 4) { x.tgt[j]++; if (W) { W.zT[gj * 4 + uz]++; W.tZ[(k * 2) * 4 + uz]++; } if (kind === 4) { x.rec[j]++; x.recYd[j] += yds; } }
        else { x.car[j]++; x.rushYd[j] += yds; if (W) { W.zC[gj * 4 + uz]++; W.tZ[(k * 2 + 1) * 4 + uz]++; } } }
      const ylBefore = yl; const dBefore = down, tgBefore = togo;
      if (turnover) { // interception or fumble lost: other team's ball with the return; pick-six / scoop-and-score
        const pool = turnover === 1 ? L.intRet : L.fumRet; runClock(6);
        ev({ t: 'play', k, kind, j, qb: qbG[k], yds: turnover === 1 ? 0 : yds, down: dBefore, togo: tgBefore, yl: ylBefore, to: turnover });
        if (R() < pool.td) { score(o, 6); if (ftd < 0) ftd = -4 - o; if (W) W.tdSrc[o * 4 + 2]++; ev({ t: 'note', txt: `${I.teams[o].team} returns it for a touchdown` }); res = TO; pat(o); kickTo = k; needKick = true; break; }
        let ny = (100 - ylBefore) + q(pool.d, R); if (ny >= 100) ny = 80; yl = clamp(ny, 1, 99); res = TO; break; }
      if (td) { if (dBefore === 3) st(k, 'd3c'); else if (dBefore === 4) st(k, 'd4c'); // offensive touchdown on this snap
        score(k, 6); res = TD; scorer = j; tdKind = kind === 0 || kind === 2 ? 0 : 1; tdYo = ylBefore; if (j >= 0) { x.td[j]++; } if (tdKind === 1) passer = qbG[k];
        ev({ t: 'play', k, kind, j, qb: qbG[k], yds, down: dBefore, togo: tgBefore, yl: ylBefore, td: 1 }); runClock(5); pat(k); kickTo = o; needKick = true; break; }
      if (ylBefore - yds >= 100) { score(o, 2); ev({ t: 'play', k, kind, j, qb: qbG[k], yds, down: dBefore, togo: tgBefore, yl: ylBefore, safety: 1 }); runClock(5); res = SAF; break; }
      yl = ylBefore - yds; togo -= yds;
      if (kind === 0 || kind === 4 || kind === 2) { const oobR = kind === 4 ? L.oob.cmp[S] : L.oob.run[S]; ob = R() < (kind === 2 ? oobR * 2 : oobR); if (ob) cat = 2; }
      ev({ t: 'play', k, kind, j, qb: qbG[k], yds, down: dBefore, togo: tgBefore, yl: ylBefore, ob, ...(sneak ? { sneak: 1 } : {}) });
      if (togo <= 0) { if (dBefore === 3) st(k, 'd3c'); else if (dBefore === 4) st(k, 'd4c'); down = 1; togo = Math.min(10, yl); } else if (down === 4) { res = DOWNS; runClock(5); yl = clamp(100 - yl, 1, 99); break; } else down++;
      // clock
      let g = L.gap[cat][S] * (cat === 0 && S <= 1 ? t.pace : 1) * CLOCK * (0.8 + 0.4 * R());
      if (cat === 0 && hf >= 2 && S === 1 && to[o] > 0 && tl <= 240) { to[o]--; g = 5; ev({ t: 'note', txt: `Timeout ${I.teams[o].team}` }); }
      else if (cat === 0 && S === 3 && to[k] > 0 && tl <= 100) { to[k]--; g = 5; ev({ t: 'note', txt: `Timeout ${I.teams[k].team}` }); }
      else if (V && cat === 0 && S === 3 && to[k] === 0 && tl <= 60 && down <= 3 && tl > 12 && R() < 0.4) { // sim-pbp-2: no timeouts left in the two-minute drill -> hurry up and spike it
        runClock(Math.min(tl, 10 + 6 * R())); if (tl <= 0) continue; plays++; st(k, 'spike'); ev({ t: 'spike', k, down, togo, yl }); down++; runClock(1); continue; }
      runClock(g);
    }
    if (res < 0) res = HALF; if (res === HALF) ev({ t: 'note', txt: 'End of half' });
    // ---- record the drive
    if (W) {
      W.slotN[k * SLOTS + slot]++; W.slotR[(k * SLOTS + slot) * NR + res]++; W.slotPlays[k * SLOTS + slot] += plays; if (dno <= SLOTS) W.gRes[(gi * 2 + k) * SLOTS + slot] = res;
      W.slotStart[k * SLOTS + slot] += startYl; W.startH[k * 10 + ylB10(startYl)]++; if (rz) { W.slotRz[k * SLOTS + slot]++; rzG[k]++; if (res === TD) rzTdG[k]++; } if (i10) i10G[k]++;
      if (res === TD) { W.tdSrc[k * 4 + tdKind]++; W.tdYo[k * 6 + tdyoB(tdYo)]++; W.slotTdRush[k * SLOTS + slot] += tdKind === 0 ? 1 : 0; W.slotTdYo[k * SLOTS + slot] += tdYo; }
      let dY = 0; const lg = dlog ? [k, dno, q0, tl0, res, plays, sc[0], sc[1], [], -1, startYl] : null; // [9] passer (-1 none), [10] start yard line
      for (const i of x.touched) { const gj = base[k] + i; const gix = gi * NP + gj;
        W.G.tgt[gix] += x.tgt[i]; W.G.rec[gix] += x.rec[i]; W.G.recYd[gix] += x.recYd[i]; W.G.car[gix] += x.car[i]; W.G.rushYd[gix] += x.rushYd[i]; W.G.td[gix] += x.td[i];
        if (W.H) { const h = (gj * SLOTS + slot) * NB; const put = (key, v) => { W.H[h + DOFF[key] + clamp(v, 0, DSTATS[key])]++; };
          put('tgt', x.tgt[i]); put('rec', x.rec[i]); put('recYd', x.recYd[i]); put('car', x.car[i]); put('rushYd', x.rushYd[i]); put('tch', x.rec[i] + x.car[i]); put('td', x.td[i]); if (x.rec[i]) put('recYdC', x.recYd[i]); if (x.car[i]) put('rushYdC', x.rushYd[i]); }
        if (lg) lg[8].push([i, x.tgt[i], x.rec[i], x.recYd[i], x.car[i], x.rushYd[i], x.td[i]]); dY += x.recYd[i] + x.rushYd[i]; }
      W.slotYds[k * SLOTS + slot] += dY;
      if (scorer >= 0) { const gj = base[k] + scorer; const a = gj * TDAGG; W.tdAgg[a + tdKind]++; W.tdAgg[a + 1 + Math.min(5, q0)]++; if (two) W.tdAgg[a + 7]++; W.plTdYo[gj * 6 + tdyoB(tdYo)]++; }
      if (passer >= 0) { W.G.passTd[gi * NP + base[k] + passer]++; if (lg) lg[9] = passer; }
      if (dlog) dlog.push(lg);
    }
    if (res === TD) { if (ftd < 0) ftd = scorer >= 0 ? base[k] + scorer : -2 - k; if (ftdT[k] === -1) ftdT[k] = scorer >= 0 ? base[k] + scorer : -2; if (!tdSlot[k]) tdSlot[k] = Math.min(255, dno); }
    for (const i of x.touched) { x.tgt[i] = x.rec[i] = x.recYd[i] = x.car[i] = x.rushYd[i] = x.td[i] = 0; } x.touched.length = 0;
    // ---- next possession
    if (res === TD || res === FG) { kickTo = o; needKick = true; }
    else if (res === SAF) { kickTo = o; needKick = false; pos = o; yl = clamp(q(L.koStart, R) - 8, 30, 90); down = 1; togo = 10; ev({ t: 'ko', k, ret: o, yl, free: 1 }); }
    else if (res === MFG) { pos = o; yl = Math.min(80, 100 - (yl + 7)); down = 1; togo = 10; } // spot of the kick, or the 20
    else if (res === PUNT || res === TO || res === DOWNS) { if (!needKick) { pos = o; down = 1; togo = Math.min(10, yl); } }
    else if (res === HALF) { /* clock ran out */ }
    if (hf === 3 && otPoss[0] >= 1 && otPoss[1] >= 1 && sc[0] !== sc[1]) break;
    if (hf === 3 && (res === SAF || ((res === TO || res === PUNT) && needKick))) break; // defensive / return score ends overtime
    if (tl <= 0) { if (halfOver()) break; }
  }
  ev({ t: 'note', txt: 'Final', fin: 1 });
  if (W) {
    W.score[gi * 2] = sc[0]; W.score[gi * 2 + 1] = sc[1]; W.drives[gi * 2] = dn[0]; W.drives[gi * 2 + 1] = dn[1]; W.firstTd[gi] = ftd; W.firstScore[gi] = fsc; W.ot[gi] = hf === 3 ? 1 : 0; W.leadCh[gi] = lch; W.q4trail[gi] = trailedQ4;
    W.tdDriveSlot[gi * 2] = tdSlot[0]; W.tdDriveSlot[gi * 2 + 1] = tdSlot[1]; W.kick[gi] = recv0; W.ftdTeam[gi * 2] = ftdT[0]; W.ftdTeam[gi * 2 + 1] = ftdT[1];
    W.rzTrips[gi * 2] = rzG[0]; W.rzTrips[gi * 2 + 1] = rzG[1]; W.rzTds[gi * 2] = rzTdG[0]; W.rzTds[gi * 2 + 1] = rzTdG[1]; W.i10[gi * 2] = i10G[0]; W.i10[gi * 2 + 1] = i10G[1];
    let c0 = 0, c1 = 0; for (let i = 0; i < TT[0].P; i++) c0 += W.G.td[gi * NP + i]; for (let i = 0; i < TT[1].P; i++) c1 += W.G.td[gi * NP + TT[0].P + i]; W.tds[gi * 2] = c0; W.tds[gi * 2 + 1] = c1;
    if (dlog) W.logs.push(dlog);
  }
  return { score: sc, recv0 };
}
const gameSeed = (seed, g) => ((Math.imul(seed >>> 0, 2654435761) ^ Math.imul(g + 1, 40503) ^ 0x5bd1e995) >>> 0);
function alloc(E, n, record) {
  const NP = E.T[0].P + E.T[1].P; const G = {}; for (const k of GSTATS) G[k] = new Int16Array(n * NP);
  return { n, NP, base: [0, E.T[0].P], P: [E.T[0].P, E.T[1].P], G, H: record ? new Uint32Array(NP * SLOTS * NB) : null, slotN: new Uint32Array(2 * SLOTS), slotR: new Uint32Array(2 * SLOTS * NR),
    score: new Int16Array(n * 2), half: new Int16Array(n * 2), drives: new Uint8Array(n * 2), tds: new Uint8Array(n * 2), firstTd: new Int16Array(n), firstScore: new Int8Array(n), ot: new Uint8Array(n), leadCh: new Uint8Array(n), q4trail: new Int8Array(n),
    tdDriveSlot: new Uint8Array(n * 2), kick: new Uint8Array(n), gRes: new Uint8Array(n * 2 * SLOTS).fill(255), ftdTeam: new Int16Array(n * 2).fill(-1), slotPlays: new Float64Array(2 * SLOTS), slotYds: new Float64Array(2 * SLOTS), tdAgg: new Uint32Array(NP * TDAGG), logs: [],
    slotStart: new Float64Array(2 * SLOTS), slotRz: new Uint32Array(2 * SLOTS), slotTdRush: new Uint32Array(2 * SLOTS), slotTdYo: new Float64Array(2 * SLOTS), startH: new Uint32Array(20), tdSrc: new Uint32Array(8), tdYo: new Uint32Array(12),
    sit: new Float64Array(2 * NS), rzTrips: new Uint8Array(n * 2), rzTds: new Uint8Array(n * 2), i10: new Uint8Array(n * 2), zT: new Uint32Array(NP * 4), zC: new Uint32Array(NP * 4), tZ: new Uint32Array(16), plTdYo: new Uint32Array(NP * 6) };
}
// stepwise runner: run(k) plays the next k games; W.done counts finished games (partial summaries read W with n = done)
export function pbpRunner(I, { n = 10000, seed = 1, record = true, E = null } = {}) {
  E = E || calibratePbp(I).E; cellTotals(E); const W = alloc(E, n, record); W.seed = seed; W.done = 0;
  return { E, W, run(k) { const end = Math.min(n, W.done + k); for (let g = W.done; g < end; g++) playGame(E, makeRng(gameSeed(seed, g)), g, W, null); W.done = end; return W.done >= n; } };
}
export function simulatePbp(I, { n = 10000, seed = 1, record = true, E = null } = {}) { const r = pbpRunner(I, { n, seed, record, E }); r.run(n); return finish(r.W, r.E); }
export function finish(W, E) { W.eng = { mode: 'pbp', version: E.V ? SIM_PBP_VERSION : 'sim-pbp-1', fT: E.T.map(t => Array.from(t.fT, v => +v.toFixed(3))), fC: E.T.map(t => Array.from(t.fC, v => +v.toFixed(3))) }; W.spp = null; return W; }
// replay one game (same seed + index as the run) with every play logged
export function replayGame(E, seed, g) { const log = []; playGame(E, makeRng(gameSeed(seed, g)), g, null, log); return log; }
// pilot: per-player target / carry shares, catch rate and yards per catch / carry -> the model's projections (team volume stays the sim's own)
export function calibratePbp(I, { pilots = 2, n = 800, seed = 7, tdPilots = 2 } = {}) {
  const E = makePbpEngine(I); const hist = [];
  for (let it = 0; it < pilots; it++) {
    cellTotals(E); const W = alloc(E, n, false); for (let g = 0; g < n; g++) playGame(E, makeRng(gameSeed(seed + it * 101, g)), g, W, null);
    for (let k = 0; k < 2; k++) { const t = E.T[k], ti = I.teams[k]; const sum = st => { let s = 0; for (let i = 0; i < t.P; i++) for (let g = 0; g < n; g++) s += W.G[st][g * W.NP + W.base[k] + i]; return s / n; };
      const tT = sum('tgt'), tC = sum('car'); const mT = ti.players.reduce((s, p) => s + p.tgt, 0), mC = ti.players.reduce((s, p) => s + p.car, 0);
      for (let i = 0; i < t.P; i++) { const p = t.pl[i]; let st = { tgt: 0, car: 0, rec: 0, recYd: 0, rushYd: 0 }; for (let g = 0; g < n; g++) { const ix = g * W.NP + W.base[k] + i; for (const s of Object.keys(st)) st[s] += W.G[s][ix]; } for (const s of Object.keys(st)) st[s] /= n;
        const f = (want, got, lo = 0.4, hi = 2.5) => (want > 0.004 && got > 0.004) ? clamp(want / got, lo, hi) : 1;
        if (p.pos !== 'QB') t.fT[i] *= f(mT > 0 ? p.tgt / mT : 0, tT > 0 ? st.tgt / tT : 0);
        if (p.pos !== 'QB') t.fC[i] *= f(mC > 0 ? p.car / mC : 0, tC > 0 ? st.car / tC : 0); else { const g2 = tC > 0 ? st.car / tC : 0, w2 = mC > 0 ? p.car / mC : 0; if (w2 > 0.004 && g2 > 0.004) { const a = clamp(w2 / g2, 0.4, 2.5); for (let c = 0; c < 8; c++) t.wC[i * 8 + c] *= a; } }
        if (p.tgt > 0.3 && st.tgt > 0.05) { const w = clamp(p.rec / p.tgt, 0.25, 0.93), gg = clamp(st.rec / st.tgt, 0.2, 0.95); t.cOff[i] = clamp(t.cOff[i] + 0.8 * (logit(w) - logit(gg)), -1.5, 1.5); }
        if (p.rec > 0.3 && p.recYd > 0 && st.rec > 0.05 && st.recYd > 0) t.yF[i] = clamp(t.yF[i] * Math.pow(f(p.recYd / p.rec, st.recYd / st.rec, 0.7, 1.4), 0.8), 0.5, 1.8);
        if (p.car > 0.5 && st.car > 0.05 && p.rushYd > 0 && st.rushYd > 0) t.cF[i] = clamp(t.cF[i] * Math.pow(f(p.rushYd / p.car, st.rushYd / st.car, 0.7, 1.4), 0.8), 0.5, 1.8);
      } }
    let pts = 0; for (let g = 0; g < n; g++) pts += W.score[g * 2] + W.score[g * 2 + 1]; hist.push({ pts: +(pts / n).toFixed(2) });
  }
  // 4.12.0 TD-share pilot (sim-pbp-2 only, when the inputs carry td-share-1 splits): each player's share of his team's simulated TDs
  // is steered toward the blended target split by scaling his red-zone usage cells (inside the 20), not his volume between the 20s
  // 4.13.0 TD-level anchor (usage-var-1): each team's simulated offensive TDs -> the model's pre-game TD budget (implied points x 0.7 / 6.9),
  // by a logit shift on its red-zone / goal-line TD chance. Walk-forward: the sims' scorer SPLIT was already calibrated; the miss was the team total
  const anc0 = anchorFor(I, 'pbp'), dl = dataLevelFor(I, 'pbp'); const useB = anc0 > 0 && I.teams.some(t => t.tdBudget > 0); const anc = useB ? anc0 : dl; const tgtOf = ti => useB ? ti.tdBudget : ti.tdData; const doLvl = E.V && anc > 0 && I.teams.some(t => tgtOf(t) > 0);
  if (E.V && (doLvl || I.teams.some(t => t.tdShare))) for (let it = 0; it < tdPilots + (doLvl ? 2 : 0); it++) {
    cellTotals(E); const W = alloc(E, n, false); for (let g = 0; g < n; g++) playGame(E, makeRng(gameSeed(seed + 500 + it * 101, g)), g, W, null);
    for (let k = 0; k < 2; k++) { const t = E.T[k], ti = I.teams[k];
      if (doLvl && tgtOf(ti) > 0) { let tt = 0; for (let g = 0; g < n; g++) for (let i = 0; i < t.P; i++) tt += W.G.td[g * W.NP + W.base[k] + i]; const m = (tt + 0.5) / n; t.lvl = clamp(t.lvl + 2.5 * anc * Math.log(tgtOf(ti) / Math.max(0.2, m)), -2.5, 2.5); }
      if (!ti.tdShare || it >= tdPilots) continue; const lt = ti.players.reduce((s, p) => s + (p.lam || 0), 0); if (!(lt > 0)) continue; const tw = temper(t.pl.map(p => p.lam || 0), dispFor(I, 'pbp').tau); // 4.13.0: tempered target split
      const got = new Float64Array(t.P); let tot = 0; for (let i = 0; i < t.P; i++) { for (let g = 0; g < n; g++) got[i] += W.G.td[g * W.NP + W.base[k] + i]; tot += got[i]; } if (tot < 20) continue;
      for (let i = 0; i < t.P; i++) { const want = tw[i], have = (got[i] + 0.5 * want) / (tot + 0.5); if (want < 0.002) continue;
        const a = clamp(Math.pow(want / have, 0.85), 0.5, 2); for (let c = 2; c < 8; c++) { t.wT[i * 8 + c] *= a; t.wC[i * 8 + c] *= a; } } }
    hist.push({ tdPilot: it + 1 });
  }
  return { E, pilots: hist };
}
// ---------- field-position / red-zone summary (pure)
export function pbpSummary(S, sum, I) {
  const n = S.n, NP = S.NP; const teams = [I.away, I.home];
  const team = [0, 1].map(k => { let rz = 0, rzTd = 0, i10 = 0, dr = 0; for (let g = 0; g < n; g++) { rz += S.rzTrips[g * 2 + k]; rzTd += S.rzTds[g * 2 + k]; i10 += S.i10[g * 2 + k]; dr += S.drives[g * 2 + k]; }
    let st = 0, sn = 0; for (let s = 0; s < SLOTS; s++) { st += S.slotStart[k * SLOTS + s]; sn += S.slotN[k * SLOTS + s]; }
    const src = Array.from(S.tdSrc.slice(k * 4, k * 4 + 4)); const srcN = src.reduce((a, b) => a + b, 0) || 1; const yo = Array.from(S.tdYo.slice(k * 6, k * 6 + 6)); const yoN = yo.reduce((a, b) => a + b, 0) || 1;
    const sh = Array.from(S.startH.slice(k * 10, k * 10 + 10)); const shN = sh.reduce((a, b) => a + b, 0) || 1;
    return { team: teams[k], rzTrips: rz / n, rzTdPct: rz ? rzTd / rz : null, i10Trips: i10 / n, drives: dr / n, avgStart: sn ? st / sn : null, startDist: sh.map(c => c / shN), tdSrc: src.map(c => c / srcN), tdSrcN: src.map(c => c / n), tdYo: yo.map(c => c / yoN) }; });
  const players = sum.players.map(p => { const j = p.j, k = p.k; const zT = Array.from(S.zT.slice(j * 4, j * 4 + 4)), zC = Array.from(S.zC.slice(j * 4, j * 4 + 4)); const tT = Array.from(S.tZ.slice(k * 8, k * 8 + 4)), tC = Array.from(S.tZ.slice(k * 8 + 4, k * 8 + 8));
    const sh = (a, b, zs) => { let x = 0, y = 0; for (const z of zs) { x += a[z]; y += b[z]; } return y > 0 ? x / y : null; };
    const yo = Array.from(S.plTdYo.slice(j * 6, j * 6 + 6)); const yoN = yo.reduce((a, b) => a + b, 0);
    return { j, k, name: p.name, pos: p.pos, team: p.team, carRz: sh(zC, tC, [1, 2, 3]), carI10: sh(zC, tC, [2, 3]), carI5: sh(zC, tC, [3]), tgtRz: sh(zT, tT, [1, 2, 3]), tgtI10: sh(zT, tT, [2, 3]),
      carI10PerG: (zC[2] + zC[3]) / n, tgtRzPerG: (zT[1] + zT[2] + zT[3]) / n, tdYo: yoN ? yo.map(c => c / yoN) : null, tdI5: yoN ? (yo[0] + yo[1]) / yoN : null, tdN: yoN / n }; });
  // red-zone pattern sentences, ranked by how concentrated the role is
  const pats = []; const P = (k, f) => players.filter(p => p.k === k && f(p) != null).sort((a, b) => f(b) - f(a));
  for (let k = 0; k < 2; k++) { const T = teams[k];
    const c10 = P(k, p => p.carI10)[0], c5 = P(k, p => p.carI5)[0], tr = P(k, p => p.tgtRz)[0], t10 = P(k, p => p.tgtI10)[0];
    if (c10 && c10.carI10 >= 0.2) pats.push({ k, w: c10.carI10, kind: 'car10', j: c10.j, text: `${c10.name} gets ${pctS(c10.carI10)} of ${T} carries inside the 10 (${c10.carI10PerG.toFixed(1)} a game).` });
    if (c5 && c5 !== c10 && c5.carI5 >= 0.2) pats.push({ k, w: c5.carI5, kind: 'car5', j: c5.j, text: `${c5.name} gets ${pctS(c5.carI5)} of ${T} carries inside the 5.` });
    else if (c5 && c5.carI5 >= 0.2) pats.push({ k, w: c5.carI5 * 0.9, kind: 'car5', j: c5.j, text: `Inside the 5 it is ${c5.name} on ${pctS(c5.carI5)} of ${T} carries.` });
    if (tr && tr.tgtRz >= 0.15) pats.push({ k, w: tr.tgtRz, kind: 'tgtRz', j: tr.j, text: `${tr.name} is ${poss2(T)} top red-zone target: ${pctS(tr.tgtRz)} of its targets inside the 20 (${tr.tgtRzPerG.toFixed(1)} a game).` });
    if (t10 && t10 !== tr && t10.tgtI10 >= 0.15) pats.push({ k, w: t10.tgtI10, kind: 'tgt10', j: t10.j, text: `Inside the 10, ${t10.name} draws ${pctS(t10.tgtI10)} of ${T} targets.` });
    const tm = team[k]; pats.push({ k, w: 0.3, kind: 'team', text: `${T} reaches the red zone ${tm.rzTrips.toFixed(1)} times a game and scores a TD on ${pctS(tm.rzTdPct)} of those trips; ${pctS(tm.tdSrc[0])} of its TDs are runs, ${pctS(tm.tdSrc[1])} passes.` });
    const gl = players.filter(p => p.k === k && p.tdN > 0.05 && p.tdI5 != null).sort((a, b) => b.tdN * b.tdI5 - a.tdN * a.tdI5)[0];
    if (gl && gl.tdI5 >= 0.3) pats.push({ k, w: gl.tdI5 * 0.8, kind: 'td5', j: gl.j, text: `${pctS(gl.tdI5)} of ${poss2(gl.name)} TDs come from inside the 5.` });
  }
  pats.sort((a, b) => b.w - a.w);
  const sitT = S.sit ? [0, 1].map(k => { const v = {}; SIT.forEach((key, i) => { v[key] = S.sit[k * SIT.length + i] / n; }); return v; }) : null;
  return { version: S.eng?.version || SIM_PBP_VERSION, v2: !!I.pbp?.x2, team, players, rzPatterns: pats, sit: sitT, drive: [0, 1].map(k => Array.from({ length: SLOTS }, (_, s) => { const hn = S.slotN[k * SLOTS + s]; const tdN = S.slotR[(k * SLOTS + s) * NR + TD];
    return hn ? { avgStart: S.slotStart[k * SLOTS + s] / hn, rz: S.slotRz[k * SLOTS + s] / hn, tdRush: tdN ? S.slotTdRush[k * SLOTS + s] / tdN : null, tdYo: tdN ? S.slotTdYo[k * SLOTS + s] / tdN : null } : null; }).filter(Boolean)) };
}
const pctS = x => x == null ? '—' : `${Math.round(x * 100)}%`; const poss2 = nm => /s$/i.test(nm) ? `${nm}'` : `${nm}'s`;
// "own 28" / "opp 35" / "50" from yards-to-goal
export const ylText = yl => yl == null ? '—' : yl > 50 ? `own ${Math.round(100 - yl)}` : yl < 50 ? `opp ${Math.round(yl)}` : '50';
export { NB as PBP_NB, DOFF as PBP_DOFF };
// ---------- entry points (sim.js stays free of this module so there is no import cycle)
export function buildPbpInputs(I, P, opts = {}) { const pbp = pbpMatchup(P, I.away, I.home, I.teams, opts); return pbp ? { ...I, mode: 'pbp', pbp } : null; }
export function runPbp(I, { n = 10000, seed = 1, pilots = 2, pilotN = 800 } = {}) {
  const t0 = Date.now(); const { E, pilots: ph } = calibratePbp(I, { pilots, n: pilotN, seed: seed + 9 }); const t1 = Date.now();
  const S = simulatePbp(I, { n, seed, E }); S.pilot = ph; S.ms = { pilot: t1 - t0, sim: Date.now() - t1 }; return S; }
export function summarizePbp(S, I) { const sum = summarize(S, I); sum.mode = 'pbp'; sum.pbp = pbpSummary(S, sum, I); sum.pbp.hist = I.pbp?.hist || null; return sum; }
// live partial read-out while the run is in progress (first W.done games): points, win %, top 4 anytime TD so far
export function pbpPartial(W, I) {
  const m = W.done; if (!m) return { done: 0 }; let a = 0, h = 0, wa = 0, wh = 0;
  for (let g = 0; g < m; g++) { const x = W.score[g * 2], y = W.score[g * 2 + 1]; a += x; h += y; if (x > y) wa++; else if (y > x) wh++; }
  const pl = []; for (let k = 0; k < 2; k++) for (let i = 0; i < W.P[k]; i++) { const j = W.base[k] + i; let c = 0; for (let g = 0; g < m; g++) if (W.G.td[g * W.NP + j] > 0) c++; const p = I.teams[k].players[i]; pl.push({ name: p.name, team: I.teams[k].team, pos: p.pos, p: c / m }); }
  pl.sort((x, y) => y.p - x.p);
  return { done: m, pts: [a / m, h / m], win: [wa / m, wh / m], top4: pl.slice(0, 4) };
}
