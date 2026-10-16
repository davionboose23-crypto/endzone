// Scheduled shared archive (user-approved override of spec §23): frozen-forecast immutability, no leakage,
// idempotent job, results vs predicted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeFixture } from './fixture.js';
import { FileArchive } from '../server/file-archive.js';
import { refresh, calibrationState } from '../server/jobs.js';
import { runEngine } from '../src/engine.js';
import { buildIndex } from '../src/stats-index.js';
import { snapshotFromGame } from '../src/grading.js';
import { gameResults, weekResults } from '../src/results.js';
import { MODEL_VERSION, DEFAULT_WEIGHTS } from '../src/model.js';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ez-arch-'));
const files = dir => { const out = {}; const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (!p.includes(`${path.sep}runs${path.sep}`)) out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } }; walk(dir); return out; };
const wk5 = prep => prep.games.filter(g => g.week === 5).sort((a, b) => a.kickoff.localeCompare(b.kickoff));

test('scheduled job is idempotent: an unchanged second run writes no archive changes', async () => {
  const prep = makeFixture(); const dir = tmp(); const A = await FileArchive.open(dir);
  const now = Date.parse(wk5(prep)[0].kickoff) - 3 * 3600e3;
  const r1 = await refresh(A, { prep, now: () => now }); assert.equal(r1.ok, true, JSON.stringify(r1.details));
  assert.ok(r1.details.steps.some(s => /saved 2 pregame frames/.test(s)), r1.details.steps.join('|'));
  const before = files(dir);
  const r2 = await refresh(A, { prep, now: () => now + 600e3 });
  assert.ok(r2.details.steps.some(s => /saved 0 pregame frames, 2 skipped/.test(s)), r2.details.steps.join('|'));
  assert.deepEqual(files(dir), before, 'byte-identical archive (run log excluded)');
});

test('frozen forecasts are immutable after kickoff and never captured at/after kickoff', async () => {
  const prep = makeFixture(); const dir = tmp(); const A = await FileArchive.open(dir); const [g1, g2] = wk5(prep);
  const early = Date.parse(g1.kickoff) - 3600e3;
  await refresh(A, { prep, now: () => early });
  const frozen = A.snapshots(prep.season, 5).find(s => s.gameId === g1.id); assert.ok(frozen && Date.parse(frozen.capturedAt) < Date.parse(g1.kickoff));
  // after kickoff: different weights / lessons cannot touch the frozen frame
  const res = runEngine(prep, { now: early, weights: { ...DEFAULT_WEIGHTS, redZone: 1.5 } });
  const G = res.games.find(x => x.gameId === g1.id);
  const r = A.saveSnapshot(snapshotFromGame(G, { modelVersion: MODEL_VERSION, weights: res.weights }), { now: new Date(Date.parse(g1.kickoff) + 60e3) });
  assert.equal(r.saved, false); assert.match(r.reason, /kickoff/);
  await refresh(A, { prep, now: () => Date.parse(g1.kickoff) + 60e3 });
  assert.deepEqual(A.snapshots(prep.season, 5).find(s => s.gameId === g1.id), frozen, 'started game frame unchanged');
  assert.deepEqual(A.snapshots(prep.season, 5, 'first').find(s => s.gameId === g1.id), frozen, 'first frame retained');
  // the later game can still update its latest frame before its own kickoff, but its first frame stays
  const first2 = A.snapshots(prep.season, 5, 'first').find(s => s.gameId === g2.id);
  assert.ok(Date.parse(first2.capturedAt) < Date.parse(g2.kickoff));
});

test('no leakage: lessons for week w use only finished weeks before w; frames captured before kickoff', async () => {
  const prep = makeFixture(); const dir = tmp(); const A = await FileArchive.open(dir); const ix = buildIndex(prep);
  const cal = calibrationState(A, prep, ix, prep.season, 5);
  assert.deepEqual(cal.active.weeks, [4, 3, 2]);
  for (const w of Object.keys(cal.lessonsByWeek)) assert.ok(+w < 5);
  assert.ok(cal.graded.every(r => r.week < 5), 'graded training rows come only from earlier weeks');
  await refresh(A, { prep, now: () => Date.parse(wk5(prep)[0].kickoff) - 60e3 });
  for (const s of A.allSnapshots('latest').concat(A.allSnapshots('first'))) assert.ok(Date.parse(s.capturedAt) < Date.parse(s.kickoff));
});

test('results vs predicted: per-game summary is consistent and labeled', () => {
  const prep = makeFixture(); const ix = buildIndex(prep);
  const res = runEngine(prep, { week: 4, ix, lessons: null, now: Date.now() });
  const G = res.games[0]; assert.ok(G.game.finished);
  const R = gameResults(ix, G.game, G.sides, { frozen: 'reconstructed' });
  assert.equal(R.prospective, false); assert.match(R.label, /Reconstructed/);
  const graded = R.rows.filter(r => r.chance != null);
  assert.equal(R.summary.actualTd, graded.reduce((s, r) => s + r.td, 0));
  assert.ok(R.summary.rangeHits <= R.summary.rangeTotal && R.summary.brier >= 0 && R.summary.brier <= 1);
  for (const r of graded) for (const v of Object.values(r.vol)) assert.equal(v.inRange, v.actual >= v.lo && v.actual <= v.hi);
  const P = gameResults(ix, G.game, G.sides, { frozen: 'snapshot' }); assert.equal(P.prospective, true);
  const W = weekResults([{ results: R }, { results: P }]); assert.equal(W.games, 2); assert.equal(W.prospective.n, W.reconstructed.n);
  assert.equal(gameResults(ix, { ...G.game, finished: false }, G.sides, { frozen: 'live' }), null);
});
