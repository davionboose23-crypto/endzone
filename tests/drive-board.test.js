import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachDrivePatterns, driveEstimateConfidence, drivePosteriorInterval, DRIVE_CONFIDENCE_RULE } from '../src/drive-board.js';
import { firstDriveForecast, prepareFirstDriveContext } from '../src/first-drive.js';
import { sortPlayers, SORTS, SORT_GROUPS, migrateDriveSort } from '../src/ranking.js';
const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w9.json', import.meta.url)));
const player = { id: '7594', gsis: '00-0036555', pos: 'RB', team: 'CAR', opp: 'DEN', chance: .5, tdConf: { level: 'High' } };
const fake = values => ({ games: values.map(hit => ({ hit, targets: 2, carries: 1, touches: 2, teamTargets: 4, opportunities: 7 })), offense: { n: 10 }, defense: { n: 10 } });

test('confidence uses posterior width and volume, not just probability or TD confidence', () => {
  const conf = (values, prob, td = false) => driveEstimateConfidence(fake(values), g => g.hit, prob, td).level;
  assert.equal(conf([1, 1, 1], .99), 'Low');
  assert.equal(conf([1, 1, 1, 1, 1, 1, 1], .95), 'High');
  assert.equal(conf([1, 1, 1, 1], .95), 'Med');
  assert.equal(conf([1, 0, 0, 0, 1, 1, 1], .55), 'Med', 'small-sample fluctuations are not a hard veto');
  assert.equal(conf([1, 1, 1, 1, 1, 1, 1], .5), 'Med', 'range widens to include an unsupported forecast');
  assert.equal(conf([0, 0, 0, 0, 0, 0, 0], .01), 'Med', 'strong volume can support a low estimate, but never High on zero hits');
  assert.equal(conf([1, 1, 1, 1, 1, 1, 1], .95, true), 'Med', 'TD stricter sample requirement');
  assert.equal(conf(Array(10).fill(1), .95, true), 'High');
  const shortDefense = fake(Array(10).fill(1)); shortDefense.defense.n = 3;
  assert.equal(driveEstimateConfidence(shortDefense, g => g.hit, .95, true).level, 'Low');
  assert.match(DRIVE_CONFIDENCE_RULE, /not calibrated anytime-model confidence/);
});

test('drive sort orders its own tier first, then probability, missing last, stable id tiebreak', () => {
  const row = (id, level, probability) => ({ id, chance: 1 - (probability || 0), tdConf: { level: 'High' }, drivePatterns: probability == null ? {} : { touch: { probability, confidence: { level } } } });
  const rows = [row('low', 'Low', .99), row('med', 'Med', .9), row('h2', 'High', .4), row('h1', 'High', .6), row('missing', null, null)];
  const before = JSON.stringify(rows);
  assert.deepEqual(sortPlayers(rows, 'fdTouchConf').map(p => p.id), ['h1', 'h2', 'med', 'low', 'missing']);
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(SORT_GROUPS.find(g => g[0] === 'Drive patterns')[1], ['fdTouchConf', 'fdRush5Conf', 'fdRec5Conf', 'fdTdConf']);
  for (const key of ['fdTouchConf', 'fdRush5Conf', 'fdRec5Conf', 'fdTdConf']) assert.ok(SORTS[key].drive);
});

test('prepared context matches ordinary forecasts; board adds copies only and invalidates by drive-file identity', () => {
  const before = JSON.stringify(D), frozen = Object.freeze({ ...player });
  assert.deepEqual(firstDriveForecast(D, player, player.opp, prepareFirstDriveContext(D)), firstDriveForecast(D, player, player.opp));
  const [row] = attachDrivePatterns(D, [frozen]);
  const F = firstDriveForecast(D, player, player.opp);
  assert.equal(row.drivePatterns.touch.probability, F.prediction.touch);
  assert.equal(row.drivePatterns.rush5.probability, F.yardage.outcomes.find(o => o.key === 'rush5').probability);
  assert.equal(row.drivePatterns.rec5.probability, F.yardage.outcomes.find(o => o.key === 'rec5').probability);
  assert.equal(row.drivePatterns.td.probability, F.prediction.playerTd);
  assert.equal(row.drivePatterns.touch.confidence.level, 'High');
  assert.equal(Object.hasOwn(frozen, 'drivePatterns'), false);
  assert.equal(JSON.stringify(D), before);
  assert.equal(attachDrivePatterns(D, [frozen])[0].drivePatterns, row.drivePatterns, 'same weekly file cached');
  const next = structuredClone(D); next.week = 2;
  assert.equal(attachDrivePatterns(next, [player])[0].drivePatterns.touch.confidence.games, 1);
  assert.deepEqual(attachDrivePatterns({ ...D, season: 2025 }, [player])[0].drivePatterns, {});
  assert.deepEqual(attachDrivePatterns(null, [player])[0].drivePatterns, {});
});

test('persisted old yardage sort keys migrate without changing unrelated selections', () => {
  assert.equal(migrateDriveSort('fdRush10Conf'), 'fdRush5Conf');
  assert.equal(migrateDriveSort('fdRec10Conf'), 'fdRec5Conf');
  for (const key of ['default', 'fdTouchConf', 'fdTdConf', 'recYdConf', 'toString']) assert.equal(migrateDriveSort(key), key);
});

const CHROME = '/usr/bin/google-chrome';
test('Board Drive patterns sorts persist, display probability/tier on all layouts, and fit phones', { skip: !fs.existsSync(CHROME) && 'no chrome', timeout: 300000 }, async () => {
  const { chromium } = await import('playwright-core');
  const { createServer } = await import('../server/server.js');
  const { server } = await createServer({ dbFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ez-drive-board-')), 'a.sqlite'), log: () => {} });
  await new Promise(r => server.listen(0, r));
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, timezoneId: 'America/Chicago' });
    await p.addInitScript(() => { if (!localStorage.getItem('endzone.board.v1')) localStorage.setItem('endzone.board.v1', JSON.stringify({ sort: 'fdRec10Conf' })); });
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto(`http://127.0.0.1:${server.address().port}`); await p.waitForSelector('.game', { timeout: 180000 });
    await p.click('#tab-board');
    assert.equal(await p.inputValue('#bsort'), 'fdRec5Conf', 'old saved 10-yard sort migrates to 5 yards');
    assert.equal(await p.locator('#bsort optgroup[label="Drive patterns"] option').count(), 4);
    const rank = { High: 0, Med: 1, Low: 2 };
    for (const key of ['fdTouchConf', 'fdRush5Conf', 'fdRec5Conf', 'fdTdConf']) {
      await p.selectOption('#bsort', key);
      await p.waitForSelector('#view-board .focuslist [data-drive-tier]');
      const cells = await p.locator('#view-board .focuslist [data-drive-tier]').evaluateAll(cs => cs.map(c => ({ tier: c.dataset.driveTier, prob: +c.dataset.driveProb })));
      assert.ok(cells.length > 10);
      if (key === 'fdRush5Conf' || key === 'fdRec5Conf') assert.ok(cells.filter(c => c.tier === 'High').length >= 3, 'yardage High is reachable without quotas');
      for (let i = 1; i < cells.length; i++) assert.ok(rank[cells[i - 1].tier] < rank[cells[i].tier] || (rank[cells[i - 1].tier] === rank[cells[i].tier] && cells[i - 1].prob >= cells[i].prob));
      assert.match(await p.locator('#view-board .focuslist .fhead').textContent(), /Drive 1/);
    }
    const tops = {}, highs = {};
    for (const key of ['fdRush5Conf', 'fdRec5Conf']) {
      await p.selectOption('#bsort', key);
      const list = await p.locator('#view-board .focuslist .frow:not(.fhead)').evaluateAll(rs => rs.map(r => {
        const c = r.querySelector('[data-drive-tier]'); return { name: r.querySelector('.fplayer .plink')?.innerText, tier: c?.dataset.driveTier, probability: +c?.dataset.driveProb };
      }));
      tops[key] = list.slice(0, 5);
      highs[key] = list.filter(r => r.tier === 'High');
    }
    fs.writeFileSync('/tmp/endzone-drive-board-4.24.10-high.json', JSON.stringify(highs, null, 2));
    fs.writeFileSync('/tmp/endzone-drive-board-4.24.10-top5.json', JSON.stringify(tops, null, 2));
    await p.selectOption('#bsort', 'fdRec5Conf');
    for (const [width, height] of [[390, 844], [844, 390]]) {
      await p.setViewportSize({ width, height });
      await p.waitForTimeout(250);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width} phone overflow`);
    }
    await p.setViewportSize({ width: 390, height: 1300 });
    await p.waitForTimeout(250);
    await p.screenshot({ path: '/tmp/endzone-drive-board-4.24.10-rec5-phone.png' });
    await p.selectOption('#bsort', 'fdRush5Conf');
    await p.waitForTimeout(250);
    await p.screenshot({ path: '/tmp/endzone-drive-board-4.24.10-rush5-phone.png' });
    await p.selectOption('#bsort', 'fdRec5Conf');
    await p.fill('#bq', 'SEA'); await p.waitForTimeout(300);
    await p.screenshot({ path: '/tmp/endzone-drive-board-4.24.10-jsn-phone.png' });
    await p.fill('#bq', ''); await p.waitForTimeout(300);
    // Non-focus mobile and desktop need the selected drive estimate too.
    await p.click('#focusBtn'); await p.waitForSelector('#view-board .cards-mobile .driveboard-cell');
    assert.ok(await p.locator('#view-board .cards-mobile .driveboard-cell').count() > 10);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'non-focus phone overflow');
    await p.setViewportSize({ width: 1280, height: 900 });
    await p.waitForTimeout(250);
    assert.match(await p.locator('#view-board .desk-only thead').innerText(), /Drive 1/i);
    assert.ok(await p.locator('#view-board .desk-only tbody [data-drive-tier]').count() > 10);
    assert.equal(await p.locator('#view-board .desk-only thead th').count(), await p.locator('#view-board .desk-only tbody tr').first().locator('td').count());
    await p.reload(); await p.waitForSelector('.game', { timeout: 180000 }); await p.click('#tab-board');
    assert.equal(await p.inputValue('#bsort'), 'fdRec5Conf');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});

test('Beta posterior ranges are finite, symmetric, and narrow with more data', () => {
  const uniform = drivePosteriorInterval(0, 0);
  assert.ok(Math.abs(uniform.lo - .05) < 1e-9 && Math.abs(uniform.hi - .95) < 1e-9);
  const half = drivePosteriorInterval(4, 8);
  assert.ok(Math.abs(half.lo + half.hi - 1) < 1e-9);
  assert.ok(half.lo > .2 && half.hi < .8);
  assert.ok(drivePosteriorInterval(8, 16).width < half.width);
  assert.ok(drivePosteriorInterval(0, 8).lo > 0);
  assert.ok(drivePosteriorInterval(8, 8).hi < 1);
});

test('all-player rule fixes JSN/McBride versus low-volume long shots without changing probabilities', () => {
  const cases = [['SEA', 'Smith-Njigba', 'High'], ['ARI', 'McBride', 'High'], ['SEA', 'Kupp', 'Low'], ['ARI', 'Higgins', 'Low']];
  for (const [team, name, expected] of cases) {
    const pe = D.teams[team].people.find(p => p[1].includes(name));
    const p = { gsis: pe[0], id: pe[3], pos: pe[2], team, opp: team === 'SEA' ? 'ARI' : 'SEA' };
    const F = firstDriveForecast(D, p, p.opp), row = attachDrivePatterns(D, [p])[0].drivePatterns.rec5;
    assert.equal(row.confidence.level, expected, pe[1]);
    assert.equal(row.probability, F.yardage.outcomes.find(o => o.key === 'rec5').probability);
    assert.ok(row.confidence.interval.width > 0);
    if (expected === 'High') assert.equal(row.confidence.genuineShift, false, 'three-game swings have overlapping credible ranges');
  }
});

test('narrow near-zero intervals cannot promote low-volume players; real shifts only mildly widen a range', () => {
  const low = fake([1, 0, 0, 0, 0, 0, 0, 0]);
  low.games = low.games.map((g, i) => ({ ...g, targets: i === 0 ? 1 : 0, carries: 0, touches: i === 0 ? 1 : 0 }));
  const c = driveEstimateConfidence(low, g => g.hit, .12, false, 'rec5');
  assert.equal(c.level, 'Low'); assert.ok(c.volume.involvement < .35);
  const shifted = driveEstimateConfidence(fake([0, 0, 0, 1, 1, 1]), g => g.hit, .5);
  assert.equal(shifted.genuineShift, true);
  assert.ok(Math.abs(shifted.adjustedWidth - shifted.interval.width - .03) < 1e-9);
  assert.equal(shifted.level, 'Med');
});

const relativeFixture = (values, baseline) => ({ ...fake(values), yardage: { outcomes: ['rush5', 'rec5'].map(key => ({ key, prior: baseline })) } });
test('yardage High uses outcome/position lower-bound evidence instead of an unreachable absolute width', () => {
  const F = relativeFixture([1, 1, 1, 0, 0], .18);
  const rec = driveEstimateConfidence(F, g => g.hit, .48, false, 'rec5');
  assert.equal(rec.level, 'High'); assert.ok(rec.adjustedWidth > .4);
  assert.equal(rec.basis, 'outcome-relative'); assert.equal(rec.requiredEdge, .05);
  assert.equal(driveEstimateConfidence(F, g => g.hit, .48, false, 'rush5').level, 'Med', 'rush needs 10-point rather than 5-point margin');
  assert.equal(driveEstimateConfidence(relativeFixture([1, 1, 1, 0, 0], .25), g => g.hit, .48, false, 'rec5').level, 'Med', 'stronger position baseline needs stronger evidence');
  assert.equal(driveEstimateConfidence(F, g => g.hit, .01, false, 'rec5').level, 'Low', 'an unsupported point forecast cannot be High');
  assert.equal(driveEstimateConfidence(relativeFixture([1, 1, 1, 1], .1), g => g.hit, .8, false, 'rec5').level, 'Med', 'minimum five games');
  assert.equal(driveEstimateConfidence(relativeFixture([1, 1, 0, 0, 0], 0), g => g.hit, .3, false, 'rec5').level, 'Med', 'minimum three actual hits, even against a low baseline');
  assert.equal(driveEstimateConfidence(fake([1, 1, 1, 1, 1]), g => g.hit, .8, false, 'rec5').level, 'Med', 'missing baseline is not a reason to auto-promote');
  const weakRole = relativeFixture([1, 1, 1, 0, 0], .18);
  weakRole.games = weakRole.games.map((g, i) => ({ ...g, targets: i < 3 ? 1 : 0 }));
  assert.equal(driveEstimateConfidence(weakRole, g => g.hit, .48, false, 'rec5').level, 'Med', 'a promising hit rate without sufficient target volume cannot earn High');
  const shifted = driveEstimateConfidence(relativeFixture([0, 0, 0, 1, 1, 1], .14), g => g.hit, .5, false, 'rec5');
  assert.equal(shifted.genuineShift, true); assert.equal(shifted.level, 'High', 'genuine shift is a mild penalty, not an automatic veto');
  assert.ok(Math.abs(shifted.interval.lo - shifted.relativeLower - .03) < 1e-9);
});

test('future drives do not change earlier forecasts, baselines, or tiers', () => {
  const train = { ...D, week: 6 }, prefix = structuredClone(train);
  for (const T of Object.values(prefix.teams)) T.games = T.games.filter(g => g.w < 6);
  const rows = ['SEA', 'ARI', 'CAR'].map(team => {
    const name = { SEA: 'Smith-Njigba', ARI: 'McBride', CAR: 'Hubbard' }[team];
    const pe = D.teams[team].people.find(p => p[1].includes(name));
    return { gsis: pe[0], id: pe[3], pos: pe[2], team, opp: team === 'SEA' ? 'ARI' : 'SEA' };
  });
  assert.deepEqual(attachDrivePatterns(train, rows), attachDrivePatterns(prefix, rows));
});

test('2026 W4–8 walk-forward yardage tiers have the highest hit rate in High, with unchanged point forecasts', async () => {
  const { backtest } = await import('../scripts/drives/confidence-backtest.mjs');
  const audit = backtest(D);
  for (const metric of ['touch', 'td']) assert.deepEqual(audit.tables[metric].old, audit.tables[metric].next, 'touch/TD tiers are unchanged');
  for (const metric of ['rush5', 'rec5']) {
    const { old, next, overall } = audit.tables[metric];
    assert.equal(old.High.n, 0, '4.24.9 had no yardage High cohort');
    assert.ok(next.High.n >= 10);
    assert.ok(next.High.actual > next.Med.actual && next.Med.actual > next.Low.actual);
    for (const version of [old, next]) {
      const n = Object.values(version).reduce((s, c) => s + c.n, 0);
      const brier = Object.values(version).reduce((s, c) => s + (c.brier || 0) * c.n, 0) / n;
      assert.ok(Math.abs(brier - overall.brier) < 1e-12, 'labels cannot improve or alter overall Brier');
    }
  }
});
