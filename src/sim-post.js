// app 4.20.0 — post-sim adjustments for the play-by-play sim's anytime-TD chances, fitted walk-forward on earlier 2026 weeks only
// (rows = { w, pos, p (raw sim chance, 0 = not on the sim roster), y }); nothing from the target week or later is read.
const lg = p => Math.log(p / (1 - p)), sig = x => 1 / (1 + Math.exp(-x));
export const POST_DEFAULTS = { floorPrior: 0.012, floorK: 150, calK: 400 };
// 1) unlisted players: position TD rate among earlier weeks' unlisted players, shrunk toward floorPrior
export function fitFloor(rows, before, o = POST_DEFAULTS) {
  const out = {}; for (const pos of ['QB', 'RB', 'WR', 'TE']) { const r = rows.filter(x => x.w < before && x.pos === pos && !(x.p > 0)); const y = r.reduce((a, x) => a + x.y, 0);
    out[pos] = Math.round(((y + o.floorK * o.floorPrior) / (r.length + o.floorK)) * 1e4) / 1e4; } return out; }
// 2) calibration: logit(p') = a + b*logit(p) on listed players, ridge toward identity (a = 0, b = 1) with calK pseudo-rows of weight
export function fitCal(rows, before, o = POST_DEFAULTS) {
  const r = rows.filter(x => x.w < before && x.p > 0); if (r.length < 200) return { a: 0, b: 1, n: r.length };
  let a = 0, b = 1; const K = o.calK;
  for (let it = 0; it < 30; it++) { let g0 = -K * a / 100, g1 = -K * (b - 1), h00 = K / 100, h01 = 0, h11 = K;
    for (const x of r) { const z = lg(Math.min(0.98, Math.max(0.002, x.p))); const p = sig(a + b * z); const e = x.y - p, w = p * (1 - p); g0 += e; g1 += e * z; h00 += w; h01 += w * z; h11 += w * z * z; }
    const det = h00 * h11 - h01 * h01; a += (h11 * g0 - h01 * g1) / det; b += (h00 * g1 - h01 * g0) / det; }
  return { a: Math.round(a * 1e4) / 1e4, b: Math.round(b * 1e4) / 1e4, n: r.length };
}
export function applyPost(p, pos, F, C) {
  if (!(p > 0)) return F ? (F[pos === 'FB' ? 'RB' : pos] ?? 0) : p;
  return C ? sig(C.a + C.b * lg(Math.min(0.98, Math.max(0.002, p)))) : p;
}
