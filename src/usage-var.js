// 4.13.0 usage-var-1: "it's not always the favourite who scores" (research / UI only; the live model and MODEL_VERSION are untouched).
// Walk-forward diagnosis (scripts/sim/surprise-diag.mjs on a top4-backtest DUMP, 2025 + 2026): both sims already split a team's TDs about as
// widely as real games do (share of real TDs from outside each team's top-1 / top-4 sim picks ~ the sims' own), so flattening the split
// was REJECTED by out-of-sample log loss. The calibration miss was the TEAM TD TOTAL (pbp2 ran ~20% short in 2026; the drive sim's per-game
// totals were too flat). The fix that won walk-forward on both seasons and both engines:
//  anchor - pilot each team's simulated offensive TDs to the model's pre-game TD budget (implied points x 0.7 / 6.9); 1 = full anchor, 0 = off.
// Kept as knobs (fitted, default OFF because walk-forward did not pick them):
//  tau    - tempering: a player's share of his team's TDs becomes share^tau (renormalised); < 1 flattens toward the depth chart.
//  kappa  - per-game usage randomness: the scorer split of each simulated game ~ Dirichlet(kappa * share); Infinity = fixed split.
export const DISP_VERSION = 'usage-var-1';
// 4.13.1: the user asked for the sims to be fully independent from the model again, so the anchor is OFF by default (0). It can still be
// switched on explicitly (disp: { drive: { anchor: 1 } }) for research; with data players (the free-mode default) there is no budget to pull to.
export const DISP_DEFAULT = { drive: { tau: 1, kappa: Infinity, anchor: 0 }, pbp: { tau: 1, kappa: Infinity, anchor: 0 } };
export function anchorFor(I, eng) { const d = I && I.disp; if (d === false) return 0; const o = (d && d[eng]) || DISP_DEFAULT[eng]; return o.anchor ?? DISP_DEFAULT[eng].anchor; }
// 4.13.1 data level (pbp only, model-free): pull the play-by-play sim's team TD count toward the drive data's own opponent-adjusted
// expectation (drives per game x TD share of drives from team-strength on real drives) - fixes its TD shortfall without any model number.
export function dataLevelFor(I, eng) { const d = I && I.disp; if (d === false) return 0; const o = (d && d[eng]) || DISP_DEFAULT[eng]; return o.dataLevel ?? DISP_DEFAULT[eng].dataLevel ?? 0; }
export function dispFor(I, eng) { const d = I && I.disp; if (d === false) return { tau: 1, kappa: Infinity }; const o = (d && d[eng]) || DISP_DEFAULT[eng]; return { tau: o.tau ?? 1, kappa: o.kappa ?? Infinity }; }
// tempered shares (sum 1) of non-negative weights
export function temper(w, tau) { const s0 = w.reduce((a, b) => a + (b > 0 ? b : 0), 0); if (!(s0 > 0)) return w.map(() => 0); if (tau === 1) return w.map(x => (x > 0 ? x / s0 : 0));
  const v = w.map(x => (x > 0 ? Math.pow(x / s0, tau) : 0)); const s = v.reduce((a, b) => a + b, 0); return v.map(x => x / s); }
// "surprise scorer" read-out from a run: P(at least one of the team's / game's TDs comes from outside the game's top 4 by anytime)
export function surprise(S, players, { top = 4, longshots = 3 } = {}) {
  const ord = players.map((p, i) => [p.anytime, p.j ?? i, i]).sort((a, b) => b[0] - a[0]); const topSet = new Set(ord.slice(0, top).map(x => x[1]));
  let any = 0, tdOut = 0, tdAll = 0; for (let g = 0; g < S.n; g++) { let hit = false; for (let j = 0; j < S.NP; j++) { const v = S.G.td[g * S.NP + j]; if (!v) continue; tdAll += v; if (!topSet.has(j)) { hit = true; tdOut += v; } } if (hit) any++; }
  const ls = ord.slice(top).map(([p, j, i]) => ({ j, name: players[i].name, team: players[i].team, pos: players[i].pos, p })).slice(0, longshots);
  return { top, pOutside: any / S.n, shareOutside: tdAll ? tdOut / tdAll : 0, longshots: ls }; }
