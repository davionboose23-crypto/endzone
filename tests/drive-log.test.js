// endzone app 4.8.1: drive-by-drive log and player-by-drive threshold table helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STATS, PRESETS, thLabel, shortName, ylText, statLine, cellText, driveLineText, playerDriveRows, hitSummary, meets, driveLabel } from '../src/drive-log.js';

const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w8.json', import.meta.url)));
const pidOf = (t, nm) => D.teams[t].people.find(p => p[1] === nm)[0];

test('team drive tuples carry quarter and start yard line', () => {
  for (const T of Object.values(D.teams)) for (const g of T.games) for (const d of g.d) {
    assert.equal(d.length, 11); assert.ok(d[9] == null || (d[9] >= 1 && d[9] <= 5)); assert.ok(d[10] == null || (d[10] >= 1 && d[10] <= 99));
  }
});

test('names, yard lines and stat lines read like the spec', () => {
  assert.equal(shortName('Amon-Ra St. Brown'), 'St. Brown'); assert.equal(shortName('Kenneth Walker III'), 'Walker'); assert.equal(shortName('Marvin Harrison Jr.'), 'Harrison');
  assert.equal(ylText(75, 'DET', 'GB'), 'DET 25'); assert.equal(ylText(30, 'DET', 'GB'), 'GB 30'); assert.equal(ylText(50, 'DET', 'GB'), 'midfield'); assert.equal(ylText(null, 'DET', 'GB'), '—');
  assert.equal(statLine([0, 3, 2, 24, 0, 0, 0, 0]), '2 rec (3 tgt), 24 yds');
  assert.equal(statLine([0, 0, 0, 0, 3, 18, 1, 1]), '3 car, 18 yds, TD');
  assert.equal(statLine([0, 1, 1, 9, 2, 7, 0, 0]), '1 rec (1 tgt), 9 yds; 2 car, 7 yds');
  assert.equal(cellText([0, 3, 2, 24, 0, 0, 0, 0], 'rec'), '2 rec / 24 yds'); assert.equal(cellText([0, 0, 0, 0, 3, 18, 0, 0], 'rushYd'), '3 car / 18 yds');
  assert.equal(cellText(undefined, 'rec'), '—'); assert.equal(cellText([0, 1, 1, 9, 2, 7, 0, 0], 'tch'), '3 tch / 16 yds');
  assert.equal(thLabel('rec', 1), '1+ rec'); assert.equal(thLabel('rushYd', 10), '10+ rush yds'); assert.equal(PRESETS.length, 5);
  const T = D.teams.DET; const line = driveLineText(D, T, T.games[0].d.find(d => d[8].length));
  assert.match(line, /^[A-Z][^·]+ \d+ (rec \(\d+ tgt\)|car), -?\d+ yds/);
});

test('meets / thresholds per stat', () => {
  const x = [0, 3, 2, 24, 1, 12, 0, 0];
  assert.ok(meets(x, 'rec', 2)); assert.ok(!meets(x, 'rec', 3)); assert.ok(meets(x, 'recYd', 20)); assert.ok(meets(x, 'rushYd', 10)); assert.ok(!meets(x, 'rushYd', 20));
  assert.equal(STATS.tch.v(x), 3); assert.ok(!meets(undefined, 'rec', 1)); assert.ok(meets(undefined, 'rec', 0) === false);
});

test('hit summary counts games per drive number and agrees with a direct count', () => {
  const T = D.teams.DET; const pid = pidOf('DET', 'Amon-Ra St. Brown');
  const R = playerDriveRows(T, pid, T.games); assert.ok(R.rows.length >= 5);
  const H = hitSummary(R.rows, 'rec', 1, R.maxN);
  for (const b of H.byDrive) {
    const G = R.rows.filter(r => r.nDrives >= b.n); assert.equal(b.games, G.length);
    assert.equal(b.hits, G.filter(r => (r.by.get(b.n)?.[2] || 0) >= 1).length); assert.ok(b.hits <= b.games);
  }
  const all = R.rows.reduce((s, r) => s + r.drives.length, 0); assert.equal(H.all.drives, all);
  assert.equal(H.byDrive.reduce((s, b) => s + b.hits, 0), H.all.hits);
});

test('labels only say "pattern" for drive-number findings that survived FDR + persistence', () => {
  for (const [pid, P] of Object.entries(D.players)) for (let n = 1; n <= 10; n++) {
    const L = driveLabel(P, n); const has = (P.patterns || []).some(t => t.sub === `d${n}`);
    assert.equal(L.label, has ? 'pattern' : 'small sample / likely chance', pid);
  }
  assert.equal(driveLabel(undefined, 3).label, 'small sample / likely chance');
});
