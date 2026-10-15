// Stacked calibration (the spec's statistical challenger, promoted by user request after
// walk-forward validation): regularized logistic regression on the model's own pre-safety
// chance, Sleeper's published TD probability, and role/game features. Safety caps and the team
// budget are applied AFTER this step by the pipeline, so all invariants still hold.
const logit = p => { const q = Math.min(0.995, Math.max(0.005, p)); return Math.log(q / (1 - q)); };
export const STACK_FEATURES = ['bias', 'lmodel', 'hasPub', 'lpub', 'RB', 'WR', 'TE', 'glShare', 'finisher', 'thin', 'spread', 'implied'];
export function stackX({ pre, pub, pos, glShare = 0, insideFinisher = false, games = 0, spread = 0, implied = 22 }) {
  const has = pub != null && pub > 0;
  return [1, logit(pre), has ? 1 : 0, has ? logit(pub) - logit(pre) : 0, pos === 'RB' || pos === 'FB' ? 1 : 0, pos === 'WR' ? 1 : 0, pos === 'TE' ? 1 : 0,
    Math.min(1, glShare || 0), insideFinisher ? 1 : 0, games < 3 ? 1 : 0, Math.max(-2, Math.min(2, (spread || 0) / 7)), Math.max(-1, Math.min(1, ((implied || 22) - 22) / 8))];
}
export function stackPredict(fit, x) { let z = 0; for (let i = 0; i < x.length; i++) z += (fit.beta[i] || 0) * x[i]; return 1 / (1 + Math.exp(-z)); }
// IRLS-free gradient fit with L2 (not on bias); prior centre: identity on model logit.
export function fitStack(X, y, { l2 = 2, iters = 400 } = {}) {
  const d = X[0].length; const beta = new Array(d).fill(0); beta[1] = 1;
  const prior = beta.slice(); const n = X.length;
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0); const H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < n; i++) { const x = X[i]; let z = 0; for (let j = 0; j < d; j++) z += beta[j] * x[j]; const p = 1 / (1 + Math.exp(-z)); const w = p * (1 - p); const e = p - y[i];
      for (let j = 0; j < d; j++) { g[j] += e * x[j]; for (let k = j; k < d; k++) H[j][k] += w * x[j] * x[k]; } }
    for (let j = 0; j < d; j++) { for (let k = 0; k < j; k++) H[j][k] = H[k][j]; if (j > 0) { g[j] += l2 * (beta[j] - prior[j]); H[j][j] += l2; } }
    const step = solve(H, g); let mx = 0; for (let j = 0; j < d; j++) { beta[j] -= step[j]; mx = Math.max(mx, Math.abs(step[j])); }
    if (mx < 1e-7) break;
  }
  return { beta, n, features: STACK_FEATURES };
}
function solve(A, b) { const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const v = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / v; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; } }
  return M.map((r, i) => r[n] / (r[i] || 1e-12)); }
