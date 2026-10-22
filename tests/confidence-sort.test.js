// endzone-4.5.2: board "sort by model confidence" — TD confidence and each other-stat projection's own confidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { sortPlayers, SORTS, SORT_GROUPS } from '../src/ranking.js';
import { runEngine } from '../src/engine.js';
import { makeFixture } from './fixture.js';
const EARLY = Date.parse('2030-09-01T00:00:00Z');
const R = { High: 0, Med: 1, Low: 2 };
const mk = (id, td, chance, vc = {}, vol = {}, pos = 'WR') => ({ id, pos, chance, tdConf: { level: td }, volConf: Object.fromEntries(Object.entries(vc).map(([k, l]) => [k, { level: l }])), volume: Object.fromEntries(Object.entries(vol).map(([k, m]) => [k, { mean: m }])) });

test('conf sort: High > Med > Low, ties by chance desc', () => {
  const L = [mk('a', 'Low', 0.6), mk('b', 'Med', 0.2), mk('c', 'High', 0.3), mk('d', 'Med', 0.4), mk('e', 'High', 0.5)];
  assert.deepEqual(sortPlayers(L, 'conf').map(p => p.id), ['e', 'c', 'd', 'b', 'a']);
  assert.deepEqual(sortPlayers(L, 'default').map(p => p.id), ['e', 'c', 'a', 'd', 'b'], 'default still only lifts High');
});
test('other-stat confidence sorts: that stat\'s volConf first, then projected mean; missing last; pass yds QB-only', () => {
  const L = [mk('a', 'High', 0.5, { rushYd: 'Low' }, { rushYd: 90 }), mk('b', 'Low', 0.1, { rushYd: 'High' }, { rushYd: 20 }), mk('c', 'Med', 0.2, { rushYd: 'High' }, { rushYd: 60 }), mk('d', 'Med', 0.3), mk('e', 'Low', 0.2, { rushYd: 'Med' }, { rushYd: 40 })];
  assert.deepEqual(sortPlayers(L, 'rushYdConf').map(p => p.id), ['c', 'b', 'e', 'a', 'd']);
  const Q = [mk('w', 'High', 0.5, { passYd: 'High' }, { passYd: 1 }, 'WR'), mk('q1', 'Low', 0.1, { passYd: 'Med' }, { passYd: 250 }, 'QB'), mk('q2', 'Low', 0.1, { passYd: 'High' }, { passYd: 200 }, 'QB')];
  assert.deepEqual(sortPlayers(Q, 'passYdConf').map(p => p.id), ['q2', 'q1', 'w']);
  for (const [, ks] of SORT_GROUPS) for (const k of ks) assert.ok(SORTS[k], k);
  assert.deepEqual(Object.keys(SORTS).sort(), SORT_GROUPS.flatMap(g => g[1]).sort(), 'every sort is in the menu');
});
test('conf sorts on the real engine output are monotone in confidence', () => {
  const res = runEngine(makeFixture(), { now: EARLY }); const all = res.games.flatMap(G => [...G.sides.away.players, ...G.sides.home.players]);
  const c = sortPlayers(all, 'conf'); for (let i = 1; i < c.length; i++) { const d = R[c[i - 1].tdConf.level] - R[c[i].tdConf.level]; assert.ok(d < 0 || (d === 0 && c[i - 1].chance >= c[i].chance)); }
  for (const m of ['rushYd', 'recYd', 'rec']) { const s = sortPlayers(all, m + 'Conf').filter(p => p.volConf?.[m]); for (let i = 1; i < s.length; i++) assert.ok(R[s[i - 1].volConf[m].level] <= R[s[i].volConf[m].level], m); }
});
const CHROME = '/usr/bin/google-chrome';
test('board UI: confidence sort chosen from the menu, persists, orders cards, fits portrait + landscape phones', { skip: !fs.existsSync(CHROME) && 'no chrome', timeout: 300000 }, async () => {
  const { chromium } = await import('playwright-core'); const { createServer } = await import('../server/server.js');
  const { server } = await createServer({ dbFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ez-cs-')), 'a.sqlite'), log: () => {} });
  await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }); const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto(base); await p.waitForSelector('.game', { timeout: 180000 }); await p.click('#tab-board'); await p.waitForSelector('#view-board .filters');
    assert.ok(await p.locator('#bsort optgroup[label="Other stats by model confidence"] option[value=rushYdConf]').count() === 1);
    await p.selectOption('#bsort', 'conf'); await p.waitForTimeout(200);
    const levels = await p.locator('#view-board .focuslist [aria-label^="TD confidence"]').evaluateAll(cs => cs.map(c => c.getAttribute('aria-label').replace('TD confidence ', '')));
    assert.ok(levels.length > 5, 'portrait focus list rendered');
    for (let i = 1; i < levels.length; i++) assert.ok(R[levels[i - 1]] <= R[levels[i]], `cards ordered by confidence: ${levels.slice(0, 20)}`);
    for (const [w, h] of [[390, 844], [844, 390]]) { await p.setViewportSize({ width: w, height: h }); await p.waitForTimeout(300); assert.ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), `${w}x${h} no overflow`); assert.ok(await p.locator('#bsort').isVisible()); }
    await p.setViewportSize({ width: 390, height: 844 }); await p.selectOption('#bsort', 'recYdConf'); await p.waitForTimeout(200);
    { const ht = await p.locator('#view-board .focuslist .fhead').textContent(); assert.match(ht, /Rec yds/i, 'focus list shows the sorted stat: ' + ht); }
    const rl = await p.locator('#view-board .focuslist .frow:not(.fhead) span[role=cell]:last-child .chip').evaluateAll(cs => cs.map(c => c.textContent.trim()));
    for (let i = 1; i < rl.length; i++) assert.ok(R[rl[i - 1]] <= R[rl[i]], `rec yds confidence ordered: ${rl.slice(0, 20)}`);
    await p.reload(); await p.waitForSelector('.game', { timeout: 180000 }); await p.click('#tab-board'); await p.waitForSelector('#view-board .filters');
    assert.equal(await p.inputValue('#bsort'), 'recYdConf', 'sort persisted'); assert.deepEqual(errors, []); await ctx.close();
  } finally { await b.close(); server.close(); }
});
