// Tuesday re-evaluation of the trends agent's families (endzone-4.4).
// Walk-forward on the current season, never selecting on the test set: for each finished week wk, a family's weight
// is chosen from {0, grid} using only data before wk (the committed 2024-25 training table + current-season weeks < wk),
// and that choice's predictions for wk are the held-out result. A family is enabled for the next week only if its
// held-out effect is not harmful beyond noise (game-bootstrap 95% lower bounds ≤ 0 for Brier and log loss), it improves
// Brier or log loss on the point estimate, team calls and contributors do not regress, and ≥40 games were evaluated.
// The next-week weight is then re-chosen with all data through the last finished week (2026 included in training).
import { pairedBoot, r4, cl } from './hist/metrics.mjs';
const llSum = rs => -rs.reduce((s, r) => s + (r.y ? Math.log(cl(r.chance)) : Math.log(1 - cl(r.chance))), 0);
export function chooseWeight(train, fam, grid, cur, baseRows, uptoWeek) {
  // cumulative log-loss change vs weight 0: prior seasons (mean Δ × n) + current-season weeks < uptoWeek
  let best = 0, bestScore = 0;
  for (const w of grid) {
    let s = (train?.dLogLoss?.[fam]?.[w] ?? 0) * (train?.n ?? 0);
    for (let k = 1; k < uptoWeek; k++) if (cur[w][k] && baseRows[k]) s += llSum(cur[w][k]) - llSum(baseRows[k]);
    if (s < bestScore) { bestScore = s; best = w; }
  }
  return best;
}
export function trendGate(S, full, gradeWeek, TW, { families = ['snap', 'usage', 'redzone', 'qbRush', 'streak', 'defense', 'miss'], grid = [0.1, 0.25, 0.5], log = () => {} } = {}) {
  const zero = Object.fromEntries(families.map(f => [f, 0]));
  const baseRows = {}; const hist = [];
  for (let wk = 1; wk <= full; wk++) { const opts = { volCal: false, caps: null, trendWeights: zero, trendHistory: hist.slice() }; baseRows[wk] = gradeWeek(S, wk, opts).filter(r => r.y != null); hist.push(...baseRows[wk].map(r => ({ id: r.id, week: r.week, chance: r.chance, y: r.y }))); }
  const histAt = wk => hist.filter(r => r.week < wk);
  const out = {}; const weights = {};
  for (const f of families) {
    const cur = {}; for (const w of grid) { cur[w] = {}; for (let wk = 1; wk <= full; wk++) cur[w][wk] = gradeWeek(S, wk, { volCal: false, caps: null, trendWeights: { ...zero, [f]: w }, trendHistory: histAt(wk) }).filter(r => r.y != null); }
    const choices = {}; const rows = [];
    for (let wk = 1; wk <= full; wk++) {
      const w = chooseWeight(TW.training, f, grid, cur, baseRows, wk); choices[wk] = w;
      const m = new Map((w ? cur[w][wk] : baseRows[wk]).map(r => [`${r.gameId}|${r.id}`, r.chance]));
      for (const r of baseRows[wk]) if (r.published != null) rows.push({ ...r, cand: m.get(`${r.gameId}|${r.id}`) ?? r.chance });
    }
    const bt = rs => { if (!rs.length) return null; const b = pairedBoot(rs, 'cand', 'chance'); return { n: b.n, games: b.games, dBrier: r4(b.dBrier), dBrierCI: b.dBrierCI.map(r4), dLogLoss: r4(b.dLogLoss), dLogLossCI: b.dLogLossCI.map(r4), dBrierRaw: b.dBrier, dLogLossRaw: b.dLogLoss, dBrierLo: b.dBrierCI[0], dLogLossLo: b.dLogLossCI[0] }; };
    const ev = { all: bt(rows), teamCalls: bt(rows.filter(r => r.teamCall)), contributors: bt(rows.filter(r => r.contributor)) };
    const reasons = [];
    if (!ev.all || ev.all.games < 40) reasons.push(`needs ≥40 finished games (have ${ev.all?.games ?? 0})`);
    else {
      if (ev.all.dBrierLo > 0 || ev.all.dLogLossLo > 0) reasons.push('harmful beyond noise');
      if (!(ev.all.dBrierRaw < 0 || ev.all.dLogLossRaw < 0)) reasons.push('no improvement in Brier or log loss');
      if (ev.teamCalls && ev.teamCalls.dBrierRaw > 0) reasons.push(`team calls regress (${ev.teamCalls.dBrier})`);
      if (ev.contributors && ev.contributors.dBrierRaw > 0) reasons.push(`contributors regress (${ev.contributors.dBrier})`);
    }
    const next = chooseWeight(TW.training, f, grid, cur, baseRows, full + 1);
    const enabled = reasons.length === 0 && next > 0;
    if (reasons.length === 0 && !next) reasons.push('passes held-out, but the weight chosen with all data is 0');
    weights[f] = enabled ? next : 0;
    for (const k of Object.keys(ev)) if (ev[k]) for (const x of ['dBrierRaw', 'dLogLossRaw', 'dBrierLo', 'dLogLossLo']) delete ev[k][x];
    out[f] = { enabled, weight: weights[f], nextWeekChoice: next, heldOutChoices: choices, evaluation: ev, reason: enabled ? `passed: ΔBrier ${ev.all.dBrier} [${ev.all.dBrierCI}], Δlog loss ${ev.all.dLogLoss} [${ev.all.dLogLossCI}]` : `off: ${reasons.join('; ')}` };
    log(f, out[f].reason);
  }
  return { families: out, weights, throughWeek: full };
}
