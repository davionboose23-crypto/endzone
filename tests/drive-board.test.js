import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachDrivePatterns, driveEstimateConfidence, DRIVE_CONFIDENCE_RULE } from '../src/drive-board.js';
import { firstDriveForecast, prepareFirstDriveContext } from '../src/first-drive.js';
import { sortPlayers, SORTS, SORT_GROUPS } from '../src/ranking.js';
const D = JSON.parse(fs.readFileSync(new URL('../archive/drives/2026/w9.json', import.meta.url)));
const player = { id: '7594', gsis: '00-0036555', pos: 'RB', team: 'CAR', opp: 'DEN', chance: .5, tdConf: { level: 'High' } };
const fake = values => ({ games: values.map(hit => ({ hit })), offense: { n: 10 }, defense: { n: 10 } });

test('confidence is sample/stability/shrinkage support, not just probability or TD confidence', () => {
  const conf = (values, prob, td = false) => driveEstimateConfidence(fake(values), g => g.hit, prob, td).level;
  assert.equal(conf([1, 1, 1], .99), 'Low');
  assert.equal(conf([1, 1, 1, 1, 1, 1, 1], .95), 'High');
  assert.equal(conf([1, 1, 1, 1], .95), 'Med');
  assert.equal(conf([1, 0, 0, 0, 1, 1, 1], .55), 'Low', 'unstable recent usage');
  assert.equal(conf([1, 1, 1, 1, 1, 1, 1], .5), 'Low', 'large shrinkage/matchup displacement');
  assert.equal(conf([0, 0, 0, 0, 0, 0, 0], .01), 'Low', 'no positive evidence');
  assert.equal(conf([1, 1, 1, 1, 1, 1, 1], .95, true), 'Med', 'TD stricter sample requirement');
  assert.equal(conf(Array(10).fill(1), .95, true), 'High');
  const shortDefense = fake(Array(10).fill(1)); shortDefense.defense.n = 3;
  assert.equal(driveEstimateConfidence(shortDefense, g => g.hit, .95, true).level, 'Low');
  assert.match(DRIVE_CONFIDENCE_RULE, /not validated model confidence/);
});

test('drive sort orders its own tier first, then probability, missing last, stable id tiebreak', () => {
  const row = (id, level, probability) => ({ id, chance: 1 - (probability || 0), tdConf: { level: 'High' }, drivePatterns: probability == null ? {} : { touch: { probability, confidence: { level } } } });
  const rows = [row('low', 'Low', .99), row('med', 'Med', .9), row('h2', 'High', .4), row('h1', 'High', .6), row('missing', null, null)];
  const before = JSON.stringify(rows);
  assert.deepEqual(sortPlayers(rows, 'fdTouchConf').map(p => p.id), ['h1', 'h2', 'med', 'low', 'missing']);
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(SORT_GROUPS.find(g => g[0] === 'Drive patterns')[1], ['fdTouchConf', 'fdRush10Conf', 'fdRec10Conf', 'fdTdConf']);
  for (const key of ['fdTouchConf', 'fdRush10Conf', 'fdRec10Conf', 'fdTdConf']) assert.ok(SORTS[key].drive);
});

test('prepared context matches ordinary forecasts; board adds copies only and invalidates by drive-file identity', () => {
  const before = JSON.stringify(D), frozen = Object.freeze({ ...player });
  assert.deepEqual(firstDriveForecast(D, player, player.opp, prepareFirstDriveContext(D)), firstDriveForecast(D, player, player.opp));
  const [row] = attachDrivePatterns(D, [frozen]);
  const F = firstDriveForecast(D, player, player.opp);
  assert.equal(row.drivePatterns.touch.probability, F.prediction.touch);
  assert.equal(row.drivePatterns.rush10.probability, F.yardage.outcomes.find(o => o.key === 'rush10').probability);
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

const CHROME = '/usr/bin/google-chrome';
test('Board Drive patterns sorts persist, display probability/tier on all layouts, and fit phones', { skip: !fs.existsSync(CHROME) && 'no chrome', timeout: 300000 }, async () => {
  const { chromium } = await import('playwright-core');
  const { createServer } = await import('../server/server.js');
  const { server } = await createServer({ dbFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ez-drive-board-')), 'a.sqlite'), log: () => {} });
  await new Promise(r => server.listen(0, r));
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, timezoneId: 'America/Chicago' });
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto(`http://127.0.0.1:${server.address().port}`); await p.waitForSelector('.game', { timeout: 180000 });
    await p.click('#tab-board');
    assert.equal(await p.locator('#bsort optgroup[label="Drive patterns"] option').count(), 4);
    const rank = { High: 0, Med: 1, Low: 2 };
    for (const key of ['fdTouchConf', 'fdRush10Conf', 'fdRec10Conf', 'fdTdConf']) {
      await p.selectOption('#bsort', key);
      await p.waitForSelector('#view-board .focuslist [data-drive-tier]');
      const cells = await p.locator('#view-board .focuslist [data-drive-tier]').evaluateAll(cs => cs.map(c => ({ tier: c.dataset.driveTier, prob: +c.dataset.driveProb })));
      assert.ok(cells.length > 10);
      for (let i = 1; i < cells.length; i++) assert.ok(rank[cells[i - 1].tier] < rank[cells[i].tier] || (rank[cells[i - 1].tier] === rank[cells[i].tier] && cells[i - 1].prob >= cells[i].prob));
      assert.match(await p.locator('#view-board .focuslist .fhead').textContent(), /Drive 1/);
    }
    await p.selectOption('#bsort', 'fdTouchConf');
    for (const [width, height] of [[390, 844], [844, 390]]) {
      await p.setViewportSize({ width, height });
      await p.waitForTimeout(250);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width} phone overflow`);
    }
    await p.setViewportSize({ width: 390, height: 1300 });
    await p.waitForTimeout(250);
    const top = await p.locator('#view-board .focuslist .frow:not(.fhead)').evaluateAll(rs => rs.slice(0, 5).map(r => {
      const c = r.querySelector('[data-drive-tier]'); return { name: r.querySelector('.fplayer .plink')?.innerText, tier: c?.dataset.driveTier, probability: +c?.dataset.driveProb };
    }));
    fs.writeFileSync('/tmp/endzone-drive-board-top5.json', JSON.stringify(top, null, 2));
    await p.screenshot({ path: '/tmp/endzone-drive-board-4.24.7-phone.png' });
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
    assert.equal(await p.inputValue('#bsort'), 'fdTouchConf');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
