// Held-out earlier-week folds for the adaptive published-projection blend.
// For each target week w, the blend maximum is chosen ONLY on weeks < w, then scored on week w.
// All predictions are reconstructed from earlier-week features (not prospective snapshots).
import fs from 'node:fs';
import { prepareData } from '../server/prepare.js';
import { buildIndex } from '../src/stats-index.js';
import { runEngine } from '../src/engine.js';
import { gradeGame } from '../src/grading.js';
const GRID = [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1];
const prep = await prepareData({});
const ix = buildIndex(prep); const season = prep.season;
const weeks = [...new Set(prep.games.filter(g => g.season === season && g.finished).map(g => g.week))].sort((a, b) => a - b);
const rowsBy = {}; // a -> week -> rows
for (const a of GRID) { rowsBy[a] = {};
  for (const w of weeks) {
    const res = runEngine(prep, { ix, week: w, lessons: null, pubTdBlend: a, now: Date.now() });
    const rows = [];
    for (const G of res.games) if (G.game.finished) rows.push(...gradeGame(ix, G.game, [...G.sides.away.players, ...G.sides.home.players], { prospective: false, callIds: {} }));
    rowsBy[a][w] = rows.filter(r => (r.actual.status === 'confirmed' || r.actual.status === 'confirmed-zero') && r.published != null && r.chance != null)
      .map(r => ({ id: r.id, gameId: r.gameId, p: r.chance, pub: r.published, y: r.actual.td > 0 ? 1 : 0 }));
  } }
const cl = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
const m = (rows, k) => rows.length ? { n: rows.length, brier: rows.reduce((s, r) => s + (r[k] - r.y) ** 2, 0) / rows.length, logLoss: -rows.reduce((s, r) => s + (r.y ? Math.log(cl(r[k])) : Math.log(1 - cl(r[k]))), 0) / rows.length } : null;
const folds = []; const pooled = { before: [], after: [] };
for (const w of weeks.slice(1)) {
  const train = weeks.filter(x => x < w);
  const score = a => m(train.flatMap(x => rowsBy[a][x]), 'p').brier;
  const best = GRID.reduce((b, a) => (score(a) < score(b) ? a : b), GRID[0]);
  const before = rowsBy[0][w], after = rowsBy[best][w];
  pooled.before.push(...before); pooled.after.push(...after);
  folds.push({ heldOutWeek: w, trainWeeks: train, chosenMax: best, before: m(before, 'p'), after: m(after, 'p'), published: m(before, 'pub') });
}
const r4 = o => o && { n: o.n, brier: +o.brier.toFixed(4), logLoss: +o.logLoss.toFixed(4) };
const out = { ranAt: new Date().toISOString(), season, note: 'Reconstructed predictions (earlier-week features, closing lines, no pregame injury info); matched rows with a published projection; blend max chosen on prior weeks only.',
  grid: GRID, folds: folds.map(f => ({ ...f, before: r4(f.before), after: r4(f.after), published: r4(f.published) })),
  pooled: { before: r4(m(pooled.before, 'p')), after: r4(m(pooled.after, 'p')), published: r4(m(pooled.before, 'pub')) },
  inSampleByMax: Object.fromEntries(GRID.map(a => [a, r4(m(weeks.flatMap(w => rowsBy[a][w]), 'p'))])) };
fs.writeFileSync(new URL('../data/blend-folds.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
