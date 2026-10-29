// Walk-forward test of the learned band-scale rule (src/research.js weeklyLesson/activeLessons) and variants.
// For target week w, lessons come ONLY from lesson-free reconstructed rows of earlier weeks of the same season,
// then the full engine (caps, budget, pub blend) is re-run for week w with those lessons. Paired game-bootstrap vs current rule.
// Usage: node scripts/hist/lesson-walk.mjs 2026 [2025 ...]
import fs from 'node:fs';
import { loadSeason, prepAtWeek } from './build.mjs';
import { runEngine } from '../../src/engine.js';
import { gradeGame } from '../../src/grading.js';
import { weeklyLesson, bandKey } from '../../src/research.js';
import { pairedBoot, brier, logloss, r4 } from './metrics.mjs';
import { clamp } from '../../src/model.js';
const seasons = process.argv.slice(2).map(Number).filter(Boolean); if (!seasons.length) seasons.push(2026);
const BB = { lt15: [0.8, 1.15], '15to25': [0.8, 1.15], '25to35': [0.8, 1.15], '35to50': [0.45, 1.05], '50plus': [0.8, 1.08] };
function run(S, w, lessons) {
  const pw = prepAtWeek(S, w); const res = runEngine(pw, { ix: S.ix, week: w, now: Date.now(), lessons });
  const out = [];
  for (const G of res.games) { if (!G.game.finished) continue; const callIds = { away: G.sides.away.call?.id, home: G.sides.home.call?.id };
    for (const s of ['away', 'home']) for (const r of gradeGame(S.ix, G.game, G.sides[s].players, { prospective: false, callIds })) if (r.actual.status === 'confirmed' || r.actual.status === 'confirmed-zero') out.push({ ...r, y: r.actual.td > 0 ? 1 : 0 }); }
  return out;
}
// band scale for one week of rows with prior strength k (k=3 is the shipped rule)
const bandOf = (rows, k) => Object.fromEntries(Object.entries(BB).map(([b, bd]) => { const g = rows.filter(r => bandKey(r.chance) === b && !(b === '35to50' && r.insideFinisher)); const h = g.filter(r => r.y).length, e = g.reduce((s, r) => s + r.chance, 0); return [b, g.length ? clamp((h + k) / (e + k), ...bd) : 1]; }));
const CFG = {
  off: null,
  current: { k: 3, win: 3, pooled: false },
  bandOff: { k: 3, win: 3, pooled: false, noBand: true },
  k10: { k: 10, win: 3, pooled: false },
  k25: { k: 25, win: 3, pooled: false },
  pooled3k10: { k: 10, win: 3, pooled: true },
  pooledAllk10: { k: 10, win: 99, pooled: true },
  pooledAllk25: { k: 25, win: 99, pooled: true },
};
const result = { ranAt: new Date().toISOString(), seasons: {}, note: 'Reconstructed walk-forward (point-in-time rosters, no pregame injuries). Lessons built only from earlier weeks of the same season.' };
const pooledAll = {};
for (const season of seasons) {
  const S = await loadSeason(season);
  const last = Math.max(...S.prep.games.filter(g => g.season === season && g.finished).map(g => g.week));
  const free = {}; for (let w = 1; w <= last; w++) free[w] = run(S, w, null);
  const L = {}; for (let w = 1; w <= last; w++) L[w] = weeklyLesson(free[w], { season, week: w });
  const rows = {}; for (const c of Object.keys(CFG)) rows[c] = [];
  for (let w = 2; w <= last; w++) {
    for (const [c, cfg] of Object.entries(CFG)) {
      let lessons = null;
      if (cfg) {
        const ws = [w - 1, w - 2, w - 3].filter(x => x >= 1);
        const pick = (x, grp, key) => (L[x]?.applied ? L[x][grp][key] ?? 1 : 1);
        lessons = { vol: {}, band: {}, spot: {} };
        for (const grp of ['vol', 'spot']) for (const key of Object.keys(L[1][grp])) lessons[grp][key] = [w - 1, w - 2, w - 3].reduce((s, x) => s + (x >= 1 ? pick(x, grp, key) : 1), 0) / 3;
        if (cfg.noBand) for (const b of Object.keys(BB)) lessons.band[b] = 1;
        else if (cfg.pooled) { const span = Array.from({ length: Math.min(cfg.win, w - 1) }, (_, i) => w - 1 - i); lessons.band = bandOf(span.flatMap(x => free[x]), cfg.k); }
        else { const per = [w - 1, w - 2, w - 3].map(x => (x >= 1 ? bandOf(free[x], cfg.k) : null)); for (const b of Object.keys(BB)) lessons.band[b] = per.reduce((s, p) => s + (p ? p[b] : 1), 0) / 3; }
      }
      const R = c === 'off' ? free[w] : run(S, w, lessons);
      rows[c].push(...R.map(r => ({ gameId: r.gameId, id: r.id, week: w, y: r.y, p: r.chance, pos: r.pos, role: r.role })));
    }
    process.stderr.write(`${season} w${w} done\n`);
  }
  const key = r => `${r.gameId}|${r.id}`; const base = new Map(rows.current.map(r => [key(r), r]));
  const sum = {};
  for (const c of Object.keys(CFG)) {
    const P = rows[c].filter(r => base.has(key(r))).map(r => ({ ...r, cur: base.get(key(r)).p }));
    const b = pairedBoot(P, 'p', 'cur'); const gap = (P.reduce((s, r) => s + r.p - r.y, 0) / P.length) * 100;
    sum[c] = { n: P.length, games: b.games, brier: r4(brier(P, 'p')), logLoss: r4(logloss(P, 'p')), gapPts: r4(gap), vsCurrent: { dBrierX1000: r4(b.dBrier * 1000), dBrierCI: b.dBrierCI.map(v => r4(v * 1000)), dLogLossX1000: r4(b.dLogLoss * 1000), dLogLossCI: b.dLogLossCI.map(v => r4(v * 1000)) } };
    (pooledAll[c] = pooledAll[c] || []).push(...P);
  }
  result.seasons[season] = { weeks: `2-${last}`, configs: sum };
  console.error(season, JSON.stringify(sum, null, 0));
}
if (seasons.length > 1) { result.pooled = {}; for (const [c, P] of Object.entries(pooledAll)) { const b = pairedBoot(P, 'p', 'cur'); result.pooled[c] = { n: P.length, games: b.games, brier: r4(brier(P, 'p')), logLoss: r4(logloss(P, 'p')), vsCurrent: { dBrierX1000: r4(b.dBrier * 1000), dBrierCI: b.dBrierCI.map(v => r4(v * 1000)), dLogLossX1000: r4(b.dLogLoss * 1000), dLogLossCI: b.dLogLossCI.map(v => r4(v * 1000)) } }; } }
fs.writeFileSync('data/lesson-walk.json', JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
