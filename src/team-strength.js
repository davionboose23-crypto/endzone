// 4.9.2 — opponent-adjusted team strength from this season's drives (pre-game only).
// Every rate is a ridge-penalised additive model on the log-odds (or raw) scale:
//   value(offense O vs defense D) = league base + offense effect(O) + defense effect(D)
// fitted jointly over all 2026 drives played BEFORE the week being simulated, so a team that faced strong defenses is
// credited for it (and vice versa). Recent games weigh more (half-life in weeks). Effects shrink toward 0 (= league) by
// the ridge penalty, i.e. by sample size. No play-by-play: "explosive" is a drive-level proxy (TD drives of <= 4 plays,
// skill-player yards per play).
export const TS_VERSION = 'ts-1';
export const MIX = ['TD', 'FG', 'Punt', 'TO', 'Downs']; // FG = made + missed field-goal tries; Half / Safety come from the league by game state
const MIXI = { TD: 0, FG: 1, MFG: 1, Punt: 2, TO: 3, Downs: 4 }; const REF = 2;
export const TS_DEFAULTS = { halfLife: 6, kMix: 20, kPass: 40, kScript: 400, kRz: 15, kGauss: 30, kPace: 4, kYpp: 150, kTwo: 25, iters: 30 };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sig = x => 1 / (1 + Math.exp(-x)); const logit = p => Math.log(p / (1 - p));
export const bucketOf = d => ((d[3] & 2) ? 1 : (d[9] >= 4 && d[2] >= 9) ? 2 : (d[9] >= 4 && d[2] <= -9) ? 3 : 0); // same buckets as the sim
export const scriptOf = d => d[1] === 2 ? (d[2] >= 8 ? 1 : d[2] <= -8 ? 2 : 0) : 0; // 0 neutral, 1 leading 2H by 8+, 2 trailing 2H by 8+

// generic additive fitter. rows: { x: Int32Array(one index per group, -1 = absent), y, n, w }; family 'logit' (y of n) or 'gauss'
function fitAdd(rows, groups, family, iters) {
  const P = groups.map(g => new Float64Array(g.size));
  const eta = r => { let s = r.off || 0; for (let g = 0; g < groups.length; g++) if (r.x[g] >= 0) s += P[g][r.x[g]]; return s; };
  // intercept start
  let sy = 0, sn = 0; for (const r of rows) { sy += r.w * r.y; sn += r.w * (family === 'logit' ? r.n : 1); }
  const m0 = sn > 0 ? sy / sn : 0; P[0][0] = family === 'logit' ? logit(clamp(m0, 0.005, 0.995)) : m0;
  for (let it = 0; it < iters; it++) for (let g = 0; g < groups.length; g++) {
    const G = new Float64Array(groups[g].size), H = new Float64Array(groups[g].size);
    for (const r of rows) { const i = r.x[g]; if (i < 0) continue; const e = eta(r);
      if (family === 'logit') { const p = sig(e); G[i] += r.w * (r.y - r.n * p); H[i] += r.w * r.n * p * (1 - p); } else { G[i] += r.w * (r.y - e); H[i] += r.w; } }
    const k = groups[g].k; for (let i = 0; i < G.length; i++) { const den = H[i] + k; if (den > 1e-9) P[g][i] += (G[i] - k * P[g][i]) / den; }
  }
  return P;
}
// multinomial drive-result model: eta_c = base[bucket][c] + off[team][c] + def[opp][c], Punt = reference
function fitMix(rows, nT, kO, kD, iters, P0 = null) { // P0: { O, D } prior means of the effects (4.15.0 prior-season prior; default 0 = league)
  const C = MIX.length; const B = new Float64Array(4 * C), O = new Float64Array(nT * C), Dd = new Float64Array(nT * C);
  const cnt = new Float64Array(4 * C); for (const r of rows) cnt[r.b * C + r.c] += r.w;
  for (let b = 0; b < 4; b++) { const ref = cnt[b * C + REF] + 0.5; for (let c = 0; c < C; c++) B[b * C + c] = c === REF ? 0 : Math.log((cnt[b * C + c] + 0.5) / ref); }
  const p = new Float64Array(C);
  const probs = r => { let s = 0; for (let c = 0; c < C; c++) { p[c] = Math.exp(B[r.b * C + c] + O[r.o * C + c] + (r.d >= 0 ? Dd[r.d * C + c] : 0)); s += p[c]; } for (let c = 0; c < C; c++) p[c] /= s; return p; };
  const step = (A, key, k, n, A0 = null) => { const G = new Float64Array(n * C), H = new Float64Array(n * C);
    for (const r of rows) { const i = key(r); if (i < 0) continue; probs(r); for (let c = 0; c < C; c++) { if (c === REF) continue; G[i * C + c] += r.w * ((r.c === c ? 1 : 0) - p[c]); H[i * C + c] += r.w * p[c] * (1 - p[c]); } }
    for (let j = 0; j < n * C; j++) { if (j % C === REF) continue; const den = H[j] + k; if (den > 1e-9) A[j] += (G[j] - k * (A[j] - (A0 ? A0[j] : 0))) / den; } };
  if (P0) { O.set(P0.O); Dd.set(P0.D); }
  for (let it = 0; it < iters; it++) { step(O, r => r.o, kO, nT, P0?.O); step(Dd, r => r.d, kD, nT, P0?.D); step(B, r => r.b, 0.5, 4); }
  return { B, O, D: Dd };
}
export function softmaxMix(fit, b, o, d, extra = null) { // probabilities over MIX for offense index o vs defense index d (-1 = league-average side)
  const C = MIX.length; const e = new Array(C); let s = 0;
  for (let c = 0; c < C; c++) { e[c] = Math.exp(fit.B[b * C + c] + (o >= 0 ? fit.O[o * C + c] : 0) + (d >= 0 ? fit.D[d * C + c] : 0) + (extra ? extra[c] || 0 : 0)); s += e[c]; }
  return e.map(v => v / s);
}

const CACHE = new WeakMap();
// D: weekly drive file ({ teams: { T: { games: [{ w, opp, d }] } } }). before: only games with w < before (default: all in the file).
export function teamStrength(D, opts = {}) {
  const { prior = null, ...rest } = opts; const o = { ...TS_DEFAULTS, ...rest }; const key = JSON.stringify(o) + (prior ? '|' + (prior.id || 'prior') : '');
  if (D && CACHE.has(D) && CACHE.get(D)[key]) return CACHE.get(D)[key];
  const teams = Object.keys(D?.teams || {}).sort(); const ti = Object.fromEntries(teams.map((t, i) => [t, i])); const nT = teams.length;
  let maxW = 0; for (const t of teams) for (const g of D.teams[t].games || []) if ((o.before == null || g.w < o.before) && g.w > maxW) maxW = g.w;
  const wOf = w => o.halfLife > 0 && Number.isFinite(o.halfLife) ? Math.pow(0.5, (maxW - w) / o.halfLife) : 1;
  const mix = [], pass = [], rz = [], rzTd = [], quick = [], ppd = [], ypp = [], pace = [], two = [];
  const raw = Object.fromEntries(teams.map(t => [t, { off: rawZero(), def: rawZero() }]));
  const half = [0, 0, 0, 0], saf = [0, 0, 0, 0], bAll = [0, 0, 0, 0]; let fgTry = 0, fgMade = 0;
  for (const t of teams) for (const g of D.teams[t].games || []) {
    if (o.before != null && g.w >= o.before) continue; const a = ti[t], b = ti[g.opp] ?? -1; const w = wOf(g.w);
    const R = raw[t].off, Q = raw[g.opp]?.def; R.games++; if (Q) Q.games++;
    pace.push({ x: Int32Array.of(0, a, b), y: g.d.length, w });
    for (const d of g.d) {
      const bk = bucketOf(d), res = d[5]; bAll[bk]++; if (res === 'Half') half[bk]++; if (res === 'Safety') saf[bk]++;
      if (res === 'FG' || res === 'MFG') { fgTry++; if (res === 'FG') fgMade++; }
      const yds = (d[8] || []).reduce((s, x) => s + (x[3] || 0) + (x[5] || 0), 0); const isTd = res === 'TD';
      for (const S of [R, Q]) { if (!S) continue; S.drives++; S.plays += d[4]; S.yds += yds; S.tgt += d[6]; S.car += d[7]; if (isTd) S.td++; if (res === 'FG') S.fg++; if (res === 'MFG') S.mfg++; if (res === 'Punt') S.punt++; if (res === 'TO') S.to++; if (res === 'Downs') S.downs++; if (d[3] & 4) { S.rz++; if (isTd) S.rzTd++; } if (isTd && d[4] <= 4) S.quick++; }
      const c = MIXI[res]; if (c != null) mix.push({ o: a, d: b, b: bk, c, w });
      if (d[6] + d[7] > 0) { const s = scriptOf(d); pass.push({ x: Int32Array.of(0, s ? s - 1 : -1, a, b, s ? a * 2 + (s - 1) : -1), y: d[6], n: d[6] + d[7], w }); }
      if (res !== 'Half' && res !== 'Safety') { rz.push({ x: Int32Array.of(0, a, b), y: d[3] & 4 ? 1 : 0, n: 1, w }); quick.push({ x: Int32Array.of(0, a, b), y: isTd && d[4] <= 4 ? 1 : 0, n: 1, w }); }
      if (d[3] & 4) rzTd.push({ x: Int32Array.of(0, a, b), y: isTd ? 1 : 0, n: 1, w });
      ppd.push({ x: Int32Array.of(0, a, b), y: d[4], w });
      if (d[4] > 0) ypp.push({ x: Int32Array.of(0, a, b), y: yds / d[4], w: w * d[4] });
      if (d[3] & 2) two.push({ x: Int32Array.of(0, a), y: isTd || res === 'FG' ? 1 : 0, n: 1, w });
    }
  }
  const T3 = (k, kd = k) => [{ size: 1, k: 0 }, { size: nT, k }, { size: nT, k: kd }];
  // 4.15.0 prior-season prior (o.priorF > 0 and a prior from last season's drives): the drive-result effects shrink toward last
  // season's effects x priorF (= regressed 1 - priorF toward the league) instead of toward 0; early in the season the ridge is
  // stronger (k x (1 + earlyK / weeks played)), so week 2 leans on last season and the current season takes over as games come in
  let P0 = null, kM = o.kMix; if (prior && o.priorF > 0) { const C = MIX.length; P0 = { O: new Float64Array(nT * C), D: new Float64Array(nT * C) };
    teams.forEach((t, i) => { const j = prior.idx?.[t]; if (j == null) return; for (let c = 0; c < C; c++) { P0.O[i * C + c] = o.priorF * prior.O[j * C + c]; P0.D[i * C + c] = o.priorF * prior.D[j * C + c]; } });
    kM = o.kMix * (1 + (o.earlyK || 0) / Math.max(1, maxW)); }
  const M = fitMix(mix, nT, kM, kM, o.iters, P0);
  const PS = fitAdd(pass, [{ size: 1, k: 0 }, { size: 2, k: 0 }, { size: nT, k: o.kPass }, { size: nT, k: o.kPass }, { size: nT * 2, k: o.kScript }], 'logit', o.iters);
  const RZ = fitAdd(rz, T3(o.kRz), 'logit', o.iters), RZT = fitAdd(rzTd, T3(o.kRz), 'logit', o.iters), QK = fitAdd(quick, T3(o.kRz * 2), 'logit', o.iters);
  const PP = fitAdd(ppd, T3(o.kGauss), 'gauss', o.iters), YP = fitAdd(ypp, T3(o.kYpp), 'gauss', o.iters), PC = fitAdd(pace, T3(o.kPace), 'gauss', o.iters);
  const TW = fitAdd(two, [{ size: 1, k: 0 }, { size: nT, k: o.kTwo }], 'logit', o.iters);
  const out = { version: TS_VERSION, opts: o, maxW, teams, idx: ti, nDrives: mix.length, mix: M,
    league: { bShare: bAll.map(v => v / Math.max(1, bAll[0] + bAll[1] + bAll[2] + bAll[3])), half: half.map((v, i) => bAll[i] ? v / bAll[i] : 0), safety: saf.map((v, i) => bAll[i] ? v / bAll[i] : 0), fgMake: fgTry ? fgMade / fgTry : 0.85,
      pass: PS[0][0], passScript: [0, PS[1][0], PS[1][1]], rz: RZ[0][0], rzTd: RZT[0][0], quick: QK[0][0], ppd: PP[0][0], ypp: YP[0][0], dpg: PC[0][0], two: TW[0][0] },
    eff: { pass: [PS[2], PS[3]], passScript: PS[4], rz: [RZ[1], RZ[2]], rzTd: [RZT[1], RZT[2]], quick: [QK[1], QK[2]], ppd: [PP[1], PP[2]], ypp: [YP[1], YP[2]], dpg: [PC[1], PC[2]], two: TW[1] }, raw };
  out.profiles = buildProfiles(out);
  if (D) { const c = CACHE.get(D) || {}; c[key] = out; CACHE.set(D, c); }
  return out;
}
function rawZero() { return { games: 0, drives: 0, plays: 0, yds: 0, tgt: 0, car: 0, td: 0, fg: 0, mfg: 0, punt: 0, to: 0, downs: 0, rz: 0, rzTd: 0, quick: 0 }; }

// matchup inputs for the sim: offense `team` vs defense `opp`
// compact prior for next season: last season's drive-result effects per team (fit on all of that season's drives)
export function seasonPrior(D, season = null) { const TS = teamStrength(D, { halfLife: 0 }); return { version: TS_VERSION, season, teams: TS.teams, idx: TS.idx, O: Array.from(TS.mix.O, v => +v.toFixed(4)), D: Array.from(TS.mix.D, v => +v.toFixed(4)), id: `prior-${season}` }; }
export function matchup(TS, team, opp) {
  const a = TS.idx[team] ?? -1, b = TS.idx[opp] ?? -1; const L = TS.league, E = TS.eff;
  const ef = (k, side, i) => i >= 0 ? E[k][side][i] : 0;
  const twoD = a >= 0 ? E.two[a] : 0; // two-minute scoring skill (offense only, heavily shrunk): shifts TD and FG log-odds in that bucket
  const mix = [0, 1, 2, 3].map(bk => { const m = softmaxMix(TS.mix, bk, a, b, bk === 1 ? [twoD, twoD, 0, 0, 0] : null); const rest = 1 - L.half[bk] - L.safety[bk];
    // RESULTS order: TD, FG, MFG, Punt, TO, Downs, Half, Safety
    return [m[0] * rest, m[1] * rest * L.fgMake, m[1] * rest * (1 - L.fgMake), m[2] * rest, m[3] * rest, m[4] * rest, L.half[bk], L.safety[bk]]; });
  const pf = [0, 1, 2].map(s => sig(L.pass + L.passScript[s] + ef('pass', 0, a) + ef('pass', 1, b) + (s && a >= 0 ? E.passScript[a * 2 + s - 1] : 0)));
  const ppd = Math.max(3, L.ppd + ef('ppd', 0, a) + ef('ppd', 1, b));
  const dpg = Math.max(7, L.dpg + ef('dpg', 0, a) + ef('dpg', 1, b));
  return { mix, pf, ppd, ppdF: ppd / L.ppd, dpg, ypp: L.ypp + ef('ypp', 0, a) + ef('ypp', 1, b) };
}

// ---------- team profiles (offense vs an average defense; defense vs an average offense)
const ORDN = n => { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
export { ORDN as ordinal };
function buildProfiles(TS) {
  const { teams, league: L, eff: E } = TS; const out = {};
  const rows = teams.map((t, i) => {
    const o = avgMix(TS, i, -1), d = avgMix(TS, -1, i); const dpgO = L.dpg + E.dpg[0][i], dpgD = L.dpg + E.dpg[1][i];
    return { t, i,
      off: { td: o[0], fg: o[1], punt: o[2], to: o[3], downs: o[4], tdPerGame: o[0] * dpgO, ptsPerDrive: o[0] * 6.95 + o[1] * L.fgMake * 3, pass: sig(L.pass + E.pass[0][i]), passLead: sig(L.pass + L.passScript[1] + E.pass[0][i] + E.passScript[i * 2]), passTrail: sig(L.pass + L.passScript[2] + E.pass[0][i] + E.passScript[i * 2 + 1]),
        rz: sig(L.rz + E.rz[0][i]), rzTd: sig(L.rzTd + E.rzTd[0][i]), quick: sig(L.quick + E.quick[0][i]), ppd: L.ppd + E.ppd[0][i], ypp: L.ypp + E.ypp[0][i], dpg: dpgO, two: sig(L.two + E.two[i]) },
      def: { td: d[0], fg: d[1], punt: d[2], to: d[3], downs: d[4], tdPerGame: d[0] * dpgD, ptsPerDrive: d[0] * 6.95 + d[1] * L.fgMake * 3, pass: sig(L.pass + E.pass[1][i]), rz: sig(L.rz + E.rz[1][i]), rzTd: sig(L.rzTd + E.rzTd[1][i]), quick: sig(L.quick + E.quick[1][i]), ppd: L.ppd + E.ppd[1][i], ypp: L.ypp + E.ypp[1][i], dpg: dpgD } };
  });
  const lg = avgMix(TS, -1, -1);
  const rank = (side, k, hiBest) => { const s = rows.slice().sort((x, y) => hiBest ? y[side][k] - x[side][k] : x[side][k] - y[side][k]); s.forEach((r, j) => { (r[side].rank || (r[side].rank = {}))[k] = j + 1; }); };
  for (const k of ['td', 'tdPerGame', 'ptsPerDrive', 'rz', 'rzTd', 'quick', 'ypp', 'ppd', 'pass', 'passTrail', 'passLead', 'two', 'fg', 'dpg']) rank('off', k, true);
  for (const k of ['punt', 'to']) rank('off', k, false); // fewest punts / turnovers = 1st
  for (const k of ['td', 'tdPerGame', 'ptsPerDrive', 'rz', 'rzTd', 'quick', 'ypp']) rank('def', k, false); // allows least = 1st
  for (const k of ['to', 'punt']) rank('def', k, true); // forces most = 1st
  for (const r of rows) { const R = TS.raw[r.t]; out[r.t] = { team: r.t, off: r.off, def: r.def, n: teams.length, raw: { off: rawRates(R.off), def: rawRates(R.def) }, league: { td: lg[0], to: lg[3], punt: lg[2], pass: sig(L.pass), rz: sig(L.rz), rzTd: sig(L.rzTd) } }; out[r.t].lines = profileLines(out[r.t]); }
  return out;
}
// per-drive result rates over all game states (league mix of normal / two-minute / garbage-time drives, incl. end-of-half)
function avgMix(TS, o, d) { const L = TS.league; const out = [0, 0, 0, 0, 0]; for (let b = 0; b < 4; b++) { const m = softmaxMix(TS.mix, b, o, d); const w = L.bShare[b] * (1 - L.half[b] - L.safety[b]); for (let c = 0; c < 5; c++) out[c] += w * m[c]; } return out; }
const rawRates = R => ({ games: R.games, drives: R.drives, td: R.drives ? R.td / R.drives : null, to: R.drives ? R.to / R.drives : null, punt: R.drives ? R.punt / R.drives : null, pass: R.tgt + R.car ? R.tgt / (R.tgt + R.car) : null, rzTd: R.rz ? R.rzTd / R.rz : null, tdPerGame: R.games ? R.td / R.games : null });
const P = x => `${Math.round(x * 100)}%`;
// plain sentences for the UI (rank 1 = best for that side)
export function profileLines(p) {
  const t = p.team, o = p.off, d = p.def, n = p.n, ro = o.rank, rd = d.rank, rw = p.raw;
  const rk = r => r === 1 ? 'best' : r <= Math.ceil(n / 2) ? `${ORDN(r)} best` : r === n ? 'worst' : `${ORDN(n - r + 1)} worst`;
  const vs = (adj, rawv) => rawv == null ? '' : Math.abs(adj - rawv) >= 0.015 ? ` (raw ${P(rawv)} before the schedule adjustment)` : '';
  return {
    off: [
      `${t} offense: ${ORDN(ro.tdPerGame)} of ${n} in TD drives per game (${o.tdPerGame.toFixed(1)}) after adjusting for the defenses it faced; ${P(o.td)} of drives end in a TD${vs(o.td, rw.off.td)}.`,
      `Turnovers on ${P(o.to)} of drives (${rk(ro.to)}), punts on ${P(o.punt)} (${rk(ro.punt)}); field-goal tries on ${P(o.fg)}.`,
      `Throws on ${P(o.pass)} of plays in neutral spots (${ORDN(ro.pass)} most pass-heavy); ${P(o.passTrail)} when trailing by 8+ after half-time, ${P(o.passLead)} when leading by 8+.`,
      `Reaches the red zone on ${P(o.rz)} of drives (${rk(ro.rz)}) and scores a TD on ${P(o.rzTd)} of trips (${rk(ro.rzTd)}); ${P(o.quick)} of drives are quick-strike TDs in 4 plays or fewer (${rk(ro.quick)}; drive-level proxy for explosive plays).`,
      `Pace: ${o.dpg.toFixed(1)} drives a game, ${o.ppd.toFixed(1)} plays a drive; two-minute drives score ${P(o.two)} of the time (${rk(ro.two)}).`],
    def: [
      `${t} defense allows a TD on ${P(d.td)} of drives — ${rk(rd.td)} of ${n} after adjusting for the offenses it faced${vs(d.td, rw.def.td)}.`,
      `Forces turnovers on ${P(d.to)} of drives (${rk(rd.to)}) and punts on ${P(d.punt)} (${rk(rd.punt)}).`,
      `Red zone: lets offenses in on ${P(d.rz)} of drives (${rk(rd.rz)}) and gives up a TD on ${P(d.rzTd)} of trips (${rk(rd.rzTd)}); quick-strike TDs allowed on ${P(d.quick)} (${rk(rd.quick)}).`,
      `Opponents throw on ${P(d.pass)} of plays against it (league ${P(p.league.pass)}).`] };
}
