import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { backtest } from '../scripts/drives/confidence-backtest.mjs';
const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w9.json', import.meta.url)));

test('reliability audit uses identical forecasts: regrouping tiers cannot improve overall Brier', () => {
  const R = backtest(D);
  assert.deepEqual(R.weeks, [4, 5, 6, 7, 8]);
  assert.ok(R.games > 0 && R.rows > 0);
  for (const metric of ['pooled', 'touch', 'rush5', 'rec5', 'td']) for (const version of ['old', 'next']) {
    const T = R.tables[metric];
    const total = Object.values(T[version]).reduce((s, t) => s + t.n, 0);
    const weightedBrier = Object.values(T[version]).reduce((s, t) => s + (t.n ? t.brier * t.n : 0), 0) / total;
    assert.equal(total, T.overall.n);
    assert.ok(Math.abs(weightedBrier - T.overall.brier) < 1e-12);
  }
  assert.match(R.method, /not an independent held-out validation/);
  assert.match(R.method, /conditioned on recorded target\/carry participation/);
  assert.equal(R.highNewMinusOldGameBootstrap.brier.samples, 1000);
});

test('future-week first-drive lines cannot affect the week-four reliability audit', () => {
  const a = backtest(D, [4]), future = structuredClone(D);
  for (const T of Object.values(future.teams)) for (const g of T.games) if (g.w > 4) for (const d of g.d) for (const r of d[8] || []) {
    r[1] = 20; r[2] = 20; r[3] = 999; r[4] = 20; r[5] = 999; r[7] = 1;
  }
  assert.deepEqual(backtest(future, [4]), a);
});
