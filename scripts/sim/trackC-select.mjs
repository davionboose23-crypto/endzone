// offline top-4 selection / stacking experiments on dumped per-player sim rows (walk-forward: fits use weeks < W only)
import fs from 'node:fs';
const f = process.argv[2]; const D = JSON.parse(fs.readFileSync(f, 'utf8')).B26; const R = D.players.filter(r => r.pbp2New != null);
const cl = p => Math.min(0.995, Math.max(0.005, p)); const L = p => Math.log(p / (1 - p)); const S = x => 1 / (1 + Math.exp(-x));
const byG = new Map(); for (const r of R) (byG.get(r.gid) || byG.set(r.gid, []).get(r.gid)).push(r);
const weeks = [...new Set(R.map(r => r.w))].sort((a, b) => a - b);
function evalScore(name, score, pick = top4) { let h = 0, ll = 0, n = 0, g = 0; const out = {};
  for (const W of weeks) { const sc = score(W); if (!sc) continue; for (const [gid, rs] of byG) { if (rs[0].w !== W) continue; const p = rs.map(r => sc(r)); g++; h += pick(rs, p).filter(i => rs[i].y).length; rs.forEach((r, i) => { const q = cl(p[i].prob ?? p[i]); ll -= r.y ? Math.log(q) : Math.log(1 - q); n++; }); } }
  return { name, hits: +(h / g).toFixed(3), ll: +(ll / n).toFixed(5), g }; }
const val = x => x.rank ?? x.prob ?? x; 
function top4(rs, p) { return rs.map((r, i) => i).sort((a, b) => val(p[b]) - val(p[a])).slice(0, 4); }
// diversity: greedy, penalize same team+pos already picked
const div = lam => (rs, p) => { const c = rs.map((r, i) => i), pk = []; while (pk.length < 4) { let best = -1, bv = -1e9; for (const i of c) { if (pk.includes(i)) continue; const same = pk.filter(j => rs[j].team === rs[i].team && rs[j].pos === rs[i].pos).length; const v = val(p[i]) * Math.pow(1 - lam, same); if (v > bv) { bv = v; best = i; } } pk.push(best); } return pk; };
const res = [];
for (const [rw, dw] of [[0, 0.3], [0, 0.5], [0.1, 0.3], [0.2, 0.3], [0.2, 0.5], [0.1, 0.5]]) res.push(evalScore(`rank b${rw} / prob b${dw}`, () => r => { const d = r.driveNew ?? r.pbp2New; return { rank: (1 - rw) * r.pbp2New + rw * d, prob: (1 - dw) * r.pbp2New + dw * d }; }));
res.push(evalScore('base pbp', () => r => r.pbp2New));
for (const w of [0.1, 0.2, 0.3, 0.5]) res.push(evalScore('blend drive ' + w, () => r => (1 - w) * r.pbp2New + w * (r.driveNew ?? r.pbp2New)));
for (const w of [0.3, 0.5]) res.push(evalScore('geo blend ' + w, () => r => S((1 - w) * L(cl(r.pbp2New)) + w * L(cl(r.driveNew ?? r.pbp2New)))));
for (const lam of [0.15, 0.3, 0.5]) res.push(evalScore('diversity ' + lam, () => r => r.pbp2New, div(lam)));
// per-position walk-forward platt calibration (logit a+b*logit p per pos), fit on weeks < W
function fitPlatt(rows, k = 'pbp2New', iters = 300) { let a = 0, b = 1; const lr = 0.5; for (let t = 0; t < iters; t++) { let ga = 0, gb = 0; for (const r of rows) { const x = L(cl(r[k])); const e = S(a + b * x) - (r.y ? 1 : 0); ga += e; gb += e * x; } a -= lr * (ga / rows.length + 0.02 * a); b -= lr * (gb / rows.length + 0.02 * (b - 1)) * 0.2; } return { a, b }; }
for (const shr of [1, 0.5]) res.push(evalScore('posPlatt shr' + shr, W => { const prev = R.filter(r => r.w < W); if (prev.length < 300) return r => r.pbp2New; const F = {}; for (const pos of ['QB', 'RB', 'WR', 'TE']) { const rr = prev.filter(r => r.pos === pos); F[pos] = rr.length > 100 ? fitPlatt(rr) : { a: 0, b: 1 }; }
  return r => { const f = F[r.pos] || { a: 0, b: 1 }; const x = L(cl(r.pbp2New)); return S(x + shr * (f.a + f.b * x - x)); }; }));
// stacking: walk-forward logistic on [logit pbp, logit drive, pos dummies, log(1+tgt), log(1+car)]
function feats(r) { return [1, L(cl(r.pbp2New)), L(cl(r.driveNew ?? r.pbp2New)), r.pos === 'WR' ? 1 : 0, r.pos === 'TE' ? 1 : 0, r.pos === 'QB' ? 1 : 0, Math.log1p(r.tgt || 0), Math.log1p(r.car || 0)]; }
function fitLR(rows, F, l2) { const k = F(rows[0]).length; const w = new Array(k).fill(0); w[1] = 1; const X = rows.map(F), Y = rows.map(r => r.y ? 1 : 0);
  for (let t = 0; t < 600; t++) { const g = new Array(k).fill(0); X.forEach((x, i) => { const e = S(x.reduce((s, v, j) => s + v * w[j], 0)) - Y[i]; x.forEach((v, j) => g[j] += e * v); }); for (let j = 0; j < k; j++) w[j] -= 0.3 * (g[j] / X.length + l2 * (w[j] - (j === 1 ? 1 : 0))); } return w; }
for (const [nm, F] of [['stack full', feats], ['stack pbp+drive', r => feats(r).slice(0, 3)], ['stack pbp+pos', r => [1, L(cl(r.pbp2New)), ...feats(r).slice(3, 6)]]]) for (const l2 of [0.01, 0.1])
  res.push(evalScore(nm + ' l2=' + l2, W => { const prev = R.filter(r => r.w < W); if (prev.length < 300) return r => r.pbp2New; const w = fitLR(prev, F, l2); return r => S(F(r).reduce((s, v, j) => s + v * w[j], 0)); }));
for (const r of res) console.log(r.name.padEnd(24), r.hits, r.ll, r.g);
