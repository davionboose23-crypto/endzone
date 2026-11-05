// app 4.10.0 (X2 block for sim-pbp-2 since 4.11.0) — play-level parameters for the play-by-play simulator, fitted from nflverse play-by-play.
// League tables (yards pools, kicking, clock, fourth-down habits, penalties) use the prior season plus the current season
// BEFORE the target week; team effects (offense + defense, opponent-adjusted by fitting both at once, ridge-shrunk toward
// league, recency-weighted) use only current-season games before the target week. Nothing from the target week or later is read.
import { fitPressure } from './pressure.js';
import { PBP_VERSION, zoneOf, distB, scriptOf, passCell, ylB10, togoB4, ucell, uzOf, NQ } from './pbp-common.js';
const PT = { run: 0, pass: 1, punt: 2, fg: 3, kickoff: 4, xp: 5, two: 6, kneel: 7, spike: 8, noplay: 9 };
const F = { sack: 1, int: 2, fumLost: 4, cmp: 8, scramble: 16, td: 32, defTd: 64, pen: 128, penDef: 256, pen1st: 512, gtg: 1024, tb: 2048, fgGood: 4096, oob: 8192, safety: 16384, good: 32768, blocked: 65536, toAfter: 131072 };
export const PBP_DEFAULTS = { halfLife: 6, prior: 0.3, k: { pass: 60, offRz: 120, sack: 60, scr: 80, int: 150, cmp: 60, expP: 80, expR: 80, ydsR: 150, ydsC: 150, rzTd: 60, pace: 400, season: 40 }, kUse: 6,
  // app 4.11.0 (sim-pbp-2) shrinkage, documented defaults (not tuned on outcomes): home = ridge on the 2 home/away levels;
  // qbMult = QB effects shrink qbMult x harder than team effects; go / fgT / sneak = team logit offsets (prior weight in plays);
  // pen = team penalty rates shrink toward league with this many snaps of prior weight
  k2: { home: 200, qbMult: 1.5, go: 12, fgT: 25, sneak: 15, pen: 400 } };
const r3 = x => Math.round(x * 1000) / 1000; const r1 = x => Math.round(x * 10) / 10;
const sig = x => 1 / (1 + Math.exp(-x)); const logit = p => Math.log(p / (1 - p));
function rowsOf(T) { const c = T.cols; return T.rows.map(a => { const o = {}; for (let i = 0; i < c.length; i++) o[c[i]] = a[i]; return o; }); }
export function quantiles(arr, n = NQ) { if (!arr.length) return [0]; const s = Float64Array.from(arr).sort(); const out = []; for (let i = 0; i < n; i++) { const p = (i + 0.5) / n; out.push(s[Math.min(s.length - 1, Math.floor(p * s.length))]); } return out; }
// generic ridge additive model (logit or gauss) by cyclic Newton on each group; idx[g][i] = level or -1
function fitRidge(n, y, w, off, idx, groups, family, iters = 10) {
  const eta = Float64Array.from(off); const B = groups.map(g => new Float64Array(g.size));
  for (let it = 0; it < iters; it++) for (let gi = 0; gi < groups.length; gi++) {
    const { size, k } = groups[gi]; const G = new Float64Array(size), H = new Float64Array(size); const ix = idx[gi]; const b = B[gi];
    for (let i = 0; i < n; i++) { const j = ix[i]; if (j < 0) continue; if (family === 'logit') { const p = sig(eta[i]); G[j] += w[i] * (y[i] - p); H[j] += w[i] * p * (1 - p); } else { G[j] += w[i] * (y[i] - eta[i]); H[j] += w[i]; } }
    const d = new Float64Array(size); for (let j = 0; j < size; j++) { d[j] = (G[j] - k * b[j]) / (H[j] + k + 1e-9); b[j] += d[j]; }
    for (let i = 0; i < n; i++) { const j = ix[i]; if (j >= 0) eta[i] += d[j]; }
  }
  return { B, eta };
}
// fit = league base (all rows given) then team stage (season-current rows) on top of the base as offset
function twoStage(lgRows, tmRows, sel, base, team, family, kTeam, nTeams, kSeason) {
  const prep = (rows, defs) => { const keep = []; const ys = []; for (const r of rows) { const y = sel(r); if (y == null) continue; keep.push(r); ys.push(y); }
    return { keep, y: Float64Array.from(ys), idx: defs.map(d => Int32Array.from(keep, r => d.f(r))) }; };
  const L = prep(lgRows, base); const nL = L.keep.length;
  const bg = [{ size: 1, k: 0 }, ...base.map(d => ({ size: d.size, k: d.k ?? 1 }))];
  const bfit = fitRidge(nL, L.y, Float64Array.from(L.keep, r => r._wl), new Float64Array(nL), [new Int32Array(nL), ...L.idx], bg, family, family === 'logit' ? 12 : 4);
  const baseEta = r => { let e = bfit.B[0][0]; base.forEach((d, i) => { const j = d.f(r); if (j >= 0) e += bfit.B[i + 1][j]; }); return e; };
  const tdefs = [{ size: 1, k: kSeason, f: () => 0 }, ...team.map(d => ({ ...d, size: d.size ?? nTeams, k: d.k ?? kTeam[d.name] ?? kTeam.def }))];
  const Tm = prep(tmRows, tdefs); const nT = Tm.keep.length;
  const tfit = fitRidge(nT, Tm.y, Float64Array.from(Tm.keep, r => r._wt), Float64Array.from(Tm.keep, baseEta), Tm.idx, tdefs, family, family === 'logit' ? 10 : 4);
  const out = { icept: r3(bfit.B[0][0] + tfit.B[0][0]), n: nL, nTeam: nT };
  base.forEach((d, i) => { out[d.name] = Array.from(bfit.B[i + 1], r3); });
  team.forEach((d, i) => { out[d.name] = Array.from(tfit.B[i + 1], r3); });
  return out;
}
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
export function fitPbp(tables, { season, before, opts = {} } = {}) {
  const o = { ...PBP_DEFAULTS, ...opts, k: { ...PBP_DEFAULTS.k, ...(opts.k || {}) }, k2: { ...PBP_DEFAULTS.k2, ...(opts.k2 || {}) } };
  const cur = tables.find(t => t.season === season); if (!cur) throw new Error(`no pbp table for ${season}`);
  // research priorW: {year: weight} multi-year priors (off unless set). Default remains S-1 only.
  const prior = o.seasonOnly ? [] : o.priorW
    ? tables.filter(t => t.season < season && (o.priorW[t.season] || 0) > 0)
    : tables.filter(t => t.season < season && t.season >= season - 1); // 4.18.0 seasonOnly: this season's plays only
  const curRows = rowsOf(cur).filter(r => r.week < before); // NO leakage: target week and later never read
  if (!curRows.length && !prior.length) throw new Error('no plays before target week');
  const maxW = curRows.reduce((m, r) => Math.max(m, r.week), 0);
  const isQb = (T, r) => r.type === PT.run && r.pid >= 0 && T.people[r.pid]?.pos === 'QB' ? 1 : 0;
  for (const r of curRows) { r._wl = 1; r._wt = Math.pow(0.5, (maxW - r.week) / o.halfLife); r._cur = 1; r._qbr = isQb(cur, r); }
  const priorRows = prior.flatMap(T => rowsOf(T).map(r => { r._wl = o.priorW ? (o.priorW[T.season] || 0) : 1; r._wt = 0; r._cur = 0; r._season = T.season; r._qbr = isQb(T, r); return r; }));
  const lg = priorRows.concat(curRows); const teams = cur.teams; const NT = teams.length;
  const scr = r => r.down >= 1 && r.yl > 0 && (r.type === PT.run || r.type === PT.pass);
  const S = r => scriptOf(r.qtr, r.hs, r.sd); const Z = r => zoneOf(r.yl);
  const isDb = r => r.type === PT.pass; const sack = r => (r.flags & F.sack) > 0; const scramble = r => (r.flags & F.scramble) > 0;
  const aimed = r => isDb(r) && !sack(r) && !scramble(r);
  const offT = { name: 'off', f: r => r.off }, defT = { name: 'def', f: r => r.def };
  const kT = { ...o.k, def: 60 };
  const M = {};
  M.pass = twoStage(lg, curRows, r => scr(r) ? (isDb(r) ? 1 : 0) : null, [{ name: 'cell', size: 96, f: r => passCell(r.down, r.togo, r.yl) }, { name: 'script', size: 4, f: S }],
    [{ ...offT, name: 'off' }, { ...defT, name: 'def' }, { name: 'offRz', f: r => (Z(r) >= 3 ? r.off : -1) }], 'logit', { ...kT, off: o.k.pass, def: o.k.pass, offRz: o.k.offRz }, NT, o.k.season);
  M.sack = twoStage(lg, curRows, r => scr(r) && isDb(r) ? (sack(r) ? 1 : 0) : null, [{ name: 'dd', size: 16, f: r => (Math.min(4, r.down) - 1) * 4 + distB(r.togo) }, { name: 'zone', size: 6, f: Z }],
    [offT, defT], 'logit', { off: o.k.sack, def: o.k.sack }, NT, o.k.season);
  M.scr = twoStage(lg, curRows, r => scr(r) && isDb(r) && !sack(r) ? (scramble(r) ? 1 : 0) : null, [{ name: 'dist', size: 4, f: r => distB(r.togo) }, { name: 'zone', size: 6, f: Z }],
    [offT, defT], 'logit', { off: o.k.scr, def: o.k.scr * 2 }, NT, o.k.season);
  M.int = twoStage(lg, curRows, r => scr(r) && aimed(r) ? ((r.flags & F.int) ? 1 : 0) : null, [{ name: 'dist', size: 4, f: r => distB(r.togo) }, { name: 'zone', size: 6, f: Z }, { name: 'script', size: 4, f: S }],
    [offT, defT], 'logit', { off: o.k.int, def: o.k.int }, NT, o.k.season);
  M.cmp = twoStage(lg, curRows, r => scr(r) && aimed(r) && !(r.flags & F.int) ? ((r.flags & F.cmp) ? 1 : 0) : null, [{ name: 'dist', size: 4, f: r => distB(r.togo) }, { name: 'zone', size: 6, f: Z }],
    [offT, defT], 'logit', { off: o.k.cmp, def: o.k.cmp }, NT, o.k.season);
  M.expP = twoStage(lg, curRows, r => scr(r) && aimed(r) && (r.flags & F.cmp) && Z(r) <= 2 ? (r.yds >= 20 ? 1 : 0) : null, [{ name: 'zone', size: 3, f: Z }],
    [offT, defT], 'logit', { off: o.k.expP, def: o.k.expP }, NT, o.k.season);
  M.expR = twoStage(lg, curRows, r => scr(r) && r.type === PT.run && Z(r) <= 2 ? (r.yds >= 10 ? 1 : 0) : null, [{ name: 'zone', size: 3, f: Z }],
    [offT, defT], 'logit', { off: o.k.expR, def: o.k.expR }, NT, o.k.season);
  // 4.10.0: team efficiency on ordinary plays (yards on non-explosive runs < 10 / completions < 20, zones 0-2; gaussian, shrunk)
  M.ydsR = twoStage(lg, curRows, r => scr(r) && r.type === PT.run && Z(r) <= 2 && r.yds < 10 ? Math.max(-5, r.yds) : null, [{ name: 'zone', size: 3, f: Z }],
    [offT, defT], 'gauss', { off: o.k.ydsR, def: o.k.ydsR }, NT, o.k.season);
  M.ydsC = twoStage(lg, curRows, r => scr(r) && aimed(r) && (r.flags & F.cmp) && Z(r) <= 2 && r.yds < 20 ? Math.max(-5, r.yds) : null, [{ name: 'zone', size: 3, f: Z }],
    [offT, defT], 'gauss', { off: o.k.ydsC, def: o.k.ydsC }, NT, o.k.season);
  // red-zone touchdown on a run / completion / scramble from zones 3-5 (cell = (zone-3)*3 + kind)
  const rzKind = r => r.type === PT.run ? 0 : scramble(r) ? 2 : (r.flags & F.cmp) && !sack(r) ? 1 : -1;
  M.rzTd = twoStage(lg, curRows, r => scr(r) && Z(r) >= 3 && rzKind(r) >= 0 && !(r.flags & (F.fumLost | F.int)) ? ((r.flags & F.td) ? 1 : 0) : null, [{ name: 'cell', size: 9, f: r => (Z(r) - 3) * 3 + rzKind(r) }],
    [offT, defT], 'logit', { off: o.k.rzTd, def: o.k.rzTd }, NT, o.k.season);
  // pace: seconds from a running-clock snap to the next snap in neutral script (offense tempo + defense)
  const runClock = r => scr(r) && !(r.flags & (F.oob | F.td | F.defTd | F.int | F.fumLost | F.pen | F.toAfter)) && (r.type === PT.run || (r.flags & (F.cmp | F.sack)));
  M.pace = twoStage(lg, curRows, r => runClock(r) && S(r) === 0 && r.gap >= 8 && r.gap <= 50 ? r.gap : null, [], [offT, defT], 'gauss', { off: o.k.pace, def: o.k.pace * 2 }, NT, o.k.pace);
  // ---- league pools ----
  const P = { runN: [], runX: [], cmpN: [], cmpX: [], rzNon: [], scrO: [], sackY: [] };
  const acc = { runN: [[], [], []], runX: [[], [], []], cmpN: [[], [], []], cmpX: [[], [], []], rzNon: Array.from({ length: 9 }, () => []), scrO: [], sackY: [] };
  const fum = { run: [0, 0], cmp: [0, 0], sack: [0, 0], scr: [0, 0] };
  for (const r of lg) {
    if (!scr(r)) continue; const z = Z(r); const lost = (r.flags & F.fumLost) > 0;
    if (r.type === PT.run) { fum.run[0]++; if (lost) fum.run[1]++; }
    else if (sack(r)) { fum.sack[0]++; if (lost) fum.sack[1]++; }
    else if (scramble(r)) { fum.scr[0]++; if (lost) fum.scr[1]++; }
    else if (r.flags & F.cmp) { fum.cmp[0]++; if (lost) fum.cmp[1]++; }
    if (lost || (r.flags & (F.int | F.pen | F.defTd))) continue;
    if (sack(r)) { acc.sackY.push(r.yds); continue; }
    const kind = rzKind(r); if (kind < 0) continue;
    if (z >= 3) { if (!(r.flags & F.td)) acc.rzNon[(z - 3) * 3 + kind].push(Math.min(r.yds, r.yl - 1)); continue; }
    if (kind === 0) (r.yds >= 10 ? acc.runX : acc.runN)[z].push(r.yds);
    else if (kind === 1) (r.yds >= 20 ? acc.cmpX : acc.cmpN)[z].push(r.yds);
    else acc.scrO.push(r.yds);
  }
  for (const k of ['runN', 'runX', 'cmpN', 'cmpX', 'rzNon']) P[k] = acc[k].map(a => quantiles(a));
  P.scrO = quantiles(acc.scrO); P.sackY = quantiles(acc.sackY);
  P.fum = Object.fromEntries(Object.entries(fum).map(([k, [n, x]]) => [k, r3((x + 1) / (n + 100) * 1) ]));
  // clock: mean seconds snap-to-snap by outcome category x script; out-of-bounds rates
  const gaps = Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => [])); const oob = { run: [[0, 0], [0, 0], [0, 0], [0, 0]], cmp: [[0, 0], [0, 0], [0, 0], [0, 0]] };
  for (const r of lg) {
    if (!scr(r) || (r.flags & (F.td | F.defTd | F.int | F.fumLost | F.pen | F.toAfter)) || r.gap < 0 || r.gap > 60) continue;
    const s = S(r); const ob = (r.flags & F.oob) > 0; const kind = r.type === PT.run ? 'run' : (r.flags & F.cmp) ? 'cmp' : null;
    if (kind) { oob[kind][s][0]++; if (ob) oob[kind][s][1]++; }
    const cat = ob ? 2 : (isDb(r) && !(r.flags & (F.cmp | F.sack)) && !scramble(r)) ? 1 : 0; gaps[cat][s].push(r.gap);
  }
  P.gap = gaps.map(a => a.map(x => r1(mean(x)))); P.oob = { run: oob.run.map(([n, x]) => r3(x / Math.max(1, n))), cmp: oob.cmp.map(([n, x]) => r3(x / Math.max(1, n))) };
  // kicks
  const fg = lg.filter(r => r.type === PT.fg && r.yl > 0); let a = 2.5, b = -0.1;
  for (let it = 0; it < 25; it++) { let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0; for (const r of fg) { const x = r.yl + 18 - 40; const p = sig(a + b * x); const y = (r.flags & F.fgGood) ? 1 : 0; g0 += y - p; g1 += (y - p) * x; const w = p * (1 - p); h00 += w; h01 += w * x; h11 += w * x * x; }
    const det = h00 * h11 - h01 * h01; a += (h11 * g0 - h01 * g1) / det; b += (h00 * g1 - h01 * g0) / det; }
  P.fg = { a: r3(a), b: r3(b), n: fg.length };
  const rate = (rows, f) => { const n = rows.length; return r3(n ? rows.filter(f).length / n : 0); };
  P.xp = rate(lg.filter(r => r.type === PT.xp), r => r.flags & F.good); P.two = rate(lg.filter(r => r.type === PT.two), r => r.flags & F.good);
  const ko = lg.filter(r => r.type === PT.kickoff); P.koTd = rate(ko, r => r.flags & F.td); P.koStart = quantiles(ko.filter(r => r.next > 0 && !(r.flags & F.td)).map(r => r.next));
  const punts = lg.filter(r => r.type === PT.punt && r.yl > 0); P.punt = Array.from({ length: 10 }, (_, b) => { const rs = punts.filter(r => ylB10(r.yl) === b); return { td: r3((rs.filter(r => r.flags & F.defTd).length + 0.2) / (rs.length + 20)), y: quantiles(rs.filter(r => r.next > 0 && !(r.flags & F.defTd)).map(r => r.next), 51) }; });
  const toPool = rows => ({ td: r3((rows.filter(r => r.flags & F.defTd).length) / Math.max(1, rows.length)), d: quantiles(rows.filter(r => r.next > 0 && !(r.flags & F.defTd)).map(r => r.next - (100 - r.yl)), 51) });
  P.intRet = toPool(lg.filter(r => scr(r) && (r.flags & F.int))); P.fumRet = toPool(lg.filter(r => scr(r) && (r.flags & F.fumLost)));
  // fourth down habits (neutral / protecting scripts): go / FG / punt by field position x distance
  const fd = lg.filter(r => r.down === 4 && r.yl > 0 && (scr(r) || r.type === PT.punt || r.type === PT.fg) && S(r) <= 1);
  const marg = Array.from({ length: 10 }, () => [0, 0, 0]); const cell = Array.from({ length: 40 }, () => [0, 0, 0]);
  const ch = r => r.type === PT.fg ? 1 : r.type === PT.punt ? 2 : 0;
  for (const r of fd) { marg[ylB10(r.yl)][ch(r)]++; cell[ylB10(r.yl) * 4 + togoB4(r.togo)][ch(r)]++; }
  P.fourth = cell.map((c, i) => { const m = marg[Math.floor(i / 4)]; const mn = m[0] + m[1] + m[2] || 1; const n = c[0] + c[1] + c[2]; return c.map((x, j) => r3((x + 3 * m[j] / mn) / (n + 3))); });
  // penalties that wipe out the snap (no_play) per scrimmage snap
  const snaps = lg.filter(r => r.down >= 1 && r.yl > 0 && (scr(r) || r.type === PT.noplay)); const np = snaps.filter(r => r.type === PT.noplay && (r.flags & F.pen) && r.penYds > 0);
  P.pen = { off: r3(np.filter(r => !(r.flags & F.penDef)).length / snaps.length), def: r3(np.filter(r => r.flags & F.penDef).length / snaps.length),
    offY: quantiles(np.filter(r => !(r.flags & F.penDef)).map(r => r.penYds), 21), defY: quantiles(np.filter(r => r.flags & F.penDef).map(r => r.penYds), 21),
    def1st: r3(np.filter(r => (r.flags & F.penDef) && (r.flags & F.pen1st)).length / Math.max(1, np.filter(r => r.flags & F.penDef).length)) };
  // throwaways / passes with no intended receiver (share of aimed, non-intercepted passes)
  // goal line: inside the 5 the TD chance per play depends strongly on the exact spot (1-2 vs 3-5); league logit offsets vs the zone rate, per kind (run, catch, scramble)
  { const lgt = p => Math.log(p / (1 - p)); const rs = lg.filter(r => scr(r) && Z(r) === 5 && rzKind(r) >= 0 && !(r.flags & (F.fumLost | F.int)));
    P.gl = [0, 1, 2].map(k => { const a = rs.filter(r => rzKind(r) === k); const rt = b => (b.filter(r => r.flags & F.td).length + 1) / (b.length + 2); const z = rt(a);
      return [r3(lgt(rt(a.filter(r => r.yl <= 2))) - lgt(z)), r3(lgt(rt(a.filter(r => r.yl > 2))) - lgt(z))]; }); }
  { const ai = lg.filter(r => scr(r) && aimed(r) && !(r.flags & F.int)); P.noTgt = r3(ai.filter(r => r.pid < 0).length / Math.max(1, ai.length)); }
  // ---- app 4.11.0 (sim-pbp-2) additions; stored under X2 so sim-pbp-1 (M, P) is untouched and older param files still load ----
  // 1) the same play models refit with two more effects on top of offense + defense:
  //    home = a coefficient for the home offense and one for the away offense (home-field edge; league-wide, lightly shrunk)
  //    qb   = the passer on the play (current-season QBs, shrunk harder than teams) so a backup plays like himself, not like the team
  const qbIds = []; const qbIx = new Map(); for (const r of curRows) if (scr(r) && r.qb >= 0 && !qbIx.has(r.qb)) { qbIx.set(r.qb, qbIds.length); qbIds.push(r.qb); }
  const homeT = { name: 'home', size: 2, k: o.k2.home, f: r => (r.home ? 1 : 0) };
  const qbT = { name: 'qb', size: Math.max(1, qbIds.length), f: r => (r.qb >= 0 ? (qbIx.get(r.qb) ?? -1) : -1) };
  const T2 = q => (q ? [offT, defT, homeT, qbT] : [offT, defT, homeT]);
  const kq = (m, def) => ({ off: o.k[m], def: def ?? o.k[m], qb: o.k[m] * o.k2.qbMult });
  const M2 = {};
  M2.pass = twoStage(lg, curRows, r => scr(r) ? (isDb(r) ? 1 : 0) : null, [{ name: 'cell', size: 96, f: r => passCell(r.down, r.togo, r.yl) }, { name: 'script', size: 4, f: S }],
    [offT, defT, homeT, { name: 'offRz', f: r => (Z(r) >= 3 ? r.off : -1) }], 'logit', { ...kT, off: o.k.pass, def: o.k.pass, offRz: o.k.offRz }, NT, o.k.season);
  M2.sack = twoStage(lg, curRows, r => scr(r) && isDb(r) ? (sack(r) ? 1 : 0) : null, [{ name: 'dd', size: 16, f: r => (Math.min(4, r.down) - 1) * 4 + distB(r.togo) }, { name: 'zone', size: 6, f: Z }], T2(true), 'logit', kq('sack'), NT, o.k.season);
  M2.scr = twoStage(lg, curRows, r => scr(r) && isDb(r) && !sack(r) ? (scramble(r) ? 1 : 0) : null, [{ name: 'dist', size: 4, f: r => distB(r.togo) }, { name: 'zone', size: 6, f: Z }], T2(true), 'logit', kq('scr', o.k.scr * 2), NT, o.k.season);
  M2.int = twoStage(lg, curRows, r => scr(r) && aimed(r) ? ((r.flags & F.int) ? 1 : 0) : null, [{ name: 'dist', size: 4, f: r => distB(r.togo) }, { name: 'zone', size: 6, f: Z }, { name: 'script', size: 4, f: S }], T2(true), 'logit', kq('int'), NT, o.k.season);
  M2.cmp = twoStage(lg, curRows, r => scr(r) && aimed(r) && !(r.flags & F.int) ? ((r.flags & F.cmp) ? 1 : 0) : null, [{ name: 'dist', size: 4, f: r => distB(r.togo) }, { name: 'zone', size: 6, f: Z }], T2(true), 'logit', kq('cmp'), NT, o.k.season);
  M2.expP = twoStage(lg, curRows, r => scr(r) && aimed(r) && (r.flags & F.cmp) && Z(r) <= 2 ? (r.yds >= 20 ? 1 : 0) : null, [{ name: 'zone', size: 3, f: Z }], T2(true), 'logit', kq('expP'), NT, o.k.season);
  M2.expR = twoStage(lg, curRows, r => scr(r) && r.type === PT.run && Z(r) <= 2 ? (r.yds >= 10 ? 1 : 0) : null, [{ name: 'zone', size: 3, f: Z }], T2(false), 'logit', kq('expR'), NT, o.k.season);
  M2.ydsR = twoStage(lg, curRows, r => scr(r) && r.type === PT.run && Z(r) <= 2 && r.yds < 10 ? Math.max(-5, r.yds) : null, [{ name: 'zone', size: 3, f: Z }], T2(false), 'gauss', kq('ydsR'), NT, o.k.season);
  M2.ydsC = twoStage(lg, curRows, r => scr(r) && aimed(r) && (r.flags & F.cmp) && Z(r) <= 2 && r.yds < 20 ? Math.max(-5, r.yds) : null, [{ name: 'zone', size: 3, f: Z }], T2(true), 'gauss', kq('ydsC'), NT, o.k.season);
  M2.rzTd = twoStage(lg, curRows, r => scr(r) && Z(r) >= 3 && rzKind(r) >= 0 && !(r.flags & (F.fumLost | F.int)) ? ((r.flags & F.td) ? 1 : 0) : null, [{ name: 'cell', size: 9, f: r => (Z(r) - 3) * 3 + rzKind(r) }], T2(false), 'logit', kq('rzTd'), NT, o.k.season);
  // 2) team habits as ridge-shrunk logit offsets on the league tables (current season only, recency-weighted)
  const lgt = p => { const q = Math.max(1e-3, Math.min(1 - 1e-3, p)); return Math.log(q / (1 - q)); };
  const tOff = (rows, y, off, team, k) => { const b = new Float64Array(NT);
    for (let it = 0; it < 12; it++) { const G = new Float64Array(NT), H = new Float64Array(NT);
      for (const r of rows) { const t = team(r); const p = sig(off(r) + b[t]); const w = r._wt; G[t] += w * (y(r) - p); H[t] += w * p * (1 - p); }
      for (let t = 0; t < NT; t++) b[t] += (G[t] - k * b[t]) / (H[t] + k); }
    return Array.from(b, r3); };
  const fdCur = curRows.filter(r => r.down === 4 && r.yl > 0 && (scr(r) || r.type === PT.punt || r.type === PT.fg) && S(r) <= 1);
  const go = tOff(fdCur, r => (scr(r) ? 1 : 0), r => lgt(P.fourth[ylB10(r.yl) * 4 + togoB4(r.togo)][0]), r => r.off, o.k2.go);
  const fgT = tOff(curRows.filter(r => r.type === PT.fg && r.yl > 0), r => ((r.flags & F.fgGood) ? 1 : 0), r => P.fg.a + P.fg.b * (r.yl + 18 - 40), r => r.off, o.k2.fgT);
  // 3) short yardage: QB sneaks (share of 3rd/4th-and-1 or goal-to-go-1 runs that are QB keepers), sneak yards, other runs on <= 2 to go
  const sy = r => scr(r) && r.type === PT.run && r.togo <= 1 && !(r.flags & F.scramble);
  const syLg = lg.filter(sy); const sneakRate = (syLg.filter(r => r._qbr).length + 1) / (syLg.length + 2);
  const sneakT = tOff(curRows.filter(sy), r => r._qbr, () => lgt(sneakRate), r => r.off, o.k2.sneak);
  const okRun = r => !(r.flags & (F.fumLost | F.pen | F.defTd));
  const sneakY = quantiles(syLg.filter(r => r._qbr && okRun(r)).map(r => r.yds), 51);
  const runSY = [0, 1, 2].map(z => quantiles(lg.filter(r => scr(r) && r.type === PT.run && !r._qbr && r.togo <= 2 && Z(r) === z && okRun(r)).map(r => r.yds)));
  const sneakConv = r3(syLg.filter(r => r._qbr && okRun(r) && (r.yds >= r.togo || (r.flags & F.td))).length / Math.max(1, syLg.filter(r => r._qbr && okRun(r)).length));
  // 4) team penalty rates (pre-snap / wiped-out snaps): offense fouls by offense, defense fouls by defense, as multipliers on league
  const snapsC = curRows.filter(r => r.down >= 1 && r.yl > 0 && (scr(r) || r.type === PT.noplay));
  const penM = (isDefFoul, team) => { const n = new Float64Array(NT), x = new Float64Array(NT); const base = isDefFoul ? P.pen.def : P.pen.off;
    for (const r of snapsC) { const t = team(r); n[t] += r._wt; if (r.type === PT.noplay && (r.flags & F.pen) && r.penYds > 0 && (!!(r.flags & F.penDef) === isDefFoul)) x[t] += r._wt; }
    return Array.from(n, (nn, t) => r3(base > 0 ? ((x[t] + o.k2.pen * base) / (nn + o.k2.pen)) / base : 1)); };
  const X2 = { v: 2, M: M2, qbs: qbIds.map(i => cur.pids[i]), go, fgT, sneak: { rate: r3(sneakRate), t: sneakT, y: sneakY, conv: sneakConv }, runSY,
    pen: { off: penM(false, r => r.off), def: penM(true, r => r.def) } };
  // 5) app 4.19.0 defense vs position: share of rushing / receiving TDs each defense allowed to RB / WR / TE / QB (this season, before the
  //    target week, recency-weighted) over the league share, shrunk toward 1 with k2.dvp TDs of prior weight (a ratio, so offense volume cancels)
  { const DP = ['RB', 'WR', 'TE', 'QB']; const posOf = r => { const q = cur.people[r.pid]?.pos; return q === 'FB' ? 0 : DP.indexOf(q); };
    const x = Array.from({ length: NT }, () => new Float64Array(4)); const lgS = new Float64Array(4);
    for (const r of curRows) { if (!scr(r) || !(r.flags & F.td) || (r.flags & F.defTd) || r.pid < 0) continue; if (!(r.type === PT.run || (r.flags & F.cmp) || scramble(r))) continue;
      const j = posOf(r); if (j < 0) continue; x[r.def][j] += r._wt; lgS[j] += r._wt; }
    const lt = lgS.reduce((a, b) => a + b, 0) || 1; const sh = Array.from(lgS, v => (v + 1) / (lt + 4)); const k = o.k2.dvp ?? 12;
    X2.dvp = { pos: DP, k, m: x.map(row => { const n = row.reduce((a, b) => a + b, 0); return Array.from(row, (v, j) => r3(((v + k * sh[j]) / (n + k)) / sh[j])); }) }; }
  // 6) app 4.19.0 late-down offense / defense: completion and run-yard effects on 3rd / 4th down only (conversion skill beyond the all-down effects)
  M2.cmpLate = twoStage(lg, curRows, r => scr(r) && r.down >= 3 && aimed(r) && !(r.flags & F.int) ? ((r.flags & F.cmp) ? 1 : 0) : null, [{ name: 'dist', size: 4, f: r => distB(r.togo) }], [offT, defT], 'logit', { off: (o.k2.late ?? 150), def: (o.k2.late ?? 150) }, NT, o.k.season);
  // 7) app 4.20.0 lead-QB red-zone rushing: each offense's share of designed runs inside the 10 (sneaks included, scrambles not) by a QB, over the
  //    league share, shrunk with k2.qbRz runs of prior weight (this season, before the target week, recency-weighted)
  { const inside = r => scr(r) && r.type === PT.run && r.yl <= 10 && !scramble(r); const n = new Float64Array(NT), x = new Float64Array(NT); let ln = 0, lx = 0;
    for (const r of curRows) if (inside(r)) { n[r.off] += r._wt; ln += r._wt; if (r._qbr) { x[r.off] += r._wt; lx += r._wt; } }
    const sh = (lx + 1) / (ln + 10); const k = o.k2.qbRz ?? 15; X2.qbRz = Array.from(n, (nn, t) => r3(((x[t] + k * sh) / (nn + k)) / sh)); }
  // 9) t85u research (all off in the sim unless SIM_PBP_TUNE knobs set): defense red-zone pass tilt, defense red-zone TD rate by zone x run/pass,
  //    and each player's 2026 inside-5 carries / targets (goal-line personnel), recency-weighted, before the target week only
  { const lgt2 = p => Math.log(Math.max(1e-3, Math.min(1 - 1e-3, p)) / (1 - Math.max(1e-3, Math.min(1 - 1e-3, p))));
    const rzR = curRows.filter(r => scr(r) && Z(r) >= 3); let ln = 0, lp = 0; const n = new Float64Array(NT), x = new Float64Array(NT), no = new Float64Array(NT), xo = new Float64Array(NT);
    for (const r of rzR) { const w = r._wt, pp = isDb(r) ? 1 : 0; ln += w; lp += w * pp; n[r.def] += w; x[r.def] += w * pp; no[r.off] += w; xo[r.off] += w * pp; }
    const lr = (lp + 1) / (ln + 2), kP = o.k2.rzp ?? 40;
    X2.rzPass = { d: Array.from(n, (nn, t) => r3(lgt2((x[t] + kP * lr) / (nn + kP)) - lgt2(lr))), o: Array.from(no, (nn, t) => r3(lgt2((xo[t] + kP * lr) / (nn + kP)) - lgt2(lr))) };
    const zN = Array.from({ length: NT }, () => new Float64Array(6)), zX = Array.from({ length: NT }, () => new Float64Array(6)), lN = new Float64Array(6), lX = new Float64Array(6);
    for (const r of rzR) { const kd = rzKind(r); if (kd < 0 || (r.flags & (F.fumLost | F.int))) continue; const j = (Z(r) - 3) * 2 + (kd === 0 ? 0 : 1); const y = (r.flags & F.td) ? 1 : 0;
      zN[r.def][j] += r._wt; zX[r.def][j] += r._wt * y; lN[j] += r._wt; lX[j] += r._wt * y; }
    const kz = o.k2.rzd ?? 25; const lrz = Array.from(lN, (v, j) => (lX[j] + 1) / (v + 3));
    X2.rzDef = zN.map((row, t) => Array.from(row, (v, j) => r3(lgt2((zX[t][j] + kz * lrz[j]) / (v + kz)) - lgt2(lrz[j]))));
    const i5 = {}, i5T = {}; for (const r of curRows) { if (!scr(r) || r.yl > 5 || r.pid < 0 || sack(r)) continue; const isC = r.type === PT.run || scramble(r); const isT = aimed(r); if (!isC && !isT) continue;
      const gk = cur.pids[r.pid]; const tm = teams[r.off]; if (!gk || !tm) continue; const e = i5[gk] || (i5[gk] = { t: tm, c: 0, g: 0 }); const tt = i5T[tm] || (i5T[tm] = { c: 0, g: 0 });
      if (isC) { e.c += r._wt; tt.c += r._wt; } else { e.g += r._wt; tt.g += r._wt; } }
    X2.i5 = { p: i5, team: i5T }; }
  // 8) app 4.20.0 pass-rush pressure (PFR advanced passing via nflverse, game-level, weeks before the target week only)
  if (o.pressure) X2.prs = fitPressure(o.pressure.filter(r => r.season === season), teams, { before });
  // ---- player usage by field zone x down (targets, designed carries) ----
  const use = fitUsage(tables.filter(t => t.season === season || prior.includes(t)), season, before, maxW, o);
  // t86u research: defense red-zone trip TD rate (trips the defense faced, TD vs not, recency-weighted, shrunk k2.trip trips) and each player's
  //    2026 TDs per inside-10 touch (carries + targets) with position rates, for the sim knobs SIM_PBP_TUNE.trip / i10td (off by default)
  { const n = new Float64Array(NT), x = new Float64Array(NT); let ln = 0, lx = 0; let cu = null;
    const close = () => { if (cu && cu.rz) { n[cu.def] += cu.w; ln += cu.w; if (cu.td) { x[cu.def] += cu.w; lx += cu.w; } } cu = null; };
    for (const r of curRows) { if (!scr(r)) { if (r.type === PT.punt || r.type === PT.fg || r.type === PT.kickoff) close(); continue; }
      const key = `${r.g}|${r.off}`; if (!cu || cu.key !== key) { close(); cu = { key, def: r.def, w: r._wt, rz: false, td: false }; }
      if (r.yl <= 20 && r.down >= 1) cu.rz = true; if (r.flags & F.td) { cu.td = true; close(); } }
    close(); const lr = (lx + 1) / (ln + 2), k = o.k2.trip ?? 15; const lgt3 = p => Math.log(p / (1 - p));
    X2.trip = Array.from(n, (nn, t) => r3(lgt3((x[t] + k * lr) / (nn + k)) - lgt3(lr)));
    const pl = {}, pr = {}; for (const r of curRows) { if (!scr(r) || r.yl > 10 || r.pid < 0 || sack(r)) continue; if (!(r.type === PT.run || scramble(r) || aimed(r))) continue;
      const gk = cur.pids[r.pid]; const ps = cur.people[r.pid]?.pos; if (!gk || !ps) continue; const td = (r.flags & F.td) && !(r.flags & F.defTd) && (r.type === PT.run || scramble(r) || (r.flags & F.cmp)) ? 1 : 0;
      const e = pl[gk] || (pl[gk] = { n: 0, td: 0, pos: ps }); e.n += r._wt; e.td += r._wt * td; const q = pr[ps] || (pr[ps] = { n: 0, td: 0 }); q.n += r._wt; q.td += r._wt * td; }
    X2.i10td = { p: pl, pos: Object.fromEntries(Object.entries(pr).map(([k2, v]) => [k2, (v.td + 1) / (v.n + 5)])) }; }
  // t87u research: per-player explosive rate (completions 20+ / runs 10+ outside the red zone, as in M.expP / M.expR) and per-offense pass tilt by
  //    game script (logit vs the league script rate), shrunk, for SIM_PBP_TUNE.expl / scr (off by default)
  { const lgt4 = p => Math.log(p / (1 - p)); const ex = {}, lg = [[0, 0], [0, 0]];
    for (const r of curRows) { if (!scr(r) || Z(r) > 2 || r.pid < 0) continue; let kd = -1, y = 0;
      if (r.type === PT.run && !scramble(r)) { kd = 1; y = r.yds >= 10 ? 1 : 0; } else if (aimed(r) && (r.flags & F.cmp)) { kd = 0; y = r.yds >= 20 ? 1 : 0; } if (kd < 0) continue;
      const gk = cur.pids[r.pid]; if (!gk) continue; const e = ex[gk] || (ex[gk] = [[0, 0], [0, 0]]); e[kd][0] += r._wt; e[kd][1] += r._wt * y; lg[kd][0] += r._wt; lg[kd][1] += r._wt * y; }
    const lr = lg.map(([n, x]) => (x + 1) / (n + 10)), ke = o.k2.expl ?? 15;
    X2.expl = { p: Object.fromEntries(Object.entries(ex).map(([g, e]) => [g, e.map(([n, x], kd) => r3(lgt4((x + ke * lr[kd]) / (n + ke)) - lgt4(lr[kd])))])) };
    const n = Array.from({ length: NT }, () => new Float64Array(4)), x = Array.from({ length: NT }, () => new Float64Array(4)), ln = new Float64Array(4), lx = new Float64Array(4);
    for (const r of curRows) { if (!scr(r)) continue; const sc = S(r), y = isDb(r) ? 1 : 0; n[r.off][sc] += r._wt; x[r.off][sc] += r._wt * y; ln[sc] += r._wt; lx[sc] += r._wt * y; }
    const ks = o.k2.scr ?? 40; const lp = Array.from(ln, (v, j) => (lx[j] + 1) / (v + 2)); const tot = Array.from(n, (row, t) => { let a = 0, b = 0; for (let j = 0; j < 4; j++) { a += row[j]; b += x[t][j]; } return [a, b]; });
    // tilt in each script beyond the team's all-script pass tilt (so it does not double count M.pass off)
    X2.scrTilt = n.map((row, t) => { const all = lgt4((tot[t][1] + ks * 0.58) / (tot[t][0] + ks)) - lgt4(0.58); return Array.from(row, (v, j) => r3(lgt4((x[t][j] + ks * lp[j]) / (v + ks)) - lgt4(lp[j]) - all)); }); }
  // ---- per-team 2026 red-zone history (display) ----
  // possessions = runs of scrimmage snaps by one offense, cut by a change of offense or a kick; trip = possession with a snap inside the 20
  const hist = {}; for (const t of teams) hist[t] = { g: 0, rzTrips: 0, rzTd: 0, i10: 0, tdRush: 0, tdPass: 0 };
  { const seen = new Set(); let cur = null; const close = () => { if (cur && cur.rz) { const h = hist[teams[cur.off]]; h.rzTrips++; if (cur.td) h.rzTd++; if (cur.i10) h.i10++; } cur = null; };
    for (const r of curRows) { if (!scr(r)) { if (r.type === PT.punt || r.type === PT.fg || r.type === PT.kickoff) close(); continue; }
      const key = `${r.g}|${r.off}`; if (!seen.has(key)) { seen.add(key); hist[teams[r.off]].g++; }
      if (!cur || cur.key !== key) { close(); cur = { key, off: r.off, rz: false, i10: false, td: false }; }
      if (r.yl <= 20 && r.down >= 1) cur.rz = true; if (r.yl <= 10 && r.down >= 1) cur.i10 = true;
      if (r.flags & F.td) { cur.td = true; const h = hist[teams[r.off]]; if (r.type === PT.run) h.tdRush++; else h.tdPass++; close(); } }
    close(); }
  for (const h of Object.values(hist)) { const g = Math.max(1, h.g); h.rzPerG = r3(h.rzTrips / g); h.rzTdPct = h.rzTrips ? r3(h.rzTd / h.rzTrips) : null; h.i10PerG = r3(h.i10 / g); }
  return { kind: 'pbp-params', version: PBP_VERSION, season, week: before, through: maxW, prior: prior.map(t => t.season), opts: o, teams, hist,
    nPlays: { league: lg.filter(scr).length, current: curRows.filter(scr).length }, M, P, X2, use };
}
function fitUsage(tables, season, before, maxW, o) {
  const people = {}; const acc = {}; const pos = {}; const team = {};
  for (const T of tables) {
    Object.entries(T.people).forEach(([i, p]) => { const id = T.pids[i]; if (!people[id] || T.season === season) people[id] = p; });
    const rows = rowsOf(T); const isCur = T.season === season;
    // per game-team cell totals and per player cell counts
    const gt = new Map(); const pg = new Map();
    for (const r of rows) {
      if (isCur && r.week >= before) continue; if (r.down < 1 || r.yl <= 0) continue;
      const kind = r.type === PT.run ? 'c' : r.type === PT.pass && !(r.flags & (F.sack | F.scramble)) ? 't' : null; if (!kind) continue;
      const w = isCur ? Math.pow(0.5, (maxW - r.week) / o.halfLife) : (o.priorW?.[T.season] ?? o.prior); const c = ucell(r.yl, r.down); const key = `${r.g}|${r.off}`;
      let g = gt.get(key); if (!g) { g = { w, t: new Float64Array(8), c: new Float64Array(8), team: T.teams[r.off], week: r.week, players: new Set() }; gt.set(key, g); }
      g[kind][c]++;
      if (r.pid >= 0) { const id = T.pids[r.pid]; g.players.add(id); const pk = `${key}|${id}`; let p = pg.get(pk); if (!p) { p = { t: new Float64Array(8), c: new Float64Array(8) }; pg.set(pk, p); } p[kind][c]++; }
    }
    for (const [key, g] of gt) for (const id of g.players) {
      const p = pg.get(`${key}|${id}`); let a = acc[id]; if (!a) a = acc[id] = { xt: new Float64Array(8), nt: new Float64Array(8), xc: new Float64Array(8), nc: new Float64Array(8), h: new Float64Array(16), lastW: -1 };
      for (let c = 0; c < 8; c++) { a.xt[c] += g.w * p.t[c]; a.nt[c] += g.w * g.t[c]; a.xc[c] += g.w * p.c[c]; a.nc[c] += g.w * g.c[c]; }
      if (isCur) { for (let c = 0; c < 8; c++) { const z = c >> 1; a.h[z] += p.c[c]; a.h[4 + z] += g.c[c]; a.h[8 + z] += p.t[c]; a.h[12 + z] += g.t[c]; } if (g.week > a.lastW) { a.lastW = g.week; team[id] = g.team; } }
    }
  }
  // position multipliers
  for (const [id, a] of Object.entries(acc)) { const ps = people[id]?.pos; if (!ps) continue; const q = pos[ps] ||= { xt: new Float64Array(8), nt: new Float64Array(8), xc: new Float64Array(8), nc: new Float64Array(8) }; for (let c = 0; c < 8; c++) { q.xt[c] += a.xt[c]; q.nt[c] += a.nt[c]; q.xc[c] += a.xc[c]; q.nc[c] += a.nc[c]; } }
  const mult = (x, n) => { const X = x.reduce((s, v) => s + v, 0), N = n.reduce((s, v) => s + v, 0); const s = X / Math.max(1e-9, N); return Array.from(x, (v, c) => s > 0 && n[c] > 0 ? (v / n[c]) / s : 1); };
  const Mpos = Object.fromEntries(Object.entries(pos).map(([p, q]) => [p, { t: mult(q.xt, q.nt).map(r3), c: mult(q.xc, q.nc).map(r3) }]));
  const k = o.kUse; const players = {};
  for (const [id, a] of Object.entries(acc)) {
    const pp = people[id]; if (!pp) continue; const Xt = a.xt.reduce((s, v) => s + v, 0), Xc = a.xc.reduce((s, v) => s + v, 0); if (Xt + Xc < 2) continue;
    const st = Xt / Math.max(1e-9, a.nt.reduce((s, v) => s + v, 0)), sc = Xc / Math.max(1e-9, a.nc.reduce((s, v) => s + v, 0)); const Mp = Mpos[pp.pos] || { t: Array(8).fill(1), c: Array(8).fill(1) };
    // shrink each cell toward the position pattern with k EXPECTED events of prior weight (so rare-usage players stay near M)
    const sm = (x, n, s, M) => Array.from(x, (v, c) => s > 0 ? r3((v + k * M[c]) / (s * n[c] + k)) : 1);
    players[id] = { n: pp.name, p: pp.pos, t: team[id] || pp.team, s: pp.sleeper, mt: sm(a.xt, a.nt, st, Mp.t), mc: sm(a.xc, a.nc, sc, Mp.c), h: Array.from(a.h) };
  }
  return { pos: Mpos, players };
}
