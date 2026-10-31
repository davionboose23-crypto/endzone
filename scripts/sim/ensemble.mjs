// 4.16.0 ensemble check: p = w*drive + (1-w)*pbp, w fit walk-forward (weeks before W, log loss, grid 0..1), top 4 re-ranked from the blend
import fs from 'node:fs';
const [file, A = 'driveNew', Bk = 'pbp2New'] = process.argv.slice(2); const D = JSON.parse(fs.readFileSync(file, 'utf8'));
const ll = (p, y) => { p = Math.min(1 - 1e-4, Math.max(1e-4, p)); return -(y ? Math.log(p) : Math.log(1 - p)); };
const ms = x => { const n = x.length, m = x.reduce((s, v) => s + v, 0) / n; return [m, Math.sqrt(x.reduce((s, q) => s + (q - m) ** 2, 0) / (n - 1) / n)]; };
const f = ([m, s], d = 3) => `${m >= 0 ? '+' : ''}${m.toFixed(d)} ± ${s.toFixed(d)}`; const res = {};
for (const S of ['B26', 'B25']) { const B = D[S]; const P = B.players.filter(r => r[A] != null && r[Bk] != null); const weeks = [...new Set(P.map(r => r.w))].sort((a, b) => a - b);
  const ws = {}; const blend = (r, w) => w * r[A] + (1 - w) * r[Bk];
  for (const W of weeks) { const tr = P.filter(r => r.w < W && r.legacy); if (tr.length < 200) { ws[W] = 0.5; continue; } let best = 0.5, bl = 1e9; for (let w = 0; w <= 1.0001; w += 0.05) { const l = tr.reduce((s, r) => s + ll(blend(r, w), r.y), 0); if (l < bl) { bl = l; best = +w.toFixed(2); } } ws[W] = best; }
  const byG = new Map(); for (const r of P) { (byG.get(r.gid) || byG.set(r.gid, []).get(r.gid)).push(r); }
  const hE = [], hA = [], hB = [], lE = [], lA = [], lB = [];
  for (const [gid, rs] of byG) { const w = ws[rs[0].w]; const top = k => [...rs].sort((x, y) => k(y) - k(x)).slice(0, 4).reduce((s, r) => s + r.y, 0);
    hE.push(top(r => blend(r, w))); hA.push(top(r => r[A])); hB.push(top(r => r[Bk]));
    const L = rs.filter(r => r.legacy); if (L.length) { lE.push(L.reduce((s, r) => s + ll(blend(r, w), r.y), 0) / L.length); lA.push(L.reduce((s, r) => s + ll(r[A], r.y), 0) / L.length); lB.push(L.reduce((s, r) => s + ll(r[Bk], r.y), 0) / L.length); } }
  const d = (x, y) => x.map((v, i) => v - y[i]);
  res[S] = { weights: ws, hits: { ens: ms(hE)[0].toFixed(3), [A]: ms(hA)[0].toFixed(3), [Bk]: ms(hB)[0].toFixed(3) }, ensMinusA_hits: f(ms(d(hE, hA))), ensMinusB_hits: f(ms(d(hE, hB))), ll: { ens: ms(lE)[0].toFixed(4), [A]: ms(lA)[0].toFixed(4), [Bk]: ms(lB)[0].toFixed(4) }, ensMinusA_ll: f(ms(d(lE, lA)), 4), ensMinusB_ll: f(ms(d(lE, lB)), 4) }; }
console.log(JSON.stringify(res, null, 1));
