import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityFactor, defenseSpotFactor } from '../src/spots.js';
const league = { avgYl: { r: { 1: 3, 2: 8, 3: 15 }, t: { 1: 3, 2: 8, 3: 15 } }, avgYtg: { r: { 1: 3, 2: 7, 3: 9 }, t: { 1: 3, 2: 7, 3: 9 } }, endzoneRate: { t: null }, catchRate: { t: null } };
test('distance to gain: shorter distance nudges up, longer down, bounded ±2%, none without data', () => {
  const z = (ytg, n = 40) => ({ looks: n, sumYl: 15 * n, sumYtg: ytg * n });
  const short = qualityFactor('r', 3, z(4), league).factor, long = qualityFactor('r', 3, z(20), league).factor, same = qualityFactor('r', 3, z(9), league).factor;
  assert.ok(short > same && long < same);
  assert.ok(short <= 1.02 + 1e-9 && long >= 0.98 - 1e-9);
  assert.ok(qualityFactor('r', 3, z(1, 2), league).factor - 1 < 0.004, 'small samples shrink');
  assert.equal(qualityFactor('r', 3, { looks: 10, sumYl: 150 }, league).parts.some(s => /distance/.test(s)), false);
});
test('yard-line defense allowance: shrunk, bounded 0.94–1.06, neutral with no sample', () => {
  const lz = { r: { bins: { 1: { looks: 300, scores: 120 }, 2: { looks: 300, scores: 50 } } } };
  const mk = s1 => new Map([['XX', { r: { bins: { 1: { looks: 30, scores: s1 } } } }]]);
  const leaky = defenseSpotFactor(mk(22), lz, 'XX', 'r', 1).factor, stout = defenseSpotFactor(mk(5), lz, 'XX', 'r', 1).factor, avg = defenseSpotFactor(mk(12), lz, 'XX', 'r', 1).factor;
  assert.ok(leaky > 1 && stout < 1 && leaky <= 1.06 && stout >= 0.94); assert.ok(Math.abs(avg - 1) < 1e-9);
  assert.ok(defenseSpotFactor(new Map([['XX', { r: { bins: { 1: { looks: 3, scores: 2 } } } }]]), lz, 'XX', 'r', 1).factor < 1.04, 'small samples shrink');
  assert.equal(defenseSpotFactor(mk(22), lz, 'NONE', 'r', 1).factor, 1);
  assert.equal(defenseSpotFactor(mk(22), lz, 'XX', 'r', 2).factor, 1, 'no bin sample → neutral');
});
