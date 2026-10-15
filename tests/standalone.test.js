// Standalone single-file build: builds endzone-standalone.html, opens it from file:// (no server)
// in headless Chrome with LIVE feeds, and checks slate, panel, lab, sources labeling and persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const CHROME = '/usr/bin/google-chrome';
const FILE = new URL('../endzone-standalone.html', import.meta.url);
test('standalone file works from file:// with live Sleeper + schedule and labeled bundled nflverse rows', { skip: !fs.existsSync(CHROME) && 'no chrome', timeout: 300000 }, async () => {
  execFileSync(process.execPath, [new URL('../standalone/build.mjs', import.meta.url).pathname], { stdio: 'pipe' });
  const html = fs.readFileSync(FILE, 'utf8');
  assert.ok(!/src="\/(app|src)/.test(html) && !/href="\/styles\.css"/.test(html), 'no server-relative assets');
  const { chromium } = await import('playwright-core');
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); await ctx.addInitScript(() => { if (localStorage.getItem('endzone.view.v1') === null) localStorage.setItem('endzone.view.v1', 'false'); }); const p = await ctx.newPage();
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    const liveHits = new Set(); p.on('response', r => { const u = r.url(); if (r.ok() && /api\.sleeper\.app|raw\.githubusercontent\.com/.test(u)) liveHits.add(new URL(u).host); });
    await p.goto(FILE.href);
    await p.waitForSelector('.game', { timeout: 180000 });
    assert.ok(liveHits.has('api.sleeper.app') && liveHits.has('raw.githubusercontent.com'), 'Sleeper and schedule fetched live from the browser');
    assert.ok(await p.locator('.game').count() > 0);
    assert.match(await p.locator('#view-slate').innerText(), /WEEKLY RECOMMENDED SCORER[\s\S]*\d+(\.\d)?%/);
    assert.equal(await p.locator('footer').innerText(), 'Research model, not a sportsbook. The anytime number is a probability. Edge is that probability minus the published projection, not a sportsbook price. Rosters are current, so a midseason trade can put an earlier week on the new team.');
    await p.locator('.game').first().click(); await p.waitForSelector('[data-act=back]');
    await p.locator('#matchup .cards-mobile [data-act=player]').first().click();
    await p.waitForSelector('#panel:not([hidden]) h3', { timeout: 60000 });
    assert.match(await p.locator('#panel').innerText(), /anytime|Anytime/);
    await p.keyboard.press('Escape'); await p.click('[data-act=back]');
    await p.click('#tab-lab'); await p.waitForFunction(() => /Sources/.test(document.getElementById('view-lab')?.innerText || ''), null, { timeout: 120000 });
    const lab = await p.locator('#view-lab').innerText();
    assert.match(lab, /✓ Sleeper players(?! · stale)/, 'Sleeper live');
    assert.match(lab, /nflverse player ID map[^\n]*stale[^\n]*using rows captured/, 'blocked release feed labeled as bundled + stale');
    // persistence: board settings in localStorage, pregame frames in IndexedDB
    await p.click('#tab-board'); await p.waitForSelector('#view-board .cards-mobile .card'); await p.click('[data-act=pos][data-pos=QB]'); await p.waitForFunction(() => JSON.parse(localStorage.getItem('endzone.board.v1') || '{}').pos === 'QB');
    const frames = await p.evaluate(() => new Promise(res => { const r = indexedDB.open('endzone-standalone', 1); r.onsuccess = () => { const q = r.result.transaction('snapshots').objectStore('snapshots').count(); q.onsuccess = () => res(q.result); }; r.onerror = () => res(-1); }));
    await p.reload(); await p.waitForSelector('.game', { timeout: 180000 });
    await p.click('#tab-board'); await p.waitForSelector('#view-board .cards-mobile .card');
    assert.equal(await p.getAttribute('[data-act=pos][data-pos=QB]', 'aria-checked'), 'true', 'board filter persisted (localStorage)');
    const unplayed = await p.evaluate(() => document.querySelectorAll('.game').length);
    console.log(`standalone: games=${unplayed} pregame frames in IndexedDB=${frames}`);
    assert.ok(frames > 0, 'pregame frames saved in IndexedDB');
    assert.deepEqual(errors, []);
  } finally { await b.close(); }
});
