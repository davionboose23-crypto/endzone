// Small paired game-bootstrap (x1000; negative = the first forecast is better) for the live "with drive patterns vs
// without" scoreboard. Same method as scripts/hist/metrics.mjs pairedBoot, kept in src so the server can use it.
const cl = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
export function pairedBoot(rows, a, b, { B = 500, seed = 1 } = {}) {
  if (!rows.length) return null;
  const games = new Map(); for (const r of rows) { if (!games.has(r.gameId)) games.set(r.gameId, []); games.get(r.gameId).push(r); }
  const G = [...games.values()].map(rs => ({ n: rs.length, db: rs.reduce((s, r) => s + (r[a] - r.y) ** 2 - (r[b] - r.y) ** 2, 0), dl: rs.reduce((s, r) => s + (r.y ? -Math.log(cl(r[a])) + Math.log(cl(r[b])) : -Math.log(1 - cl(r[a])) + Math.log(1 - cl(r[b]))), 0) }));
  const tot = G.reduce((s, g) => ({ n: s.n + g.n, db: s.db + g.db, dl: s.dl + g.dl }), { n: 0, db: 0, dl: 0 });
  const R = rng(seed); const bs = [], ls = [];
  for (let i = 0; i < B; i++) { let n = 0, db = 0, dl = 0; for (let j = 0; j < G.length; j++) { const g = G[(R() * G.length) | 0]; n += g.n; db += g.db; dl += g.dl; } bs.push(db / n); ls.push(dl / n); }
  const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
  const k = x => Math.round(x * 1e6) / 1e3;
  return { n: tot.n, games: G.length, dBrier: k(tot.db / tot.n), dBrierCI: [k(q(bs, .025)), k(q(bs, .975))], dLogLoss: k(tot.dl / tot.n), dLogLossCI: [k(q(ls, .025)), k(q(ls, .975))] };
}
