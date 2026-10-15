// Metrics with game-level bootstrap intervals.
export const cl = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
export const brier = (rows, k) => rows.reduce((s, r) => s + (r[k] - r.y) ** 2, 0) / rows.length;
export const logloss = (rows, k) => -rows.reduce((s, r) => s + (r.y ? Math.log(cl(r[k])) : Math.log(1 - cl(r[k]))), 0) / rows.length;
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
// paired difference a - b (negative = a better), resampling whole games
export function pairedBoot(rows, a, b, { B = 1000, seed = 1 } = {}) {
  const games = new Map(); for (const r of rows) { if (!games.has(r.gameId)) games.set(r.gameId, []); games.get(r.gameId).push(r); }
  const G = [...games.values()].map(rs => ({ n: rs.length, db: rs.reduce((s, r) => s + (r[a] - r.y) ** 2 - (r[b] - r.y) ** 2, 0), dl: rs.reduce((s, r) => s + (r.y ? -Math.log(cl(r[a])) + Math.log(cl(r[b])) : -Math.log(1 - cl(r[a])) + Math.log(1 - cl(r[b]))), 0) }));
  const tot = G.reduce((s, g) => ({ n: s.n + g.n, db: s.db + g.db, dl: s.dl + g.dl }), { n: 0, db: 0, dl: 0 });
  const R = rng(seed); const bs = [], ls = [];
  for (let i = 0; i < B; i++) { let n = 0, db = 0, dl = 0; for (let j = 0; j < G.length; j++) { const g = G[(R() * G.length) | 0]; n += g.n; db += g.db; dl += g.dl; } bs.push(db / n); ls.push(dl / n); }
  const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
  return { n: tot.n, games: G.length, dBrier: tot.db / tot.n, dBrierCI: [q(bs, .025), q(bs, .975)], dLogLoss: tot.dl / tot.n, dLogLossCI: [q(ls, .025), q(ls, .975)] };
}
export const r4 = x => (x == null ? null : Math.round(x * 10000) / 10000);
export function summary(rows, k) { return rows.length ? { n: rows.length, brier: r4(brier(rows, k)), logLoss: r4(logloss(rows, k)) } : { n: 0 }; }
