// Walk-forward evaluation of the stacked calibration: for season S week w, fit ONLY on rows from
// earlier seasons and earlier weeks of S (whole games, since a week's games are all excluded),
// then run the full engine (safety caps + team budget after stacking) for week w.
import fs from 'node:fs';
import { loadSeason, gradeWeek } from './build.mjs';
import { fitStack, stackX } from '../../src/stack.js';
import { fitBudget } from '../../src/calibration.js';
export { fitBudget };
const season = Number(process.argv[2]); const tag = process.argv[3] || 'stack'; const cfg = Object.assign({ stack: true, budget: false, l2: 2 }, JSON.parse(process.argv[4] || '{}')); const l2 = cfg.l2;
const rawOf = s => (fs.existsSync(`data/hist/raw-${s}.json`) ? JSON.parse(fs.readFileSync(`data/hist/raw-${s}.json`)) : []);
const prior = [2024, 2025, 2026].filter(s => s < season).flatMap(rawOf); const cur = rawOf(season);
const toXY = rows => ({ X: rows.map(r => stackX({ pre: r.preStack, pub: r.published, pos: r.pos, glShare: r.glShareRaw, insideFinisher: r.insideFinisher, games: r.gamesPlayed, spread: r.spread, implied: r.implied })), y: rows.map(r => r.y) });
const S = await loadSeason(season);
const last = Math.max(...S.prep.games.filter(g => g.season === season && g.finished).map(g => g.week));
const out = []; const fits = {};
for (let w = 1; w <= last; w++) {
  const train = prior.concat(cur.filter(r => r.week < w));
  let fit = null; const opts = { ...(cfg.opts || {}) };
  if (cfg.stack && train.length >= 500) { const { X, y } = toXY(train); fit = { ...fitStack(X, y, { l2 }), id: `${season}-w${w}-n${train.length}` }; fits[w] = fit; opts.stackFit = fit; }
  if (cfg.budget) { const bf = fitBudget(train); if (bf) opts.budgetFit = bf; }
  opts.trendHistory = out.map(r => ({ id: r.id, week: r.week, chance: r.chance, y: r.y }));
  out.push(...gradeWeek(S, w, opts).map(r => ({ ...r, stackUsed: !!fit })));
}
fs.writeFileSync(`data/hist/${tag}-${season}.json`, JSON.stringify(out));
fs.writeFileSync(`data/hist/${tag}-fits-${season}.json`, JSON.stringify(fits));
console.log(season, tag, 'rows', out.length, 'stacked weeks', Object.keys(fits).length, 'last fit beta', fits[last]?.beta.map(b => b.toFixed(3)).join(' '));
