// endzone app 4.7.0: drive-trends agent (per-drive usage table, pattern detector, display-only status).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binomTwoSided, bhQ, detect, describe, reliability, phaseSummary, playerDrives, indexTables, SUBSETS, ORD } from '../src/drive-patterns.js';
import { DCOLS, PCOLS } from '../scripts/drives/lib.mjs';
import { buildPatterns } from '../scripts/drives/build.mjs';
import { FileArchive } from '../server/file-archive.js';
import { MODEL_VERSION } from '../src/model.js';

// Synthetic season: team AAA, 10 drives a game, 6 touches a drive. "Rot" gets 4 of 6 touches on drive 2 and
// 1 elsewhere (a real series rotation); "Flat" gets 1 touch on every drive (no pattern).
function table(season, weeks, { rotDrive = 2 } = {}) {
  const drives = [], players = [];
  for (let w = 1; w <= weeks; w++) for (let n = 1; n <= 10; n++) {
    const i = drives.length; const half = n <= 5 ? 1 : 2;
    drives.push([season, w, `${season}_${w}_AAA_BBB`, 'AAA', 'BBB', n, n * 2 - 1, half === 1 ? 1 : 3, half, n % 3 - 1, 75, 'Punt', n === 6 ? 1 : 0, 6, 3, 3]);
    players.push([i, 'ROT', 0, 0, 0, n === rotDrive ? 4 : 1, n === rotDrive ? 20 : 4, 0, 0, 0]);
    players.push([i, 'FLAT', 1, 1, 8, 0, 0, 0, 0, 0]);
  }
  return { kind: 'drive-table', version: 1, season, cols: { drives: DCOLS, players: PCOLS }, weeks, drives, players,
    people: { ROT: { name: 'Rot Back', pos: 'RB', team: 'AAA', sleeper: '111' }, FLAT: { name: 'Flat Wideout', pos: 'WR', team: 'AAA', sleeper: '222' } } };
}

test('exact binomial and BH q-values', () => {
  assert.ok(Math.abs(binomTwoSided(5, 10, 0.5) - 1) < 1e-9);
  assert.ok(binomTwoSided(10, 10, 0.5) < 0.002 && binomTwoSided(10, 10, 0.5) > 0.0019);
  assert.equal(binomTwoSided(0, 0, 0.3), 1);
  const q = bhQ([0.01, 0.04, 0.03, 0.5]); assert.deepEqual(q.map(x => +x.toFixed(4)), [0.04, 0.0533, 0.0533, 0.5]);
  assert.equal(ORD(1) + ORD(2) + ORD(3) + ORD(11) + ORD(22), '1st2nd3rd11th22nd');
});

test('detector finds a planted drive-number share pattern and not a flat one; pre-game only', () => {
  const T = [table(2025, 17), table(2026, 7)];
  const { tests } = detect(T, 2026, 8);
  const rot = tests.filter(t => t.pid === 'ROT' && t.sub === 'd2' && t.metric === 'carShare')[0];
  assert.ok(rot && rot.q < 0.001 && rot.shr > rot.rest, 'rotation found');
  assert.ok(rot.shr < rot.raw, 'shrunk toward the overall share');
  assert.equal(tests.filter(t => t.pid === 'FLAT' && t.q <= 0.1).length, 0, 'no false pattern for the flat player');
  // later weeks never leak into an earlier week's detection
  const T2 = [table(2025, 17), table(2026, 7)]; for (const r of T2[1].players) if (T2[1].drives[r[0]][1] >= 5) { r[5] = 0; r[6] = 0; }
  const a = detect(T, 2026, 5).tests.map(t => t.p), b = detect(T2, 2026, 5).tests.map(t => t.p); assert.deepEqual(a, b);
  const t = { ...rot, rel: reliability(rot, { retention: 0.5, ciLo: 0.2 }) }; assert.equal(t.rel, 'strong');
  assert.equal(reliability(rot, { retention: 0.5, ciLo: -0.1 }), 'moderate', 'family that did not hold out of sample cannot be strong');
  assert.match(describe(t), /^Gets \d+% of the team's carries on the 2nd drive, vs \d+% on other drives \(n=\d+ drives/);
  const P = phaseSummary(playerDrives(indexTables(T, 2026, 8), 'FLAT')); assert.equal(P.openPerGame, 2); assert.equal(P.perDrive, 1);
  assert.equal(SUBSETS.length, 18);
});

test('weekly drive-pattern file shape, display-only status and archive read path', () => {
  const T = [table(2025, 17), table(2026, 7)]; const D = buildPatterns(T, 2026, 8);
  assert.equal(D.kind, 'drive-patterns'); assert.equal(D.prediction.adopted, false); assert.equal(D.modelVersion, MODEL_VERSION);
  for (const f of ['drive', 'phase']) for (const k of ['tests', 'raw05', 'expectedByChance', 'fdr', 'strong', 'moderate']) assert.equal(typeof D.counts[f][k], 'number');
  const r = D.players.ROT; assert.equal(D.bySleeper['111'], 'ROT'); assert.ok(r.games.length <= 6 && r.games[0].d[0].length === 5);
  assert.ok(r.patterns.length <= 4 && new Set(r.patterns.map(p => p.sub)).size === r.patterns.length);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-drv-')); fs.mkdirSync(path.join(dir, 'drives', '2026'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'drives', '2026', 'w8.json'), JSON.stringify(D));
  assert.equal(new FileArchive(dir).drives(2026, 8).week, 8); assert.equal(new FileArchive(dir).drives(2026, 9), null);
});

test('shipped drive baseline: not adopted means the model version did not move', () => {
  const B = JSON.parse(fs.readFileSync(new URL('../src/drive-baseline.json', import.meta.url), 'utf8'));
  const P = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (!B.adopted) { assert.equal(B.modelVersion, MODEL_VERSION); assert.notEqual(P.version, MODEL_VERSION.replace('endzone-', '')); }
  const h = B.results.hist2026.usageD_vs_usage; assert.ok(Array.isArray(h.ci) && Array.isArray(h.llci));
});
