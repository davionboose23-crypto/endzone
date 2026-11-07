import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { firstDriveForecast } from '../src/first-drive.js';

// Tuple schema matches the shipped 2026 team grid, not a fitted model output.
const row = (n, touches, { targets = touches, rec = touches, car = 0, td = false, result = 'Punt', flags = 0 } = {}) =>
  [n, 1, 0, flags, 6, result, Math.max(3, targets), Math.max(2, car),
    ...(touches || targets || car ? [[[0, targets, rec, rec * 8, car, car * 3, 0, +td]]] : [[]]), 1, 75];
const game = (w, touches, opts = {}) => ({ w, opp: 'BBB', d: [row(1, touches, opts), row(2, 1)] });
function fixture(touches = [0, 0, 0, 2, 2, 2]) {
  return { season: 2026, week: 9, teams: {
    AAA: { people: [['p1', 'Player One', 'RB', '123']], games: touches.map((n, i) => game(i + 1, n)) },
    CCC: { people: [], games: [1, 2, 3].map(w => ({ w, opp: 'BBB', d: [row(1, 0, { result: 'TD' })] })) },
  } };
}
const p = { gsis: 'p1', id: '123', name: 'Player One', team: 'AAA' };

test('first-drive history keeps zero-involvement openers, uses catches + carries, not targets', () => {
  const D = fixture(); D.teams.AAA.games[0].d[0] = row(1, 0, { targets: 2, rec: 0, car: 1, flags: 4, result: 'FG' });
  const F = firstDriveForecast(D, p, 'BBB');
  assert.equal(F.games.length, 6); assert.equal(F.games[0].touches, 1);
  assert.equal(F.games[0].targets, 2); assert.equal(F.games[0].carries, 1);
  assert.equal(F.games[0].yards, 3); assert.equal(F.games[0].rz, true);
  assert.equal(F.games[0].result, 'FG'); assert.equal(F.observed.touchGames, 4);
  assert.equal(F.observed.targetShare, F.observed.targets / F.observed.teamTargets);
});

test('2026 only, pre-week only, ignores model and market inputs', () => {
  const D = fixture(), baseline = firstDriveForecast(D, p, 'BBB');
  D.teams.AAA.games.push(game(9, 30, { td: true, result: 'TD' }), game(10, 50));
  D.league = { tdPerDrive: .99 }; D.defense = { BBB: { openTd: 1 } };
  D.players = { p1: { games: [{ s: 2025, w: 1, d: [[999]] }] } };
  assert.deepEqual(firstDriveForecast(D, { ...p, chance: .999, odds: 100 }, 'BBB'), baseline);
  assert.equal(firstDriveForecast({ ...D, season: 2025 }, p, 'BBB'), null);
  assert.equal(firstDriveForecast({ ...D, season: 2027 }, p, 'BBB'), null);
  assert.equal(firstDriveForecast({ ...D, week: 1 }, p, 'BBB'), null);
});

test('inactive/no recorded involvement excluded; identity uses Sleeper fallback and can follow trades', () => {
  const D = fixture(); D.teams.AAA.games.push({ w: 7, opp: 'BBB', d: [row(1, 0)] });
  D.teams.OLD = { people: [['p1', 'Player One', 'RB', '123']], games: [game(8, 1)] };
  const F = firstDriveForecast(D, { ...p, gsis: null }, 'BBB');
  assert.deepEqual(F.games.map(g => g.week), [1, 2, 3, 4, 5, 6, 8]);
  assert.equal(F.offense.n, 7, 'offense denominator is team games, including no-player games');
  assert.equal(F.games.at(-1).team, 'OLD');
  assert.equal(firstDriveForecast(D, { id: 'missing' }, 'BBB').games.length, 0);
});

test('shrinkage avoids certainty in a one-game sample; bounded coherent scoring probabilities', () => {
  const D = fixture([1]); D.teams.AAA.games[0].d[0] = row(1, 1, { td: true, result: 'TD' });
  D.teams.AAA.games[0].d.push(row(3, 0), row(4, 0));
  D.teams.CCC.games[0].d[0][5] = 'Punt';
  const F = firstDriveForecast(D, p, 'BBB'), f = F.prediction;
  assert.ok(f.touch > 0 && f.touch < 1); assert.ok(f.teamTd > 0 && f.teamTd < 1);
  assert.ok(f.playerTd > 0 && f.playerTd <= f.teamTd && f.playerTd <= f.touch);
  assert.ok(f.touches >= f.touch); assert.equal(F.trend.direction, 'insufficient');
  for (const x of Object.values(f)) assert.ok(Number.isFinite(x));
});

test('team/defense scoring separates TD from field goal and uses opponent opening possessions only', () => {
  const D = fixture([1, 1]);
  D.teams.AAA.games[0].d[0][5] = 'FG'; D.teams.AAA.games[1].d[0][5] = 'TD';
  // Second drives are TDs but must not contaminate opening-drive team rates.
  for (const g of D.teams.AAA.games) g.d[1][5] = 'TD';
  const F = firstDriveForecast(D, p, 'BBB');
  assert.deepEqual([F.offense.n, F.offense.td, F.offense.scored], [2, 1, 2]);
  assert.deepEqual([F.defense.n, F.defense.td, F.defense.scored], [5, 4, 5]);
  const noOpp = firstDriveForecast(D, p, 'UNKNOWN');
  assert.equal(noOpp.defense.n, 0); assert.equal(noOpp.prediction.matchup, 1);
  assert.ok(Number.isFinite(noOpp.prediction.teamTd));
});

test('touch trend compares last three to prior games and is not fed into forecast', () => {
  assert.equal(firstDriveForecast(fixture(), p, 'BBB').trend.direction, 'rising');
  assert.equal(firstDriveForecast(fixture([2, 2, 2, 0, 0, 0]), p, 'BBB').trend.direction, 'falling');
  assert.equal(firstDriveForecast(fixture([1, 1, 1, 1]), p, 'BBB').trend.direction, 'steady');
  assert.deepEqual(firstDriveForecast(fixture(), p, 'BBB').prediction,
    firstDriveForecast(fixture([2, 2, 2, 0, 0, 0]), p, 'BBB').prediction);
});

test('player-page renderer leads with first drive, keeps forecast display-only, and supports no pattern eligibility', () => {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = name => { const a = src.indexOf(`function ${name}(`); return src.slice(a, src.indexOf('\n}', a) + 2); };
  const D = fixture(); D.week = 9;
  const ctx = vm.createContext({ firstDriveForecast, drivesData: () => D, driveRow: () => null,
    driveStatusLine: () => 'unchanged', allPlayers: () => [{ ...p, opp: 'BBB' }],
    esc: x => String(x ?? ''), pc: (x, d = 0) => x == null ? '—' : `${(x * 100).toFixed(d)}%`,
    n1: x => x.toFixed(1), RES_LBL: { Punt: 'Punt', TD: 'Touchdown', FG: 'Field goal' } });
  for (const name of ['firstDriveHtml', 'drivePanelHtml']) vm.runInContext(fn(name), ctx);
  const html = ctx.drivePanelHtml(p);
  assert.ok(html.indexOf('First drive') < html.indexOf('No drive history'));
  assert.match(html, /Gets a touch/); assert.match(html, /Expected touches/);
  assert.match(html, /He scores a TD/); assert.match(html, /AAA scores a TD/);
  assert.match(html, /↑ Rising/); assert.match(html, /Every 2026 first drive/);
  assert.match(html, /not backtest-validated; display-only/); assert.match(html, /Touches = catches \+ carries/);
  assert.match(html, /W6 AAA vs BBB/);
  assert.match(src, /return `\$\{first\}\$\{seen\}\$\{driveChartHtml\(r\)\}/);
});

test('shipped 2026 archive produces finite outputs without mutating data', () => {
  const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w9.json', import.meta.url)));
  const before = JSON.stringify(D);
  const F = firstDriveForecast(D, { gsis: '00-0038597', id: '9224', team: 'CIN' }, 'CLE');
  assert.ok(F.games.length > 0);
  for (const x of Object.values(F.prediction)) assert.ok(Number.isFinite(x));
  assert.equal(JSON.stringify(D), before);
});

test('first-drive block fits a phone with its history scrolling locally', { skip: !fs.existsSync('/usr/bin/google-chrome') && 'no chrome' }, async () => {
  const { chromium } = await import('playwright-core');
  const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w9.json', import.meta.url)));
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function firstDriveHtml(');
  const ctx = vm.createContext({ firstDriveForecast, drivesData: () => D,
    allPlayers: () => [{ ...p, opp: 'ATL' }], esc: x => String(x ?? ''),
    pc: (x, d = 0) => x == null ? '—' : `${(x * 100).toFixed(d)}%`, n1: x => x.toFixed(1),
    RES_LBL: { Punt: 'Punt', TD: 'Touchdown', FG: 'Field goal' } });
  const hubbard = { gsis: '00-0036555', id: '7594', name: 'Chuba Hubbard', pos: 'RB', team: 'CAR' };
  ctx.allPlayers = () => [{ ...hubbard, opp: 'DEN' }];
  vm.runInContext(src.slice(start, src.indexOf('\n}', start) + 2), ctx);
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    const page = await b.newPage({ viewport: { width: 390, height: 844 } });
    const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
    await page.setContent(`<html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><main><h2>Chuba Hubbard · Drive patterns</h2>${ctx.firstDriveHtml(hubbard)}</main></body></html>`);
    assert.match(await page.locator('.firstdrive-call').innerText(), /High chance:[\s\S]*1\+ carry[\s\S]*88%[\s\S]*7 of 7[\s\S]*Coin flip:[\s\S]*1\+ catch[\s\S]*48%[\s\S]*Possible:[\s\S]*10\+ rushing yards[\s\S]*25%/);
    assert.match(await page.locator('.firstdrive-yards').innerText(), /6\.5[\s\S]*2\.0/);
    assert.match(await page.locator('.firstdrive-history thead').innerText(), /Rush yds[\s\S]*Rec yds/i);
    assert.equal(await page.locator('.firstdrive-history tbody tr').count(), 7);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.firstdrive-history .tablewrap').evaluate(el => el.scrollWidth > el.clientWidth), true);
    await page.screenshot({ path: '/tmp/endzone-first-drive-yardage-phone.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await b.close(); }
});

test('yardage thresholds count per-player rush/rec totals separately, retain losses, and shrink small samples', () => {
  const D = fixture([1, 1, 1]);
  const a = D.teams.AAA.games[0].d[0][8][0]; a[2] = 1; a[3] = 19; a[4] = 1; a[5] = 10;
  const b = D.teams.AAA.games[1].d[0][8][0]; b[2] = 1; b[3] = 10; b[4] = 0; b[5] = 0;
  const c = D.teams.AAA.games[2].d[0][8][0]; c[2] = 0; c[3] = 0; c[4] = 1; c[5] = -3;
  const F = firstDriveForecast(D, p, 'BBB'), Y = F.yardage;
  assert.deepEqual(Object.fromEntries(Y.outcomes.map(o => [o.key, o.hits])), { carry: 2, catch: 2, rush10: 1, rec10: 2, scrim20: 1 });
  assert.equal(F.games[2].rushYards, -3);
  for (const o of Y.outcomes) {
    assert.equal(o.probability, (o.hits + 2 * o.prior) / 5);
    assert.ok(o.probability > 0 && o.probability < 1);
    assert.equal(o.games, 3);
  }
  assert.equal(Y.smallSample, true);
  assert.equal(Y.headline.length, 3);
  assert.deepEqual(Y.headline, Y.outcomes.slice().sort((a, b) => b.probability - a.probability).slice(0, 3).map(o => o.key));
  assert.ok(Y.outcomes.find(o => o.key === 'rush10').probability <= Y.outcomes.find(o => o.key === 'carry').probability);
});

test('new yardage estimates and cohort use first drives only; later-drive yards and future games cannot leak', () => {
  const D = fixture(), before = firstDriveForecast(D, p, 'BBB').yardage;
  for (const g of D.teams.AAA.games) { g.d[1][8][0][3] = 1000; g.d[1][8][0][5] = 1000; }
  D.teams.AAA.games.push(game(9, 999), game(10, 999));
  assert.deepEqual(firstDriveForecast(D, p, 'BBB').yardage, before);
});

test('opponent first-drive context adjusts expected yards only, with capped multipliers and a missing-opponent fallback', () => {
  const D = fixture(), noOpp = firstDriveForecast(D, p, 'UNKNOWN').yardage;
  const allowed = firstDriveForecast(D, p, 'BBB').yardage;
  assert.deepEqual(allowed.outcomes, noOpp.outcomes);
  assert.equal(noOpp.context.games, 0);
  for (const key of ['rushYards', 'recYards']) {
    assert.equal(noOpp.context[key].multiplier, 1);
    assert.equal(noOpp.context[key].allowedMean, null);
    assert.ok(allowed.context[key].multiplier >= .8 && allowed.context[key].multiplier <= 1.2);
  }
});

test('CAR sample identifies Hubbard; threshold claims never manufacture a high 10-yard chance from a 7/7 touch rate', () => {
  const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w9.json', import.meta.url)));
  const F = firstDriveForecast(D, { gsis: '00-0036555', id: '7594', team: 'CAR', pos: 'RB' }, 'DEN');
  assert.equal(F.observed.touchGames, 7); assert.equal(F.observed.touches / F.observed.games, 3);
  const by = Object.fromEntries(F.yardage.outcomes.map(o => [o.key, o]));
  assert.equal(by.carry.hits, 7); assert.equal(by.carry.level, 'High');
  assert.equal(by.rush10.hits, 2); assert.equal(by.rush10.level, 'Possible');
  assert.equal(by.rec10.hits, 1); assert.equal(by.scrim20.hits, 0);
  assert.equal(F.games[3].rushYards, -3);
  assert.equal(F.yardage.cohortGames > 0, true);
});
