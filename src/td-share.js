// app 4.12.0 — td-share-1: who scores a team's touchdowns. A walk-forward "TD share" layer used by both simulators to pick
// the scorer of each simulated touchdown (the drive sim's scorer weights, the play-by-play sim's red-zone usage pilot).
// Inputs are nflverse play-by-play rows from weeks BEFORE the target week only (prior season at reduced weight):
//   per player, recency-weighted shares of his team's inside-5 / inside-10 / red-zone / all carries, inside-10 / red-zone / all
//   targets and offensive TDs (in games he played), shrunk toward his overall touch share when the sample is thin;
//   per defense, the share of offensive TDs it allowed to QBs (rushing), RBs, WRs and TEs (shrunk toward league).
// A team's TD is assigned to player i with probability  s_i / sum_j s_j,  s_i = exp(beta_pos) * sum_k w_k f_ik * def(opp,pos)^gamma * avail_i.
// The feature weights w, position offsets beta and defense exponent gamma are fitted (max likelihood of the actual scorer of each
// past TD, ridge-shrunk) on games before the target week only. Pure functions; runs in Node (fit) and in the browser (apply).
export const TD_SHARE_VERSION = 'td-share-1';
export const TD_FEATS = ['c5', 'c10', 'cRz', 'car', 't10', 'tRz', 'tgt', 'tds'];
export const TD_POS = ['QB', 'RB', 'WR', 'TE'];
export const TD_SHARE_DEFAULTS = { halfLife: 4, prior: 0.35, kGames: 1.5, kDef: 18, ridge: 1.5, minWeek: 3 };
const RUN = 0, PASS = 1, F_SACK = 1, F_SCR = 16, F_TD = 32;
const NF = TD_FEATS.length; const IS_RUSH = [1, 1, 1, 1, 0, 0, 0, 0];
const posOf = p => (p === 'FB' ? 'RB' : p === 'HB' ? 'RB' : p);
const r4 = x => Math.round(x * 1e4) / 1e4;
// per game, per offense: player tallies [c5,c10,cRz,car,t10,tRz,tgt,td, rushTd] and team totals
export function tallyGames(T) {
  const C = Object.fromEntries(T.cols.map((c, i) => [c, i])); const games = new Map();
  for (const a of T.rows) {
    const type = a[C.type]; if (type !== RUN && type !== PASS) continue; const fl = a[C.flags]; const yl = a[C.yl]; const pid = a[C.pid]; if (yl < 0) continue;
    const key = a[C.g] * 64 + a[C.off]; let G = games.get(key);
    if (!G) { G = { season: T.season, week: a[C.week], g: a[C.g], off: T.teams[a[C.off]], def: T.teams[a[C.def]], tot: new Float64Array(NF + 1), pl: new Map() }; games.set(key, G); }
    const rush = type === RUN || (fl & F_SCR); const tgt = type === PASS && !(fl & F_SACK) && !(fl & F_SCR) && pid >= 0;
    const v = new Float64Array(NF + 1);
    if (rush && pid >= 0) { v[3] = 1; if (yl <= 20) v[2] = 1; if (yl <= 10) v[1] = 1; if (yl <= 5) v[0] = 1; }
    else if (tgt) { v[6] = 1; if (yl <= 20) v[5] = 1; if (yl <= 10) v[4] = 1; }
    const tdp = (fl & F_TD) && a[C.tdPid] >= 0 ? a[C.tdPid] : -1;
    if (tdp >= 0 && (rush || tgt)) { G.tot[7] += 1; const id = T.pids[tdp]; const x = G.pl.get(id) || newPl(G, id, T, tdp); x.v[7] += 1; if (rush) x.v[8] += 1; }
    if (pid < 0 || (!rush && !tgt)) continue;
    for (let k = 0; k < 7; k++) G.tot[k] += v[k];
    const id = T.pids[pid]; const x = G.pl.get(id) || newPl(G, id, T, pid); for (let k = 0; k < 7; k++) x.v[k] += v[k];
  }
  return [...games.values()];
}
function newPl(G, id, T, ix) { const pe = T.people[ix] || {}; const x = { id, pos: posOf(pe.pos), name: pe.name, sleeper: pe.sleeper || null, v: new Float64Array(NF + 1) }; G.pl.set(id, x); return x; }
// league per-team-game averages of each counted item
function leagueAvg(games) { const s = new Float64Array(NF); for (const G of games) for (let k = 0; k < NF; k++) s[k] += G.tot[k]; return Array.from(s, x => x / Math.max(1, games.length)); }
// features at a cut: all tallies from games with (season < S) or (season == S and week < W); prior season weighted by o.prior
export function featuresAt(allGames, S, W, o = TD_SHARE_DEFAULTS) {
  const use = allGames.filter(G => (G.season === S && G.week < W) || G.season === S - 1);
  const lg = leagueAvg(use.filter(G => G.season === S).length >= 32 ? use.filter(G => G.season === S) : use);
  const wOf = G => G.season === S ? Math.pow(0.5, (W - 1 - G.week) / o.halfLife) : o.prior * Math.pow(0.5, (W - 1 + 19 - G.week) / (o.halfLife * 3));
  const acc = new Map();
  for (const G of use) { const w = wOf(G);
    for (const x of G.pl.values()) { let A = acc.get(x.id); if (!A) { A = { id: x.id, pos: x.pos, name: x.name, sleeper: x.sleeper, team: G.off, tw: -1, num: new Float64Array(NF + 1), den: new Float64Array(NF), g: 0, cur: 0 }; acc.set(x.id, A); }
      for (let k = 0; k < NF; k++) { A.num[k] += w * x.v[k]; A.den[k] += w * G.tot[k]; } A.num[NF] += w * x.v[8]; A.g += w; if (G.season === S) A.cur++;
      const ord = G.season * 100 + G.week; if (ord > A.tw) { A.tw = ord; A.team = G.off; } } }
  const out = {};
  for (const A of acc.values()) {
    const touch = (A.num[3] + A.num[6]) / Math.max(1e-9, A.den[3] + A.den[6]); const f = new Array(NF);
    for (let k = 0; k < NF; k++) { const a = o.kGames * lg[k]; const base = k < 4 ? A.num[3] / Math.max(1e-9, A.den[3]) : k < 7 ? A.num[6] / Math.max(1e-9, A.den[6]) : touch; f[k] = (A.num[k] + a * (A.den[k] > 0 ? base : touch)) / (A.den[k] + a); }
    const tdN = A.num[7]; const rf = tdN > 0 ? A.num[NF] / tdN : null;
    out[A.id] = { pos: A.pos, name: A.name, sleeper: A.sleeper, team: A.team, f, g: A.g, cur: A.cur, rushFrac: carryFrac(f, rf, tdN) };
  }
  return { players: out, def: defenseAt(use, S, o), lg };
}
// share of a player's TDs that are rushing: his own split once he has a few TDs, else his red-zone carry vs target mix
const carryFrac = (f, rf, n) => { const c = f[1] + f[2], t = f[4] + f[5]; const vol = c + t > 0 ? c / (c + t) : 0.5; const k = rf == null ? 0 : Math.min(1, n / 4); return Math.min(1, Math.max(0, k * rf + (1 - k) * vol)); };
// defense: share of offensive TDs allowed to each position (QB counts rushing TDs only), shrunk to league; factor = shrunk / league
function defenseAt(use, S, o) {
  const cnt = {}; const lg = { QB: 0, RB: 0, WR: 0, TE: 0 }; let lgN = 0;
  for (const G of use) { const w = G.season === S ? 1 : 0.25; const d = cnt[G.def] || (cnt[G.def] = { QB: 0, RB: 0, WR: 0, TE: 0, n: 0 });
    for (const x of G.pl.values()) { const p = x.pos; if (!(p in lg) || !x.v[7]) continue; d[p] += w * x.v[7]; d.n += w * x.v[7]; lg[p] += w * x.v[7]; lgN += w * x.v[7]; } }
  const L = Object.fromEntries(TD_POS.map(p => [p, lg[p] / Math.max(1e-9, lgN)])); const out = {};
  for (const [t, d] of Object.entries(cnt)) out[t] = Object.fromEntries(TD_POS.map(p => [p, r4(((d[p] + o.kDef * L[p]) / (d.n + o.kDef)) / Math.max(1e-9, L[p]))]));
  return out;
}
// score of one candidate (unnormalised); P = { w[NF], beta{pos}, gamma }
export function tdScore(P, f, pos, defF = 1) { let s = 0; for (let k = 0; k < NF; k++) s += P.w[k] * f[k]; return Math.exp(P.beta[pos] ?? 0) * Math.max(1e-6, s) * Math.pow(defF, P.gamma); }
// training events: every offensive rush/rec TD of a game at a cut, with the candidates = players who touched the ball in that game
export function trainingEvents(allGames, cuts, featAt) {
  const ev = [];
  for (const G of allGames) { if (!cuts(G)) continue; if (!G.tot[7]) continue; const F = featAt(G.season, G.week); if (!F) continue;
    const cand = []; const ids = []; for (const x of G.pl.values()) { if (!TD_POS.includes(x.pos)) continue; const fe = F.players[x.id]; const f = fe ? fe.f : new Array(NF).fill(0.01); cand.push({ f, pos: x.pos, d: F.def[G.def]?.[x.pos] ?? 1 }); ids.push(x); }
    for (let i = 0; i < ids.length; i++) for (let t = 0; t < ids[i].v[7]; t++) ev.push({ cand, y: i }); }
  return ev;
}
export function eventLL(P, ev) { let ll = 0; const cache = new Map();
  for (const e of ev) { let s = cache.get(e.cand); if (!s) { s = e.cand.map(c => tdScore(P, c.f, c.pos, c.d)); s.tot = s.reduce((a, b) => a + b, 0); cache.set(e.cand, s); } ll += Math.log(s[e.y] / s.tot); }
  return ll; }
const unpack = th => ({ w: th.slice(0, NF).map(Math.exp), beta: { RB: 0, QB: th[NF], WR: th[NF + 1], TE: th[NF + 2] }, gamma: th[NF + 3] });
// coordinate search with step halving; ridge pulls log-weights toward equal and offsets toward 0
export function fitTdShare(ev, o = TD_SHARE_DEFAULTS) {
  let th = new Array(NF + 4).fill(0); th[NF + 3] = 0.5;
  const obj = t => eventLL(unpack(t), ev) - o.ridge * (t.slice(0, NF).reduce((a, x) => a + x * x, 0) + t[NF] ** 2 + t[NF + 1] ** 2 + t[NF + 2] ** 2 + (t[NF + 3] - 0.5) ** 2);
  let best = obj(th); let step = 1;
  for (let it = 0; it < 40 && step > 0.02; it++) { let moved = false;
    for (let j = 0; j < th.length; j++) for (const sgn of [1, -1]) { const t = th.slice(); t[j] += sgn * step; const v = obj(t); if (v > best + 1e-6) { best = v; th = t; moved = true; break; } }
    if (!moved) step /= 2; }
  const P = unpack(th); return { w: P.w.map(r4), beta: Object.fromEntries(Object.entries(P.beta).map(([k, v]) => [k, r4(v)])), gamma: r4(P.gamma), ll: r4(eventLL(P, ev)), n: ev.length };
}
// build the weekly block shipped in archive/pbp/<s>/w<W>.json (td): fitted on games before W only
export function buildTdShare(tables, { season, before, opts = {} } = {}) {
  const o = { ...TD_SHARE_DEFAULTS, ...opts }; const all = tables.flatMap(tallyGames).filter(G => G.season >= season - 2 && (G.season < season || G.week < before));
  const cache = new Map(); const featAt = (S, W) => { const k = S * 100 + W; if (!cache.has(k)) cache.set(k, all.some(G => G.season === S - 1 || (G.season === S && G.week < W)) ? featuresAt(all, S, W, o) : null); return cache.get(k); };
  const ev = trainingEvents(all, G => G.week >= o.minWeek && (G.season === season || G.season === season - 1), featAt);
  const P = fitTdShare(ev, o); const F = featuresAt(all, season, before, o);
  const through = all.filter(G => G.season === season).reduce((m, G) => Math.max(m, G.week), 0);
  const players = {}; for (const [id, x] of Object.entries(F.players)) { if (!TD_POS.includes(x.pos) || x.g < 0.05) continue; players[id] = { p: x.pos, t: x.team, f: x.f.map(r4), r: r4(x.rushFrac), g: r4(x.g) }; }
  return { version: TD_SHARE_VERSION, season, before, through, opts: o, fit: P, def: F.def, players };
}
// apply: players [{ gsis, pos, avail (0..1), tgt, car }], td block, opponent -> shares (sum 1) and rush fraction per player
export function tdShareFor(td, players, opp) {
  if (!td?.fit) return null; const tgtT = players.reduce((s, p) => s + (p.tgt || 0), 0), carT = players.reduce((s, p) => s + (p.car || 0), 0);
  const raw = players.map(p => { const pos = posOf(p.pos); if (!TD_POS.includes(pos)) return { s: 0, r: 0 }; const x = p.gsis ? td.players[p.gsis] : null;
    let f = x?.f; let r = x?.r;
    if (!f) { const cs = carT > 0 ? (p.car || 0) / carT : 0, ts = tgtT > 0 ? (p.tgt || 0) / tgtT : 0; f = [cs, cs, cs, cs, ts, ts, ts, (cs + ts) / 2]; r = cs + ts > 0 ? cs / (cs + ts) : 0.5; }
    const d = td.def?.[opp]?.[pos] ?? 1; return { s: tdScore(td.fit, f, pos, d) * (p.avail ?? 1), r: r ?? 0.5, known: !!x }; });
  const tot = raw.reduce((a, b) => a + b.s, 0) || 1; return raw.map(x => ({ share: x.s / tot, rushFrac: x.r, known: x.known }));
}

// The simulators blend the model's own scorer split (its anytime lambdas) with td-share-1 geometrically and correct position bias:
//   share_i  ∝  m_i^(1-alpha) * t_i^alpha * exp(beta_pos)   (m = model lambda share, t = td-share-1 share, both among available players)
// alpha / beta were fitted by maximum likelihood of the actual scorer of every TD, 2025 weeks 3-18 + 2026 weeks 2-8 (the backtest
// re-fits them walk-forward, weeks before each test week only; scripts/sim/top4-backtest.mjs).
export const TD_BLEND = { alpha: 0.3, beta: { QB: 0, RB: 0, WR: 0, TE: 0.1 } };
export function fitBlend(teams, { min = 150 } = {}) {
  // teams: [{ c: [[pos, mShare, tShare, tds]] , tds }] from earlier weeks only
  const n = teams.reduce((a, t) => a + t.tds, 0); if (n < min) return { alpha: 0, beta: { QB: 0, RB: 0, WR: 0, TE: 0 }, n, fitted: false };
  const ll = (a, b) => { let s = 0; for (const t of teams) { if (!t.tds) continue; const v = t.c.map(x => Math.pow(Math.max(x[1], 1e-5), 1 - a) * Math.pow(Math.max(x[2], 1e-5), a) * Math.exp(b[x[0]] || 0)); const Z = v.reduce((p, q) => p + q, 0); t.c.forEach((x, i) => { if (x[3]) s += x[3] * Math.log(v[i] / Z); }); } return s - 4 * (b.QB ** 2 + b.WR ** 2 + b.TE ** 2); };
  let best = null; for (const a of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) for (const te of [-0.1, 0, 0.1, 0.2, 0.3]) for (const qb of [-0.2, 0, 0.2]) for (const wr of [-0.1, 0, 0.1]) { const b = { QB: qb, RB: 0, WR: wr, TE: te }; const v = ll(a, b); if (!best || v > best.v) best = { v, alpha: a, beta: b }; }
  return { alpha: best.alpha, beta: best.beta, n, fitted: true, llPerTd: r4(best.v / n) };
}
// 4.15.0 data-split position offsets (alpha 1 = td-share-1 alone): walk-forward fit of QB / WR / TE log-offsets (RB = 0) on the
// scorers of earlier weeks only, ridge-penalised. Real plays only; no model or market numbers enter (the model share is unused at alpha 1).
export function fitDataBeta(teams, { min = 150 } = {}) {
  const n = teams.reduce((a, t) => a + t.tds, 0); if (n < min) return { alpha: 1, beta: {}, n, fitted: false };
  const ll = b => { let s = 0; for (const t of teams) { if (!t.tds) continue; const v = t.c.map(x => Math.max(x[2], 1e-5) * Math.exp(b[x[0]] || 0)); const Z = v.reduce((p, q) => p + q, 0); t.c.forEach((x, i) => { if (x[3]) s += x[3] * Math.log(v[i] / Z); }); } return s - 4 * (b.QB ** 2 + b.WR ** 2 + b.TE ** 2); };
  let best = null; for (const te of [-0.1, 0, 0.1, 0.2, 0.3]) for (const qb of [-0.2, 0, 0.1, 0.2, 0.3, 0.4]) for (const wr of [-0.1, -0.05, 0, 0.05, 0.1]) { const b = { QB: qb, RB: 0, WR: wr, TE: te }; const v = ll(b); if (!best || v > best.v) best = { v, beta: b }; }
  return { alpha: 1, beta: best.beta, n, fitted: true, llPerTd: r4(best.v / n) };
}
// players: sim players [{ gsis, pos, lam, tgt, car, rushTd }] of ONE team (already filtered to available ones)
export function blendShares(players, td, opp, B = TD_BLEND) {
  const T = tdShareFor(td, players.map(p => ({ gsis: p.gsis, pos: p.pos, avail: 1, tgt: p.tgt, car: p.car })), opp); if (!T) return null;
  const lt = players.reduce((s, p) => s + (p.lam || 0), 0); if (!(lt > 0)) return null;
  const v = players.map((p, i) => { const pos = posOf(p.pos); if (!TD_POS.includes(pos)) return 0; return Math.pow(Math.max((p.lam || 0) / lt, 1e-5), 1 - B.alpha) * Math.pow(Math.max(T[i].share, 1e-5), B.alpha) * Math.exp(B.beta[pos] || 0); });
  const Z = v.reduce((a, b) => a + b, 0) || 1;
  return players.map((p, i) => ({ share: v[i] / Z, model: (p.lam || 0) / lt, td: T[i].share, rushFrac: T[i].known ? (1 - B.alpha) * (p.rushTd ?? T[i].rushFrac) + B.alpha * T[i].rushFrac : p.rushTd, known: T[i].known }));
}
