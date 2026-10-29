// Calibration report for the anytime-TD model on every graded game (read-only; writes data/calibration-report.json).
// Rows: frozen pregame snapshots where they exist (prospective), otherwise reconstructed from earlier weeks.
// Usage: node scripts/calib-report.mjs [--week N]   (N = the week being forecast; grades weeks < N)
import fs from 'node:fs';
import { prepareData } from '../server/prepare.js';
import { buildIndex } from '../src/stats-index.js';
import { FileArchive } from '../server/file-archive.js';
import { calibrationState, withBlend } from '../server/jobs.js';
import { promotionDecision } from '../src/validation.js';
import { MODEL_VERSION } from '../src/model.js';
import { BLEND_KIND } from '../src/usage-model.js';
import { DRIVES_KIND } from '../src/drive-adjust.js';
import { bandKey } from '../src/research.js';
import { pairedBoot, brier, logloss, r4 } from './hist/metrics.mjs';
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : undefined; };
const A = await FileArchive.open(process.env.ENDZONE_ARCHIVE || 'archive');
const prep0 = await prepareData({});
const season = prep0.season;
const done = [...new Set(prep0.games.filter(g => g.season === season).map(g => g.week))].filter(w => prep0.games.filter(g => g.season === season && g.week === w).every(g => g.finished));
const week = arg('week') || Math.max(...done) + 1;
const prep = week === prep0.week ? prep0 : await prepareData({ season, week });
const ix = buildIndex(prep);
const cal = calibrationState(A, prep, ix, season, week);
const rows = withBlend(A, cal.graded, season).filter(r => r.chance > 0);
// game-bootstrap interval for a mean of y (or predicted) inside a subset
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function bootGap(R, k = 'chance', B = 1000) {
  const G = new Map(); for (const r of R) { const g = G.get(r.gameId) || { n: 0, y: 0, p: 0 }; g.n++; g.y += r.y; g.p += r[k]; G.set(r.gameId, g); }
  const gs = [...G.values()]; const R0 = rng(7); const hit = [], gap = [];
  for (let b = 0; b < B; b++) { let n = 0, y = 0, p = 0; for (let j = 0; j < gs.length; j++) { const g = gs[(R0() * gs.length) | 0]; n += g.n; y += g.y; p += g.p; } hit.push(y / n); gap.push((p - y) / n); }
  const q = (a, x) => { const s = a.slice().sort((u, v) => u - v); return s[Math.floor(x * (s.length - 1))]; };
  return { games: gs.length, hitCI: [q(hit, .025), q(hit, .975)], gapCI: [q(gap, .025), q(gap, .975)] };
}
const pct = x => r4(x * 100) / 1; const pp = x => Math.round(x * 1000) / 10;
function slice(R, k = 'chance') {
  if (!R.length) return { n: 0 };
  const pred = R.reduce((s, r) => s + r[k], 0) / R.length, act = R.reduce((s, r) => s + r.y, 0) / R.length; const b = bootGap(R, k);
  return { n: R.length, games: b.games, predPct: pp(pred), actualPct: pp(act), actualCI: b.hitCI.map(pp), gapPts: pp(pred - act), gapCI: b.gapCI.map(pp), hits: R.reduce((s, r) => s + r.y, 0), expected: r4(R.reduce((s, r) => s + r[k], 0)) };
}
const BUCKETS = [[0, .05], [.05, .1], [.1, .15], [.15, .2], [.2, .25], [.25, .3], [.3, .35], [.35, .45], [.45, .55], [.55, 1]];
const rel = (R, k) => BUCKETS.map(([lo, hi]) => ({ bucket: `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`, ...slice(R.filter(r => r[k] >= lo && r[k] < hi), k) }));
const ece = (R, k) => { const bs = rel(R, k); return pp(bs.reduce((s, b) => s + (b.n ? b.n / R.length * Math.abs(b.predPct - b.actualPct) / 100 : 0), 0)); };
const score = (R, k) => R.length ? { n: R.length, brier: r4(brier(R, k)), logLoss: r4(logloss(R, k)), ece: ece(R, k), gapPts: slice(R, k).gapPts } : { n: 0 };
const paired = (R, a, b) => { const x = pairedBoot(R, a, b); return { n: x.n, games: x.games, dBrierX1000: r4(x.dBrier * 1000), dBrierCI: x.dBrierCI.map(v => r4(v * 1000)), dLogLossX1000: r4(x.dLogLoss * 1000), dLogLossCI: x.dLogLossCI.map(v => r4(v * 1000)) }; };
function block(R, label) {
  const M = R.filter(r => r.published > 0 && r.blend > 0);
  const posK = r => (r.role === 'TE1' ? 'TE1' : r.pos === 'TE' ? 'TE other' : r.pos);
  const groups = (f) => { const o = {}; for (const r of R) { const k = f(r); (o[k] = o[k] || []).push(r); } return Object.fromEntries(Object.entries(o).sort().map(([k, v]) => [k, slice(v)])); };
  const byWeek = groups(r => `w${r.week}`);
  const last2 = Math.max(...R.map(r => r.week)) - 1;
  return { label, n: R.length, games: new Set(R.map(r => r.gameId)).size, weeks: [...new Set(R.map(r => r.week))].sort((a, b) => a - b),
    reliability: rel(R, 'chance'),
    scores: { model: score(M, 'chance'), sleeper: score(M, 'published'), blend3: score(M, 'blend'), modelAllRows: score(R, 'chance') },
    paired: { modelMinusSleeper: paired(M, 'chance', 'published'), blend3MinusModel: paired(M, 'blend', 'chance'), blend3MinusSleeper: paired(M, 'blend', 'published') },
    byPosition: groups(posK), byBand: groups(r => bandKey(r.chance)), byWeek,
    recentVsSeason: { recent2Weeks: slice(R.filter(r => r.week >= last2)), earlier: slice(R.filter(r => r.week < last2)) },
    te1Blend: slice(R.filter(r => r.role === 'TE1' && r.blend > 0), 'blend'), te1Sleeper: slice(R.filter(r => r.role === 'TE1' && r.published > 0), 'published') };
}
const prosp = rows.filter(r => r.prospective);
const gatePairs = cal.graded.filter(r => r.challenger != null);
const promo = promotionDecision(gatePairs, { modelVersion: MODEL_VERSION, kind: BLEND_KIND });
const dPairs = cal.graded.filter(r => r.blendDrives != null).map(r => ({ ...r, challenger: r.blendDrives, challengerKind: DRIVES_KIND }));
const dPromo = promotionDecision(dPairs, { modelVersion: MODEL_VERSION, kind: DRIVES_KIND });
const cnt = P => ({ players: P.length, games: new Set(P.map(r => r.gameId)).size });
const gate = { modelVersion: MODEL_VERSION, need: { players: 500, games: 40 },
  blend3: { ...cnt(gatePairs.filter(r => r.modelVersion === MODEL_VERSION && r.prospective && r.challengerKind === BLEND_KIND)), promote: promo.promote, reasons: promo.reasons },
  blend3Drives: { ...cnt(dPairs.filter(r => r.modelVersion === MODEL_VERSION && r.prospective)), promote: dPromo.promote, reasons: dPromo.reasons } };
const out = { ranAt: new Date().toISOString(), season, gradedThroughWeek: week - 1, modelVersion: MODEL_VERSION, activeLessons: cal.active,
  prospective: block(prosp, 'frozen pregame snapshots (prospective)'), all: block(rows, 'all graded games (weeks without snapshots reconstructed from earlier weeks)'), gate };
fs.writeFileSync(process.env.OUT || 'data/calibration-report.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
