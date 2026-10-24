// Usage-model data + fit (Node). Loads nflverse pbp / FTN / snap counts / weekly rosters / schedule,
// aggregates player-game usage, builds strictly pre-game features, fits the cloglog ridge GLM walk-forward.
// Mirrors research/clean.py (td-deep-dive) so walk-forward numbers reproduce.
import { streamCsv } from '../../server/live-feeds.js';
import { USAGE_FEATURES, LINE_FEATURES, cll } from '../../src/usage-model.js';
const NFLV = 'https://github.com/nflverse/nflverse-data/releases/download';
const D = 0.8, PW = 0.3, SH = ['c', 'c5', 'c10', 't', 't10', 'ezt', 'rzay'], RT = ['qbdr', 'qbdr5', 'sneak', 'tds'];
const num = v => (v === '' || v == null || v === 'NA' ? NaN : Number(v));
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
const opt = { timeoutMs: 300000, retries: 2 };

export async function loadSeason(s, log = () => {}) {
  const rw = await streamCsv(`${NFLV}/weekly_rosters/roster_weekly_${s}.csv`, o => (o.game_type === 'REG' ? { season: s, week: +o.week, team: o.team, pos: o.position, status: o.status, gsis: o.gsis_id || null, sleeper: o.sleeper_id ? String(parseInt(o.sleeper_id, 10)) : null, pfr: o.pfr_id || null } : null),
    { ...opt, columns: ['week', 'team', 'position', 'status', 'gsis_id', 'sleeper_id', 'pfr_id', 'game_type'] });
  log(`rw ${s} ${rw.length}`);
  const posOf = new Map(); for (const r of rw) if (r.gsis) posOf.set(r.gsis, r.pos);
  const sneaks = new Set();
  try { await streamCsv(`${NFLV}/ftn_charting/ftn_charting_${s}.csv`, o => { if (o.is_qb_sneak === 'TRUE' || o.is_qb_sneak === 'True' || o.is_qb_sneak === '1' || o.is_qb_sneak === 'true') sneaks.add(`${o.nflverse_game_id}|${num(o.nflverse_play_id)}`); return null; }, { ...opt, columns: ['nflverse_game_id', 'nflverse_play_id', 'is_qb_sneak'] }); } catch (e) { log(`ftn ${s} unavailable: ${e.message}`); }
  log(`ftn ${s} sneaks ${sneaks.size}`);
  const pg = new Map(), tg = new Map();
  const P = (g, team, opp, w, pid) => { const k = `${g}|${pid}`; let r = pg.get(k); if (!r) { r = { game: g, season: s, week: w, team, opp, pid, c: 0, c5: 0, c10: 0, t: 0, t10: 0, ezt: 0, rzay: 0, qbdr: 0, qbdr5: 0, sneak: 0, tds: 0, snap: NaN }; pg.set(k, r); } return r; };
  const T = (g, team, opp, w) => { const k = `${g}|${team}`; let r = tg.get(k); if (!r) { r = { game: g, season: s, week: w, team, opp, plays: 0, c: 0, c5: 0, c10: 0, t: 0, t10: 0, ezt: 0, rzay: 0, td_QB: 0, td_RB: 0, td_WR: 0, td_TE: 0 }; tg.set(k, r); } return r; };
  const cols = ['play_id', 'game_id', 'week', 'season_type', 'posteam', 'defteam', 'rush', 'pass', 'rusher_player_id', 'receiver_player_id', 'yardline_100', 'air_yards', 'rush_touchdown', 'pass_touchdown', 'td_player_id', 'td_team', 'qb_scramble', 'two_point_attempt', 'qb_kneel', 'qb_spike', 'sack'];
  await streamCsv(`${NFLV}/pbp/play_by_play_${s}.csv.gz`, o => {
    if (o.season_type !== 'REG' || !o.posteam || o.two_point_attempt === '1' || o.qb_kneel === '1' || o.qb_spike === '1') return null;
    const g = o.game_id, w = +o.week, tm = o.posteam, op = o.defteam, y = num(o.yardline_100);
    const rush = o.rush === '1', pass = o.pass === '1';
    if (rush || pass) T(g, tm, op, w).plays++;
    if (rush && o.rusher_player_id) {
      const r = P(g, tm, op, w, o.rusher_player_id); const qb = posOf.get(o.rusher_player_id) === 'QB'; const desig = o.qb_scramble !== '1';
      r.c++; if (y <= 5) r.c5++; if (y <= 10) r.c10++;
      if (qb && desig) { r.qbdr++; if (y <= 5) r.qbdr5++; }
      if (qb && sneaks.has(`${g}|${num(o.play_id)}`)) r.sneak++;
    }
    if (pass && o.receiver_player_id && o.sack !== '1') {
      const r = P(g, tm, op, w, o.receiver_player_id); const ay = Number.isFinite(num(o.air_yards)) ? num(o.air_yards) : 0;
      r.t++; if (y <= 10) r.t10++; if (ay >= y) r.ezt++; if (y <= 20) r.rzay += Math.max(0, ay);
    }
    if ((o.rush_touchdown === '1' || o.pass_touchdown === '1') && o.td_player_id && o.td_team === tm) P(g, tm, op, w, o.td_player_id).tds++;
    return null;
  }, { ...opt, columns: cols });
  log(`pbp ${s} player-games ${pg.size} team-games ${tg.size}`);
  // snaps (pfr -> gsis via weekly rosters); snaps-only games enter the player-game table
  const pf = new Map(); for (const r of rw) if (r.pfr && r.gsis && !pf.has(r.pfr)) pf.set(r.pfr, r.gsis);
  const teamGame = new Map([...tg.values()].map(t => [`${t.game}|${t.team}`, t]));
  let sn = 0;
  await streamCsv(`${NFLV}/snap_counts/snap_counts_${s}.csv`, o => {
    if (o.game_type !== 'REG' || !(num(o.offense_snaps) > 0)) return null; const pid = pf.get(o.pfr_player_id); if (!pid) return null;
    const k = `${o.game_id}|${pid}`; let r = pg.get(k);
    if (!r) { const t = teamGame.get(`${o.game_id}|${o.team}`); if (!t) return null; r = P(o.game_id, t.team, t.opp, t.week, pid); }
    r.snap = num(o.offense_pct); sn++; return null;
  }, { ...opt, columns: ['game_id', 'game_type', 'team', 'pfr_player_id', 'offense_snaps', 'offense_pct'] });
  log(`snaps ${s} ${sn}`);
  for (const r of pg.values()) { const t = tg.get(`${r.game}|${r.team}`); if (!t) continue; for (const a of SH) t[a] += r[a]; const ps = posOf.get(r.pid); if (t['td_' + ps] != null) t['td_' + ps] += r.tds; }
  return { season: s, rw, posOf, pg: [...pg.values()].filter(r => tg.has(`${r.game}|${r.team}`)), tg: [...tg.values()] };
}
export async function loadSchedule() {
  return streamCsv('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv', o => (o.game_type === 'REG' && +o.season >= 2020 ? { game: o.game_id, season: +o.season, week: +o.week, home: o.home_team, away: o.away_team, spread: num(o.spread_line), total: num(o.total_line), kickoff: `${o.gameday}T${o.gametime || '13:00'}` } : null),
    { ...opt, columns: ['game_id', 'season', 'game_type', 'week', 'home_team', 'away_team', 'spread_line', 'total_line', 'gameday', 'gametime'] });
}
export function combine(seasons, schedule) {
  const pos = new Map(); for (const S of seasons) for (const [g, p] of S.posOf) pos.set(g, p);
  const pg = seasons.flatMap(S => S.pg).map(r => ({ ...r, pos: pos.get(r.pid) || null })); const tg = seasons.flatMap(S => S.tg);
  const tgi = new Map(tg.map(t => [`${t.game}|${t.team}`, t]));
  for (const r of pg) { const t = tgi.get(`${r.game}|${r.team}`); for (const a of SH) r['D_' + a] = t[a]; }
  const by = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } for (const v of m.values()) v.sort((a, b) => a.season - b.season || a.week - b.week); return m; };
  const sched = new Map(); for (const g of schedule) for (const [team, opp, home] of [[g.home, g.away, 1], [g.away, g.home, 0]]) sched.set(`${g.season}|${g.week}|${team}`, { ...g, team, opp, isHome: home });
  const rws = seasons.flatMap(S => S.rw);
  return { pos, pg, tg, byP: by(pg, r => r.pid), byT: by(tg, t => t.team), byD: by(tg, t => t.opp), sched, rw: rws };
}
const before = (s, w) => r => r.season < s || (r.season === s && r.week < w);
// pooled constants from data strictly before (s, w)
export function priors(C, s, w) {
  const b = before(s, w); const pm = {}; const acc = {};
  for (const r of C.pg) { if (!b(r) || !r.pos) continue; const a = acc[r.pos] || (acc[r.pos] = { n: 0, sn: 0, snn: 0, ...Object.fromEntries([...SH, ...SH.map(x => 'D_' + x), ...RT].map(k => [k, 0])) }); a.n++; for (const k of [...SH, ...RT]) a[k] += r[k]; for (const k of SH) a['D_' + k] += r['D_' + k]; if (Number.isFinite(r.snap)) { a.sn += r.snap; a.snn++; } }
  for (const [p, a] of Object.entries(acc)) { pm[p] = {}; for (const k of SH) pm[p][k] = a[k] / Math.max(a['D_' + k], 1e-9); for (const k of RT) pm[p][k] = a[k] / a.n; pm[p].snap = a.snn ? a.sn / a.snn : 0.5; }
  const tgB = C.tg.filter(b); const mean = k => tgB.reduce((x, t) => x + t[k], 0) / Math.max(1, tgB.length);
  const teamavg = Object.fromEntries(SH.map(k => [k, mean(k)])); const lg = Object.fromEntries(['plays', 'td_RB', 'td_WR', 'td_TE', 'td_QB'].map(k => [k, mean(k)]));
  return { pm, teamavg, lg };
}
function pfeat(C, Pr, pid, s, w, pos) {
  const g = C.byP.get(pid) || []; const m = Pr.pm[pos] || Pr.pm.WR;
  const cur = g.filter(r => r.season === s && r.week < w), pri = g.filter(r => r.season === s - 1);
  const n = cur.length; const wt = cur.map((_, i) => D ** (n - 1 - i)); const ws = wt.reduce((a, b) => a + b, 0);
  const sw = k => cur.reduce((a, r, i) => a + r[k] * wt[i], 0), sp = k => pri.reduce((a, r) => a + r[k], 0);
  const o = {};
  for (const a of SH) { const K = Pr.teamavg[a]; o['sh_' + a] = (sw(a) + PW * sp(a) + K * m[a]) / (sw('D_' + a) + PW * sp('D_' + a) + K); }
  const gw = ws + PW * pri.length;
  for (const r of RT) o['pg_' + r] = (sw(r) + PW * sp(r) + m[r]) / (gw + 1);
  const snv = r => (Number.isFinite(r.snap) ? r.snap : m.snap);
  o.snap = (cur.reduce((a, r, i) => a + snv(r) * wt[i], 0) + PW * pri.reduce((a, r) => a + snv(r), 0) + m.snap) / (gw + 1);
  const fin = cur.map(r => r.snap).filter(Number.isFinite); const last2 = cur.slice(-2).map(r => r.snap).filter(Number.isFinite);
  o.snap_trend = n >= 3 && fin.length && last2.length ? last2.reduce((a, b) => a + b, 0) / last2.length - fin.reduce((a, b) => a + b, 0) / fin.length : 0;
  o.n_cur = n; return o;
}
function tfeat(rows, Pr, s, w, cols) {
  const cur = (rows || []).filter(r => r.season === s && r.week < w), pri = (rows || []).filter(r => r.season === s - 1);
  const n = cur.length; const wt = cur.map((_, i) => D ** (n - 1 - i)); const gw = wt.reduce((a, b) => a + b, 0) + PW * pri.length + 2;
  return Object.fromEntries(cols.map(c => [c, (cur.reduce((a, r, i) => a + r[c] * wt[i], 0) + PW * pri.reduce((a, r) => a + r[c], 0) + 2 * Pr.lg[c]) / gw]));
}
const L = x => Math.log(Math.max(x, 1e-3));
// Feature vector (object keyed by USAGE_FEATURES) for player pid at (s, w) vs opp; lines given.
export function featureRow(C, Pr, cache, { pid, pos, s, w, team, opp, home, implied, spread }) {
  const f = pfeat(C, Pr, pid, s, w, pos);
  const tk = `${team}|${s}|${w}`, dk = `${opp}|${s}|${w}`;
  const Tm = cache.t.get(tk) || (cache.t.set(tk, tfeat(C.byT.get(team), Pr, s, w, ['plays'])), cache.t.get(tk));
  const Df = cache.d.get(dk) || (cache.d.set(dk, tfeat(C.byD.get(opp), Pr, s, w, ['plays', 'td_RB', 'td_WR', 'td_TE', 'td_QB'])), cache.d.get(dk));
  const isQB = pos === 'QB' ? 1 : 0;
  return {
    def_pos: ['RB', 'WR', 'TE', 'QB'].includes(pos) ? Math.log((Df['td_' + pos] ?? Pr.lg['td_' + pos]) / Pr.lg['td_' + pos]) : 0,
    home: home ? 1 : 0, implied, isQB, isRB: pos === 'RB' ? 1 : 0, isTE: pos === 'TE' ? 1 : 0,
    l_c10: L(f.sh_c10), l_c5: L(f.sh_c5), l_ezt: L(f.sh_ezt), l_pace: Math.log(Tm.plays / 63.8) + Math.log(Df.plays / 63.8), l_rzay: L(f.sh_rzay), l_t10: L(f.sh_t10),
    qb_dr: isQB * f.pg_qbdr, qb_dr5: isQB * f.pg_qbdr5, qb_sneak: isQB * f.pg_sneak, snap: f.snap, snap_trend: f.snap_trend, spread, tdh: L(f.pg_tds), l_t: L(f.sh_t), l_c: L(f.sh_c),
  };
}
export function linesFor(C, s, w, team) {
  const g = C.sched.get(`${s}|${w}|${team}`); if (!g) return null;
  const tot = Number.isFinite(g.total) ? g.total : 44, sp = Number.isFinite(g.spread) ? g.spread : 0; // nflverse spread_line: home margin (+ = home favored)
  const homeImp = (tot + sp) / 2, awayImp = (tot - sp) / 2;
  return { opp: g.opp, home: g.isHome, implied: g.isHome ? homeImp : awayImp, spread: g.isHome ? -sp : sp, kickoff: g.kickoff, game: g.game };
}
// Training rows: every skill player-game strictly before (s, w) in the loaded seasons (first season onward).
export function trainingRows(C, s, w, Pr, cache) {
  const X = [], y = [];
  for (const r of C.pg) {
    if (!before(s, w)(r) || !SKILL.has(r.pos)) continue;
    const ln = linesFor(C, r.season, r.week, r.team); if (!ln) continue;
    const f = featureRow(C, Pr, cache, { pid: r.pid, pos: r.pos, s: r.season, w: r.week, team: r.team, opp: r.opp, home: ln.home, implied: ln.implied, spread: ln.spread });
    X.push(USAGE_FEATURES.map(k => f[k])); y.push(r.tds > 0 ? 1 : 0);
  }
  return { X, y };
}
// Ridge cloglog by Fisher scoring on standardized features (intercept unpenalized).
export function fitCloglog(X, y, { ridge = 2 } = {}) {
  const n = X.length, d = X[0].length; const mu = Array(d).fill(0), sd = Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mu[j] += x[j] / n;
  for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) + 1e-9;
  const Z = X.map(x => [1, ...x.map((v, j) => (v - mu[j]) / sd[j])]);
  const ybar = y.reduce((a, b) => a + b, 0) / n; let b = Array(d + 1).fill(0); b[0] = Math.log(-Math.log(1 - ybar));
  const obj = bb => { let s = 0; for (let i = 0; i < n; i++) { const e = Math.max(-12, Math.min(3, Z[i].reduce((a, v, j) => a + v * bb[j], 0))); const m = Math.exp(e); const p = Math.min(1 - 1e-9, Math.max(1e-9, 1 - Math.exp(-m))); s -= y[i] ? Math.log(p) : -m; } for (let j = 1; j <= d; j++) s += 0.5 * ridge * bb[j] ** 2; return s; };
  let cur = obj(b);
  for (let it = 0; it < 60; it++) {
    const g = Array(d + 1).fill(0), H = Array.from({ length: d + 1 }, () => Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i]; const e = Math.max(-12, Math.min(3, z.reduce((a, v, j) => a + v * b[j], 0))); const m = Math.exp(e), em = Math.exp(-m); const p = Math.min(1 - 1e-9, Math.max(1e-9, 1 - em));
      const ge = y[i] ? -m * em / p : m; const w = m * m * em / p;
      for (let a = 0; a <= d; a++) { g[a] += ge * z[a]; const wa = w * z[a]; for (let c = a; c <= d; c++) H[a][c] += wa * z[c]; }
    }
    for (let a = 0; a <= d; a++) for (let c = 0; c < a; c++) H[a][c] = H[c][a];
    for (let j = 1; j <= d; j++) { g[j] += ridge * b[j]; H[j][j] += ridge; }
    const step = solve(H, g); if (!step) break;
    let t = 1, nb, no; for (let k = 0; k < 20; k++) { nb = b.map((v, j) => v - t * step[j]); no = obj(nb); if (no <= cur + 1e-10) break; t /= 2; }
    const delta = Math.max(...step.map(Math.abs)) * t; b = nb; const conv = Math.abs(cur - no) < 1e-8 * Math.max(1, Math.abs(cur)); cur = no;
    if (delta < 1e-7 || conv) break;
  }
  return { b, mu, sd, n, features: USAGE_FEATURES.slice(), ridge };
}
function solve(A, b) { const n = b.length; const M = A.map((r, i) => [...r, b[i]]); for (let i = 0; i < n; i++) { let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k; [M[i], M[p]] = [M[p], M[i]]; if (Math.abs(M[i][i]) < 1e-12) return null; for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; } } return M.map((r, i) => r[n] / r[i]); }
// Players to ship for target (s, w): everyone on a skill-position weekly roster this season (latest week <= w)
// plus anyone with a player-game this season; team from the latest roster week. Base eta excludes line terms.
export function shipTable(C, fit, s, w, Pr, cache, meta = {}) {
  const latest = new Map(); for (const r of C.rw) if (r.season === s && r.week <= w && r.gsis && SKILL.has(r.pos)) { const o = latest.get(r.gsis); if (!o || r.week >= o.week) latest.set(r.gsis, r); }
  for (const r of C.pg) if (r.season === s && r.week < w && !latest.has(r.pid) && SKILL.has(r.pos)) latest.set(r.pid, { gsis: r.pid, team: r.team, pos: r.pos, week: r.week, status: 'ACT' });
  const players = {}, bySleeper = {};
  for (const r of C.rw) if (r.season === s && r.sleeper && r.gsis) bySleeper[r.sleeper] = r.gsis;
  const idx = k => fit.features.indexOf(k);
  for (const [g, r] of latest) {
    if (r.status && !['ACT', 'INA', 'RES', 'DEV'].includes(r.status) && r.status !== '') continue;
    const ln = linesFor(C, s, w, r.team); if (!ln) continue;
    const pos = C.pos.get(g) || r.pos;
    const f = featureRow(C, Pr, cache, { pid: g, pos, s, w, team: r.team, opp: ln.opp, home: 0, implied: 0, spread: 0 });
    let e = fit.b[0]; fit.features.forEach((k, j) => { if (!LINE_FEATURES.includes(k)) e += fit.b[j + 1] * (f[k] - fit.mu[j]) / fit.sd[j]; });
    players[g] = [pos, Math.round(e * 1e4) / 1e4];
  }
  const lineCoef = Object.fromEntries(LINE_FEATURES.map(k => [k, { b: +fit.b[idx(k) + 1].toFixed(5), mu: +fit.mu[idx(k)].toFixed(4), sd: +fit.sd[idx(k)].toFixed(4) }]));
  const coef = Object.fromEntries([['intercept', +fit.b[0].toFixed(4)], ...fit.features.map((k, j) => [k, +fit.b[j + 1].toFixed(4)])]);
  return { kind: 'usage-cloglog', version: 1, season: s, week: w, ...meta, trainedOn: `player-games before ${s} week ${w} (from ${Math.min(...C.pg.map(r => r.season))})`, trainRows: fit.n, ridge: fit.ridge, coef, lineCoef, players, bySleeper };
}
