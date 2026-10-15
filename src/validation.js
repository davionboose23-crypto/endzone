// Shadow statistical challenger (regularized logistic calibration), promotion gates,
// and held-out volume error ranges. Training uses earlier weeks only.
import { brier, logLoss, ece } from './evaluation.js';
const logit = p => { const q = Math.min(0.999, Math.max(0.001, p)); return Math.log(q / (1 - q)); };
const sigm = z => 1 / (1 + Math.exp(-z));
export const BASIC_MIN = 200, RICH_MIN = 500;
export function features(r, rich) {
  const lam = r.lambda || 0; const out = lam > 0 ? ((r.components?.r0 || 0) + (r.components?.t0 || 0)) / lam : 0;
  const base = [logit(r.chance), r.pos === 'RB' ? 1 : 0, r.pos === 'WR' ? 1 : 0, r.pos === 'TE' ? 1 : 0, r.insideFinisher ? 1 : 0, (r.tags || []).includes('Goal-line role') ? 1 : 0, (r.tags || []).includes('Recurring scorer') ? 1 : 0, out, r.coldGoal ? 1 : 0];
  if (!rich) return base;
  return [...base, base[4] * base[0], (r.matchupFactor || 1) - 1, r.scriptSensitive ? 1 : 0, r.avail?.uncertain ? 1 : 0];
}
// L2-regularized logistic regression by Newton/IRLS with per-game equal weighting.
export function fitLogistic(rows, { lambda = 2, rich = false } = {}) {
  const X = rows.map(r => features(r, rich)); const y = rows.map(r => r.y);
  const games = new Map(); rows.forEach(r => games.set(r.gameId, (games.get(r.gameId) || 0) + 1));
  const w = rows.map(r => 1 / games.get(r.gameId)); const wsum = w.reduce((a, b) => a + b, 0); const wn = w.map(v => v * rows.length / wsum);
  const d = X[0].length; const mu = Array(d).fill(0), sd = Array(d).fill(1);
  if (rich) for (let j = 1; j < d; j++) { const col = X.map(x => x[j]); const m = col.reduce((a, b) => a + b, 0) / col.length; const s = Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length) || 1; mu[j] = m; sd[j] = s; }
  const Z = X.map(x => [1, ...x.map((v, j) => (v - mu[j]) / sd[j])]);
  let beta = Array(d + 1).fill(0); beta[1] = 1; // start at identity calibration on logit(base)
  for (let it = 0; it < 25; it++) {
    const g = Array(d + 1).fill(0), H = Array.from({ length: d + 1 }, () => Array(d + 1).fill(0));
    Z.forEach((z, i) => { const p = sigm(z.reduce((s, v, j) => s + v * beta[j], 0)); const r = (p - y[i]) * wn[i]; const ww = p * (1 - p) * wn[i]; for (let a = 0; a <= d; a++) { g[a] += r * z[a]; for (let b = 0; b <= d; b++) H[a][b] += ww * z[a] * z[b]; } });
    for (let a = 1; a <= d; a++) { const prior = a === 1 ? 1 : 0; g[a] += lambda * (beta[a] - prior); H[a][a] += lambda; }
    const step = solve(H, g); if (!step) break; beta = beta.map((b, j) => b - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return { beta, mu, sd, rich, n: rows.length, games: games.size };
}
function solve(A, b) { const n = b.length; const M = A.map((r, i) => [...r, b[i]]); for (let i = 0; i < n; i++) { let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k; [M[i], M[p]] = [M[p], M[i]]; if (Math.abs(M[i][i]) < 1e-12) return null; for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; } } return M.map((r, i) => r[n] / r[i]); }
export function predictLogistic(fit, r) { const x = features(r, fit.rich); const z = [1, ...x.map((v, j) => (v - fit.mu[j]) / fit.sd[j])]; return sigm(z.reduce((s, v, j) => s + v * fit.beta[j], 0)); }

// Train only on weeks strictly before the target week; whole games stay together.
export function trainChallenger(gradedRows, { season, week, modelVersion }) {
  const train = gradedRows.filter(r => r.season < season || (r.season === season && r.week < week));
  const complete = train.filter(r => r.components && r.lambda != null);
  const status = { trainingCount: train.length, cutoff: { season, week, rule: 'weeks strictly before target week' }, modelVersion, fit: null, provisional: true, reason: null };
  if (complete.length < BASIC_MIN) { status.reason = `Needs ${BASIC_MIN} earlier graded results; have ${complete.length}.`; return status; }
  status.fit = fitLogistic(complete, { rich: complete.length >= RICH_MIN, lambda: complete.length >= RICH_MIN ? 4 : 2 });
  status.kind = status.fit.rich ? 'rich' : 'basic';
  return status;
}
// Apply only when training cutoff precedes kickoff; reapply safety ceiling.
export function challengerProbability(status, r, kickoffIso, cutoffIso) {
  if (!status?.fit) return null;
  if (cutoffIso && kickoffIso && !(new Date(cutoffIso) < new Date(kickoffIso))) return null;
  const p = predictLogistic(status.fit, r);
  const ceiling = r.recentFinisher ? 0.62 : r.coldGoal ? 0.46 : 0.5;
  return Math.min(p, Math.max(ceiling, Math.min(r.chance, 0.62)));
}

// Promotion gates; returns explicit reasons when withheld.
export function promotionDecision(pairs, { modelVersion } = {}) {
  const P = pairs.filter(x => x.modelVersion === modelVersion && x.prospective && x.challenger != null);
  const games = new Set(P.map(x => x.gameId));
  const reasons = []; const m = { paired: P.length, games: games.size };
  if (P.length < 500) reasons.push(`Needs ≥500 prospective paired players for ${modelVersion}; have ${P.length}.`);
  if (games.size < 40) reasons.push(`Needs ≥40 games; have ${games.size}.`);
  if (P.length) {
    const champ = P.map(x => ({ p: x.chance, y: x.y })), chal = P.map(x => ({ p: x.challenger, y: x.y }));
    m.champion = { brier: brier(champ), logLoss: logLoss(champ), ece: ece(champ) }; m.challenger = { brier: brier(chal), logLoss: logLoss(chal), ece: ece(chal) };
    // game-clustered SE of Brier difference
    const byG = new Map(); for (const x of P) { const d = (x.challenger - x.y) ** 2 - (x.chance - x.y) ** 2; const g = byG.get(x.gameId) || { s: 0, n: 0 }; g.s += d; g.n++; byG.set(x.gameId, g); }
    const gd = [...byG.values()].map(g => g.s / g.n); const md = gd.reduce((a, b) => a + b, 0) / gd.length; const se = gd.length > 1 ? Math.sqrt(gd.reduce((a, b) => a + (b - md) ** 2, 0) / (gd.length - 1) / gd.length) : Infinity;
    m.brierDiff = md; m.interval = [md - 1.96 * se, md + 1.96 * se];
    if (!(m.interval[1] < 0)) reasons.push('Brier improvement not beyond game-level sampling uncertainty.');
    if (!(m.challenger.logLoss < m.champion.logLoss)) reasons.push('Log loss not lower.');
    if (m.challenger.ece > m.champion.ece + 0.005) reasons.push('Calibration error worse than tolerance .005.');
    m.protected = {};
    for (const [k, f] of [['teamCalls', x => x.teamCall], ['highTd', x => x.tdConf === 'High'], ['contributors', x => x.contributor]]) {
      const g = P.filter(f); const cb = brier(g.map(x => ({ p: x.chance, y: x.y }))), hb = brier(g.map(x => ({ p: x.challenger, y: x.y })));
      m.protected[k] = { n: g.length, champion: cb, challenger: hb };
      if (g.length >= 80 && hb > cb + 0.002) reasons.push(`Material regression for ${k}.`);
      if (g.length < 80) m.protected[k].note = 'Fewer than 80: tolerance check not decisive.';
    }
  }
  return { promote: reasons.length === 0, reasons, metrics: m, rollback: 'Champion retained; challenger stays shadow.', note: 'A new version is never labeled validated because an older version passed.' };
}

// Volume error model from held-out ranges saved before outcomes.
export function volumeErrorModel(gradedPrognostic) {
  const out = {}, coverage = {};
  for (const m of ['rushYd', 'rec', 'recYd', 'passYd']) {
    const rows = gradedPrognostic.filter(r => r.volume?.[m]?.mean != null && r.actual?.[m] != null && (m !== 'passYd' || r.pos === 'QB'));
    const res = g => { const e = g.map(r => r.actual[m] - r.volume[m].mean); const mu = e.reduce((a, b) => a + b, 0) / (e.length || 1); return Math.sqrt(e.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, e.length - 1)); };
    const sdAll = rows.length ? res(rows) : null; out[m] = {}; coverage[m] = {};
    const segs = {}; for (const r of rows) (segs[r.segment] = segs[r.segment] || []).push(r);
    for (const [s, g] of Object.entries(segs)) { const sd = res(g); out[m][s] = { n: g.length, sd: (g.length * sd + 30 * (sdAll || sd)) / (g.length + 30), meanPred: g.reduce((a, r) => a + r.volume[m].mean, 0) / g.length }; const c = g.filter(r => r.volume[m].lo != null && r.actual[m] >= r.volume[m].lo && r.actual[m] <= r.volume[m].hi).length / g.length; if (g.length >= 20) coverage[m][s] = c; }
    const highs = rows.filter(r => r.volConf?.[m] === 'High'); if (highs.length >= 20) coverage[m].overall = highs.filter(r => r.actual[m] >= r.volume[m].lo && r.actual[m] <= r.volume[m].hi).length / highs.length;
  }
  return { errorModel: out, coverage };
}
