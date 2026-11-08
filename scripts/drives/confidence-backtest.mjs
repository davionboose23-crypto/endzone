// Retrospective 2026 walk-forward reliability audit. No fitting or engine inputs.
// Predict weeks 4–8 using only earlier weeks. Condition evaluation on recorded
// target/carry involvement in the target game (no snap-only participation feed).
import fs from 'node:fs';
import { firstDriveForecast, prepareFirstDriveContext } from '../../src/first-drive.js';
import { driveEstimateConfidence } from '../../src/drive-board.js';
const rate = (a, hit) => a.reduce((s, g) => s + +hit(g), 0) / a.length;
// Frozen v4.24.8 rule, retained verbatim for an honest same-prediction comparison.
export function legacyConfidence(F, hit, probability, td = false) {
  const games = F.games, n = games.length;
  if (!n || !Number.isFinite(probability)) return { level: 'Low' };
  const hits = games.reduce((s, g) => s + +hit(g), 0);
  const recent = games.slice(-3), previous = games.slice(-6, -3);
  const shift = previous.length ? Math.abs(rate(recent, hit) - rate(previous, hit)) : 1;
  const shrinkage = Math.abs(probability - hits / n);
  const high = n >= (td ? 10 : 7) && hits >= (td ? 3 : 2) && previous.length === 3 && shift <= .25 && shrinkage <= .10 && (!td || (F.offense.n >= 7 && F.defense.n >= 7));
  const medium = n >= (td ? 6 : 4) && hits >= 1 && previous.length >= 1 && shift <= .50 && shrinkage <= .20 && (!td || (F.offense.n >= 4 && F.defense.n >= 4));
  return { level: high ? 'High' : medium ? 'Med' : 'Low' };
}
export function metrics(rows) {
  const n = rows.length; if (!n) return { n: 0 };
  const predicted = rows.reduce((s, r) => s + r.p, 0) / n, actual = rows.reduce((s, r) => s + r.y, 0) / n;
  const bins = Array.from({ length: 5 }, () => []);
  for (const r of rows) bins[Math.min(4, Math.floor(r.p * 5))].push(r);
  const ece = bins.reduce((s, b) => s + (b.length ? Math.abs(b.reduce((s, r) => s + r.p - r.y, 0)) / n : 0), 0);
  return { n, predicted, actual, calibrationGap: predicted - actual, absGap: Math.abs(predicted - actual), ece,
    brier: rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / n };
}
export function backtest(D, weeks = [4, 5, 6, 7, 8]) {
  const rows = [];
  for (const week of weeks) {
    const train = { ...D, week }, context = prepareFirstDriveContext(train);
    for (const [team, T] of Object.entries(D.teams)) for (const g of T.games.filter(g => g.w === week)) {
      const first = g.d.find(d => d[0] === 1); if (!first) continue;
      const active = new Set(g.d.flatMap(d => (d[8] || []).map(r => r[0])));
      for (const i of active) {
        const person = T.people[i]; if (!person) continue;
        const player = { gsis: person[0], id: person[3], pos: person[2], name: person[1], team, opp: g.opp };
        const F = firstDriveForecast(train, player, g.opp, context); if (!F?.games.length) continue;
        if (F.games.some(g => g.week >= week)) throw new Error('Future-week leakage');
        const r = (first[8] || []).find(r => r[0] === i) || [i, 0, 0, 0, 0, 0, 0, 0];
        const actual = { touches: r[2] + r[4], rushYards: r[5], recYards: r[3], playerTd: r[7] };
        const specs = [
          ['touch', F.prediction.touch, g => g.touches > 0],
          ['rush5', F.yardage.outcomes.find(o => o.key === 'rush5').probability, g => g.rushYards >= 5],
          ['rec5', F.yardage.outcomes.find(o => o.key === 'rec5').probability, g => g.recYards >= 5],
          ['td', F.prediction.playerTd, g => g.playerTd > 0],
        ];
        for (const [metric, p, hit] of specs) rows.push({ week, game: `${week}|${[team, g.opp].sort().join('-')}`, player: person[0], metric, p, y: +hit(actual),
          old: legacyConfidence(F, hit, p, metric === 'td').level,
          next: driveEstimateConfidence(F, hit, p, metric === 'td', metric).level });
      }
    }
  }
  const tables = {};
  for (const metric of ['pooled', 'touch', 'rush5', 'rec5', 'td']) {
    const R = rows.filter(r => metric === 'pooled' || r.metric === metric); tables[metric] = {};
    for (const version of ['old', 'next']) tables[metric][version] = Object.fromEntries(['High', 'Med', 'Low'].map(t => [t, metrics(R.filter(r => r[version] === t))]));
    tables[metric].overall = metrics(R);
  }
  const groups = new Map(); for (const r of rows) { if (!groups.has(r.game)) groups.set(r.game, []); groups.get(r.game).push(r); }
  const games = [...groups.values()]; let seed = 135;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const deltas = { brier: [], absGap: [], ece: [] };
  for (let k = 0; k < 1000; k++) {
    const sample = []; for (let i = 0; i < games.length; i++) sample.push(...games[Math.floor(random() * games.length)]);
    const a = metrics(sample.filter(r => r.old === 'High')), b = metrics(sample.filter(r => r.next === 'High'));
    if (!a.n || !b.n) continue;
    for (const key of Object.keys(deltas)) deltas[key].push(b[key] - a[key]);
  }
  const bootstrap = Object.fromEntries(Object.entries(deltas).map(([key, a]) => { a.sort((x, y) => x - y); if (!a.length) return [key, { samples: 0, ci95: null }]; return [key, { samples: a.length, ci95: [a[Math.floor(a.length * .025)], a[Math.floor(a.length * .975)]] }]; }));
  return { season: 2026, weeks, games: games.length, rows: rows.length,
    method: 'Retrospective exploratory reliability redesign, not an independent held-out validation. Same probabilities and outcomes for both rules; only cohort labels change, so overall Brier is identical. Evaluation conditioned on recorded target/carry participation. No route/snap data. Beta intervals are for historical event rates, not validated prediction intervals. Small retrospective sample, not prospective promotion evidence.',
    tables, highNewMinusOldGameBootstrap: bootstrap };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const D = JSON.parse(fs.readFileSync('archive/drives/2026/w9.json'));
  const result = backtest(D), output = process.argv[2] || '/tmp/endzone-drive-confidence-4.24.9.json';
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, rows: result.rows, games: result.games, pooled: result.tables.pooled, rec5: result.tables.rec5, bootstrap: result.highNewMinusOldGameBootstrap }, null, 2));
}
