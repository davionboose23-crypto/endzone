// Drive-trends agent: per-player usage by team drive number and by game phase, from the nflverse drive table
// (scripts/drives/lib.mjs). Strictly pre-game: detect(tables, s, w) only reads drives from games before week w
// of season s (plus season s-1). Every candidate pattern is a two-sided exact test against the player's own
// usage on his team's OTHER drives in the same games, Benjamini-Hochberg FDR across all tests of the run,
// shrinkage of the displayed rate toward the player's overall per-drive rate, and an out-of-sample persistence
// check (patterns found through week N, scored on week N+1) that sets the reliability label.
export const DRIVE_FLAGS = { first2H: 1, twoMin: 2, rz: 4, gtg: 8 };
export const MAX_DRIVE_N = 10;
export const PHASES = [
  ['open', 'opening-script drives (1–2)', d => d.n <= 2],
  ['h1later', 'first-half drives 3+', d => d.half === 1 && d.n >= 3],
  ['first2H', 'the first drive after halftime', d => (d.flags & DRIVE_FLAGS.first2H) > 0],
  ['lead2H', 'second-half drives when leading', d => d.half >= 2 && !(d.flags & DRIVE_FLAGS.first2H) && d.sd > 0],
  ['trail2H', 'second-half drives when trailing', d => d.half >= 2 && !(d.flags & DRIVE_FLAGS.first2H) && d.sd < 0],
  ['twoMin', 'two-minute drives', d => (d.flags & DRIVE_FLAGS.twoMin) > 0],
  ['rz', 'red-zone drives', d => (d.flags & DRIVE_FLAGS.rz) > 0],
  ['gtg', 'goal-to-go drives', d => (d.flags & DRIVE_FLAGS.gtg) > 0],
];
// Metrics are SHARES of the team's own volume on those drives (conditional binomial on team counts). A raw
// per-drive rate test would mostly rediscover that some drives are longer than others (red-zone drives have more
// snaps, end-of-half drives fewer), which is a team effect, not a player pattern; per-drive rates are displayed only.
export const METRICS = [
  ['touchShare', 'share', 'touches', r => r.tgt + r.car, d => d.tgt + d.car],
  ['tgtShare', 'share', 'targets', r => r.tgt, d => d.tgt],
  ['carShare', 'share', 'carries', r => r.car, d => d.car],
];
const PRIOR = { rate: 10, share: 10, mean: 10 }; // shrinkage strength (pseudo drives / team opportunities)
export const ORD = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

function lgamma(x) { const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i++) a += c[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); }
// two-sided exact binomial p (sum of outcomes no more likely than the observed one)
export function binomTwoSided(k, n, p) {
  if (n <= 0 || p <= 0 || p >= 1) return 1;
  const lc = lgamma(n + 1), lp = Math.log(p), lq = Math.log(1 - p); const lpmf = i => lc - lgamma(i + 1) - lgamma(n - i + 1) + i * lp + (n - i) * lq;
  const o = lpmf(k) + 1e-7; let s = 0; for (let i = 0; i <= n; i++) { const v = lpmf(i); if (v <= o) s += Math.exp(v); } return Math.min(1, s);
}
const normP = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2); const q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return 2 * q; };
// Benjamini-Hochberg q-values
export function bhQ(ps) {
  const m = ps.length; const o = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]); const q = Array(m); let run = 1;
  for (let k = m - 1; k >= 0; k--) { run = Math.min(run, o[k][0] * m / (k + 1)); q[o[k][1]] = run; } return q;
}
const before = (s, w) => d => d.season === s - 1 || (d.season === s && d.week < w);
// Unpack drive tables into per-player game lists (only drives before (s, w), seasons s-1 and s).
export function indexTables(tables, s, w) {
  const keep = before(s, w); const people = {}; const games = new Map(); const byP = new Map();
  for (const T of tables) {
    if (T.season !== s && T.season !== s - 1) continue;
    for (const [k, v] of Object.entries(T.people)) if (T.season === s || !people[k]) people[k] = v;
    const C = T.cols.drives; const D = T.drives.map(r => Object.fromEntries(C.map((c, i) => [c, r[i]])));
    for (const d of D) { if (!keep(d)) continue; const k = `${d.game}|${d.team}`; if (!games.has(k)) games.set(k, { key: k, season: d.season, week: d.week, game: d.game, team: d.team, opp: d.opp, drives: [] }); games.get(k).drives.push(d); }
    const PC = T.cols.players;
    for (const r of T.players) { const d = D[r[0]]; if (!keep(d)) continue; const o = Object.fromEntries(PC.map((c, i) => [c, r[i]])); const gk = `${d.game}|${d.team}`;
      if (!byP.has(o.pid)) byP.set(o.pid, new Map()); const pm = byP.get(o.pid); if (!pm.has(gk)) pm.set(gk, new Map()); pm.get(gk).set(d.n, o); }
  }
  for (const g of games.values()) g.drives.sort((a, b) => a.n - b.n);
  return { people, games, byP };
}
const Z = { tgt: 0, rec: 0, recYd: 0, car: 0, rushYd: 0, rz: 0, i10: 0, td: 0 };
// all (drive, player-row) pairs for one player, in game order
function playerDrives(I, pid) {
  const pm = I.byP.get(pid); if (!pm) return [];
  const G = [...pm.keys()].map(k => I.games.get(k)).filter(Boolean).sort((a, b) => a.season - b.season || a.week - b.week);
  return G.map(g => ({ g, rows: g.drives.map(d => ({ d, r: pm.get(g.key).get(d.n) || Z })) }));
}
function subsets() { const out = []; for (let n = 1; n <= MAX_DRIVE_N; n++) out.push({ fam: 'drive', key: `d${n}`, label: `the ${ORD(n)} drive`, f: d => d.n === n }); for (const [k, label, f] of PHASES) out.push({ fam: 'phase', key: k, label, f }); return out; }
export const SUBSETS = subsets();
// One test: subset S vs the player's other drives in the same games
function testOne(rows, S, M) {
  const [, kind, , val, opp] = M; let xS = 0, xR = 0, nS = 0, nR = 0, oS = 0, oR = 0, ssS = 0, ssR = 0;
  for (const { d, r } of rows) { const v = val(r); const o = opp ? opp(d) : 1; if (S.f(d)) { xS += v; nS++; oS += o; ssS += v * v; } else { xR += v; nR++; oR += o; ssR += v * v; } }
  const x = xS + xR, n = nS + nR, oT = oS + oR; if (!nS || !nR) return null;
  let p, base, raw, shr;
  if (kind === 'mean') {
    const mS = xS / nS, mR = xR / nR, vS = Math.max(ssS / nS - mS * mS, 1), vR = Math.max(ssR / nR - mR * mR, 1);
    p = normP((mS - mR) / Math.sqrt(vS / nS + vR / nR)); base = x / n; raw = mS; shr = (xS + PRIOR.mean * base) / (nS + PRIOR.mean);
  } else if (kind === 'share') {
    if (!oS || !oR || x === 0) return null; p = binomTwoSided(xS, x, oS / oT); base = x / oT; raw = xS / oS; shr = (xS + PRIOR.share * base) / (oS + PRIOR.share);
  } else { if (x === 0) return null; p = binomTwoSided(xS, x, nS / n); base = x / n; raw = xS / nS; shr = (xS + PRIOR.rate * base) / (nS + PRIOR.rate); }
  const rest = kind === 'share' ? xR / oR : xR / nR;
  return { p, nS, oS, xS, base, rest, raw, shr, lift: base > 0 ? shr / base : 1 };
}
// eligibility per metric (enough volume to test at all)
function eligible(M, tot) { const k = M[0]; if (k === 'tgtShare') return tot.tgt >= 15; if (k === 'carShare') return tot.car >= 15; return tot.tgt + tot.car >= 20; }
// Detect: every eligible (player, subset, metric) test with BH q-values across the whole run.
export function detect(tables, s, w, { minGames = 4, minDrives = 5, I = null } = {}) {
  I = I || indexTables(tables, s, w); const tests = [];
  for (const pid of I.byP.keys()) {
    const P = playerDrives(I, pid); if (P.length < minGames) continue; const rows = P.flatMap(x => x.rows);
    const tot = rows.reduce((a, { r }) => ({ tgt: a.tgt + r.tgt, car: a.car + r.car }), { tgt: 0, car: 0 });
    for (const M of METRICS) { if (!eligible(M, tot)) continue;
      for (const S of SUBSETS) { const t = testOne(rows, S, M); if (!t || t.nS < minDrives) continue; tests.push({ pid, fam: S.fam, sub: S.key, metric: M[0], ...t }); } }
  }
  const q = bhQ(tests.map(t => t.p)); tests.forEach((t, i) => { t.q = q[i]; });
  return { I, tests };
}
// One week's drives per player (games he appeared in), for out-of-sample scoring
export function weekRows(tables, s, w) {
  const out = new Map();
  for (const T of tables) { if (T.season !== s) continue; const C = T.cols.drives, PC = T.cols.players;
    const D = T.drives.map(r => Object.fromEntries(C.map((c, i) => [c, r[i]]))); const games = new Map(); const at = new Map(D.map((d, i) => [d, i]));
    D.forEach(d => { if (d.week !== w) return; const k = `${d.game}|${d.team}`; if (!games.has(k)) games.set(k, []); games.get(k).push(d); });
    const mine = new Map(); for (const r of T.players) { const d = D[r[0]]; if (d.week !== w) continue; const o = Object.fromEntries(PC.map((c, i) => [c, r[i]]));
      if (!mine.has(o.pid)) mine.set(o.pid, new Map()); mine.get(o.pid).set(r[0], o); }
    for (const [pid, m] of mine) { const gk = new Set([...m.keys()].map(i => `${D[i].game}|${D[i].team}`)); const rows = [];
      for (const k of gk) for (const d of games.get(k)) rows.push({ d, r: m.get(at.get(d)) || Z }); out.set(pid, rows); }
  }
  return out;
}
// Out-of-sample score of a detected pattern on one later week: observed vs player's base rate (E0) vs pattern (E1)
export function scoreRows(rows, t) {
  const S = SUBSETS.find(x => x.key === t.sub), M = METRICS.find(x => x[0] === t.metric); let O = 0, units = 0;
  for (const { d, r } of rows || []) { if (!S.f(d)) continue; O += M[3](r); units += M[4] ? M[4](d) : 1; }
  return units ? { O, E0: t.base * units, E1: t.shr * units, units } : null;
}
export function reliability(t, fam) {
  const famOk = fam && fam.retention != null && fam.ciLo > 0; const own = t.own;
  if (t.q <= 0.05 && t.nS >= 20 && famOk && (!own || own.weeks < 2 || own.retention > 0.25)) return 'strong';
  if (t.q <= 0.10 && t.nS >= 10 && fam && fam.retention > 0) return 'moderate';
  return null;
}
const pct = x => `${Math.round(x * 100)}%`;
export function describe(t) {
  const S = SUBSETS.find(x => x.key === t.sub), M = METRICS.find(x => x[0] === t.metric); const up = t.shr >= t.base;
  return `${up ? 'Gets' : 'Only gets'} ${pct(t.shr)} of the team's ${M[2]} on ${S.label}, vs ${pct(t.rest)} on other drives (n=${t.nS} drives, ${t.oS} team ${M[2]}, ${t.rel})`;
}
// Descriptive per-player phase usage (always shown; not a "pattern" claim)
export function phaseSummary(P) {
  const rows = P.flatMap(x => x.rows); const g = P.length || 1; const sum = (f, pick) => rows.reduce((a, { d, r }) => a + (f(d) ? pick(r, d) : 0), 0);
  const touch = r => r.tgt + r.car; const ph = Object.fromEntries(PHASES.map(([k, , f]) => [k, f]));
  const rzT = sum(ph.rz, r => r.tgt), rzTeam = sum(ph.rz, (r, d) => d.tgt), gtgTouch = sum(ph.gtg, touch), gtgTeam = sum(ph.gtg, (r, d) => d.tgt + d.car);
  const lead = sum(ph.lead2H, touch) / Math.max(1, rows.filter(x => ph.lead2H(x.d)).length), trail = sum(ph.trail2H, touch) / Math.max(1, rows.filter(x => ph.trail2H(x.d)).length);
  return { games: P.length, drives: rows.length, openPerGame: +(sum(ph.open, touch) / g).toFixed(2), perDrive: +(rows.reduce((a, { r }) => a + touch(r), 0) / Math.max(1, rows.length)).toFixed(2),
    rzTgtShare: rzTeam ? +(rzT / rzTeam).toFixed(3) : null, rzDrives: rows.filter(x => ph.rz(x.d)).length, gtgTouchShare: gtgTeam ? +(gtgTouch / gtgTeam).toFixed(3) : null, gtgDrives: rows.filter(x => ph.gtg(x.d)).length,
    leadPerDrive: +lead.toFixed(2), trailPerDrive: +trail.toFixed(2) };
}
export { playerDrives };
