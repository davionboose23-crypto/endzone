// app 4.13.0: "it's not always the favourite" diagnostics on a top4-backtest DUMP (walk-forward, research only).
// Usage: DUMP=/tmp/conc-dump.json DETAIL=/tmp/d.json NO_WRITE=1 node scripts/sim/top4-backtest.mjs --sims 600 && node scripts/sim/surprise-diag.mjs /tmp/conc-dump.json
// Per season and engine: log loss / Brier of the sims' anytime chances (all and by position), share of real TDs from outside each team's
// sim top 1/2/4 vs the sim's own share, TD share by depth role (actual / sim), calibration by within-team rank, and top-4 hits per game.
import fs from 'node:fs';
const D = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/conc-dump-413.json'));
const act = new Map(); for (const r of D) if (r.eng === 'actual') act.set(r.gid, r.act);
const TG = D.filter(r => r.eng !== 'actual');
// anytime for share s, TD-count hist h, Dirichlet concentration k (Infinity = fixed)
export function anyP(s, h, k) { if (!(s > 0)) return 0; let q = 0; let m = 1;
  for (let n = 0; n < h.length; n++) { if (n > 0) m *= isFinite(k) ? (k * (1 - s) + n - 1) / (k + n - 1) : (1 - s); q += h[n] * m; } return 1 - q; }
function role(pl) { const by = {}; for (const p of pl) (by[p.pos] ||= []).push(p); const r = new Map();
  for (const [pos, a] of Object.entries(by)) { a.sort((x, y) => (y.tgt + y.car) - (x.tgt + x.car)); a.forEach((p, i) => r.set(p.id, pos === 'QB' ? 'QB' : pos === 'FB' ? 'FB' : pos === 'WR' ? (i < 2 ? 'WR1-2' : 'WR3+') : pos === 'TE' ? (i ? 'TE2+' : 'TE1') : pos === 'RB' ? (i ? 'RB2+' : 'RB1') : pos)); } return r; }
export function apply(T, tau, k) { const w = T.pl.map(p => p.sh > 0 ? Math.pow(p.sh, tau) : 0); const sw = w.reduce((a, b) => a + b, 0) || 1; return [T.pl.map((p, i) => anyP(w[i] / sw, T.hist, k)), w.map(x => x / sw)]; }
export function evalSet(TS, f, label) {
  const out = { label, n: 0, ll: 0, br: 0, pos: {}, rk: {}, outK: { 1: [0, 0], 2: [0, 0], 4: [0, 0] }, roles: {}, totA: 0, totS: 0, games: new Map() };
  for (const T of TS) { const [ps, ss] = f(T); const A = act.get(T.gid) || []; const aT = A.filter(x => x.team === T.team); const tdA = aT.reduce((a, x) => a + x.td, 0); const nm = x => String(x || '').toLowerCase().replace(/[^a-z]/g, '').replace(/(jr|sr|ii|iii|iv)$/, ''); const ids = new Set(T.pl.map(p => nm(p.n)));
    const EN = T.hist.reduce((a, h, n) => a + h * n, 0); const shs = T.pl.map((p, i) => p.sh); // implied shares: from the probs (exp TDs approximated by share × EN, tempered)
    const w = ss; const sw = w.reduce((a, b) => a + b, 0) || 1; // implied expected-TD share ~ hazard share
    const ord = T.pl.map((p, i) => i).sort((a, b) => ps[b] - ps[a]); const rk = new Map(ord.map((i, r) => [i, r + 1])); const R = role(T.pl);
    out.totA += tdA; out.totS += 1;
    for (const K of [1, 2, 4]) { let a = 0, s = 0; T.pl.forEach((p, i) => { if (rk.get(i) > K) { a += p.td; s += w[i] / sw; } }); a += aT.filter(x => !ids.has(nm(x.n))).reduce((q, x) => q + x.td, 0); out.outK[K][0] += a; out.outK[K][1] += s * tdA; }
    T.pl.forEach((p, i) => { const y = p.td > 0 ? 1 : 0, q = Math.min(0.995, Math.max(0.005, ps[i])); out.n++; out.ll -= y ? Math.log(q) : Math.log(1 - q); out.br += (q - y) ** 2;
      const P = (out.pos[p.pos] ||= { n: 0, ll: 0, br: 0, p: 0, y: 0 }); P.n++; P.ll -= y ? Math.log(q) : Math.log(1 - q); P.br += (q - y) ** 2; P.p += q; P.y += y;
      const r = rk.get(i), b = r === 1 ? 'r1' : r === 2 ? 'r2' : r <= 4 ? 'r3-4' : r <= 6 ? 'r5-6' : 'r7+'; const B = (out.rk[b] ||= { n: 0, p: 0, y: 0 }); B.n++; B.p += q; B.y += y;
      const ro = R.get(p.id); const O = (out.roles[ro] ||= { a: 0, s: 0 }); O.a += p.td; O.s += (w[i] / sw) * tdA; });
    const un = aT.filter(x => !ids.has(nm(x.n))).reduce((q, x) => q + x.td, 0); if (un) { const O = (out.roles.unlisted ||= { a: 0, s: 0 }); O.a += un; }
    const G = out.games.get(T.gid) || []; T.pl.forEach((p, i) => G.push([ps[i], p.td > 0 ? 1 : 0])); out.games.set(T.gid, G); }
  let h = 0, g = 0; for (const G of out.games.values()) { G.sort((a, b) => b[0] - a[0]); h += G.slice(0, 4).reduce((a, x) => a + x[1], 0); g++; } out.top4 = h / g; out.exp4 = [...out.games.values()].reduce((a, G) => a + G.slice(0, 4).reduce((q, x) => q + x[0], 0), 0) / g; out.nG = g; delete out.games; return out; }
if (process.argv[1].endsWith('surprise-diag.mjs')) {
  const fmt = o => { const r = x => x.toFixed(3); console.log(`== ${o.label}  n=${o.n} LL ${r(o.ll / o.n)} Brier ${r(o.br / o.n)}  top4 ${o.top4.toFixed(2)} (exp ${o.exp4.toFixed(2)}) /game`);
    console.log('  outside team top1/2/4 actual vs sim:', [1, 2, 4].map(K => `${K}: ${r(o.outK[K][0] / o.totA)} vs ${r(o.outK[K][1] / o.totA)}`).join('  '));
    console.log('  rank:', Object.entries(o.rk).map(([b, B]) => `${b} ${r(B.p / B.n)}/${r(B.y / B.n)}`).join('  '));
    console.log('  roles TD share a/s:', Object.entries(o.roles).sort().map(([b, B]) => `${b} ${r(B.a / o.totA)}/${r(B.s / o.totA)}`).join('  '));
    console.log('  pos:', Object.entries(o.pos).map(([b, B]) => `${b} B${r(B.br / B.n)} L${r(B.ll / B.n)} p${r(B.p / B.n)} y${r(B.y / B.n)}`).join('  ')); };
  const engs = [...new Set(TG.map(t => t.eng))];
  for (const S of [2025, 2026]) for (const e of engs) { const TS = TG.filter(t => t.S === S && t.eng === e); if (TS.length) fmt(evalSet(TS, T => [T.pl.map(p => p.any), T.pl.map(p => p.sh)], `${S} ${e}`)); }
}
