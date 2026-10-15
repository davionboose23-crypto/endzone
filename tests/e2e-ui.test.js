// Live-data browser test (real feeds + headless Chrome). Skips if Chrome is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const CHROME = '/usr/bin/google-chrome';
test('UI: phone matchup replaces slate, mobile passing TD, accessible panel, board persistence, desktop side panel', { skip: !fs.existsSync(CHROME) && 'no chrome', timeout: 240000 }, async () => {
  const { chromium } = await import('playwright-core');
  const { createServer } = await import('../server/server.js');
  const { server } = await createServer({ dbFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ez-ui-')), 'a.sqlite'), log: () => {} });
  await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); await ctx.addInitScript(() => { if (localStorage.getItem('endzone.view.v1') === null) localStorage.setItem('endzone.view.v1', 'false'); }); const p = await ctx.newPage();
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto(base); await p.waitForSelector('.game', { timeout: 180000 });
    assert.equal(await p.locator('footer').innerText(), 'Research model, not a sportsbook. The anytime number is a probability. Edge is that probability minus the published projection, not a sportsbook price. Rosters are current, so a midseason trade can put an earlier week on the new team.');
    assert.equal(await p.locator('.wordmark').innerText(), 'ENDZONE');
    const body = await p.locator('body').innerText(); assert.ok(!/\b(odds|juice|bet)\b/i.test(body), 'banned product terms absent');
    await p.locator('.game').first().click(); await p.waitForSelector('[data-act=back]');
    assert.equal(await p.locator('.slate-layout > div').first().isHidden(), true, 'phone: slate list replaced by matchup');
    const qbCard = p.locator('#matchup .cards-mobile .card', { hasText: 'Pass TD' }).first();
    assert.match(await qbCard.innerText(), /Pass TD\s+\d+\.\d/, 'mobile passing TD visible with one decimal');
    const teams = await p.locator('#matchup .card h3').allInnerTexts(); assert.equal(teams.length, 2, 'both teams listed');
    const opener = p.locator('#matchup .cards-mobile [data-act=player]').first(); await opener.click();
    await p.waitForSelector('#panel:not([hidden]) h3', { timeout: 30000 });
    assert.equal(await p.getAttribute('#panel', 'role'), 'dialog'); assert.equal(await p.getAttribute('#panel', 'aria-modal'), 'true');
    assert.equal(await p.evaluate(() => document.body.classList.contains('locked')), true, 'background scroll locked');
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.act), 'close', 'focus moved into panel');
    for (let i = 0; i < 400; i++) await p.keyboard.press('Tab');
    assert.equal(await p.evaluate(() => document.getElementById('panel').contains(document.activeElement)), true, 'focus trapped');
    assert.ok(await p.locator('#panel figure').count() >= 1, 'pies or empty states rendered');
    await p.keyboard.press('Escape'); assert.equal(await p.locator('#panel').isHidden(), true);
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.act), 'player', 'focus restored to opener');
    await p.click('[data-act=back]'); assert.equal(await p.locator('.game').first().isVisible(), true);
    // Board persistence
    await p.click('#tab-board'); await p.waitForSelector('#view-board .cards-mobile .card');
    await p.click('[data-act=pos][data-pos=QB]'); await p.selectOption('#bsort', 'passTd'); await p.check('#bhide');
    const star = p.locator('#view-board .cards-mobile [data-act=star]').first(); await star.click();
    const starred = await p.locator('#view-board [data-act=star][aria-pressed=true]').count(); assert.ok(starred >= 1);
    await p.reload(); await p.waitForSelector('.game', { timeout: 180000 }); await p.click('#tab-board'); await p.waitForSelector('#view-board .filters');
    assert.equal(await p.getAttribute('[data-act=pos][data-pos=QB]', 'aria-checked'), 'true'); assert.equal(await p.inputValue('#bsort'), 'passTd'); assert.equal(await p.isChecked('#bhide'), true);
    assert.ok(await p.locator('#view-board [data-act=star][aria-pressed=true]').count() >= 1, 'watchlist persisted');
    await p.check('#bwatch'); assert.ok(await p.locator('#view-board .cards-mobile .card').count() >= 1);
    // Desktop: side panel keeps list usable; wide table scrolls horizontally with hint
    const d = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await d.goto(base); await d.waitForSelector('.game', { timeout: 180000 }); await d.locator('.game').first().click();
    await d.waitForSelector('#matchup .tablewrap'); assert.ok(await d.locator('#matchup .scrollhint').count() >= 1);
    assert.equal(await d.locator('.slate-layout > div').first().isVisible(), true, 'desktop shows list beside matchup');
    await d.locator('#matchup .tablewrap [data-act=player]').first().click(); await d.waitForSelector('#panel:not([hidden])');
    assert.equal(await d.getAttribute('#panel', 'role'), 'complementary'); assert.equal(await d.locator('.game').first().isVisible(), true);
    const ow = await d.evaluate(() => { const t = document.querySelector('#matchup .tablewrap'); return t.scrollWidth > t.clientWidth; }); assert.equal(ow, true, 'horizontal scrolling');
    const hd = await d.evaluate(() => [...document.querySelectorAll('#matchup thead th')].map(t => t.textContent)); assert.ok(!hd.some(h => /pass/i.test(h)), 'no QB-only pass columns (user-requested deviation)');
    const qbRow = d.locator('#matchup tbody tr', { has: d.locator('.qbline') }).first();
    assert.match(await qbRow.innerText(), /Pass TD\s+\d+\.\d[\s\S]*Pass yds\s+\d+/, 'QB row shows inline pass TD (1 decimal) and pass yds');
    const nonQbLines = await d.locator('#matchup tbody tr:not(:has(.qbline))').count(); assert.ok(nonQbLines > 0);
    assert.deepEqual(errors, []);
  } finally { await b.close(); server.close(); }
});

test('UI: Focus view (default on for mobile, persisted), primary yardage per position; Lab pick tracker', { skip: !fs.existsSync(CHROME) && 'no chrome', timeout: 240000 }, async () => {
  const { chromium } = await import('playwright-core');
  const { createServer } = await import('../server/server.js');
  const { server } = await createServer({ dbFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ez-fc-')), 'a.sqlite'), log: () => {} });
  await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto(base); await p.waitForSelector('.game', { timeout: 180000 });
    assert.equal(await p.getAttribute('#focusBtn', 'aria-pressed'), 'true', 'focus default on for mobile');
    await p.locator('.game').first().click(); await p.waitForSelector('#matchup .focuslist');
    assert.equal(await p.locator('#matchup .cards-mobile').count(), 0);
    const heads = await p.locator('#matchup .fhead').first().innerText(); assert.match(heads, /Player[\s\S]*Anytime[\s\S]*TD conf/);
    const rowText = async pos => (await p.locator('#matchup .frow', { hasText: ` ${pos} ·` }).first().innerText().catch(() => ''));
    const rows = await p.locator('#matchup .frow:not(.fhead)').allInnerTexts();
    for (const t of rows) { const pos = (t.match(/\b(QB|RB|FB|WR|TE)\b/) || [])[1]; if (!pos) continue; const want = { QB: 'Pass yds', RB: 'Rush yds', FB: 'Rush yds', WR: 'Rec yds', TE: 'Rec yds' }[pos]; assert.ok(t.includes(want), `${pos} row shows ${want}`); assert.equal((t.match(/yds/g) || []).length, 1, 'single primary yardage line'); }
    void rowText;
    await p.click('#focusBtn'); await p.waitForSelector('#matchup .cards-mobile');
    await p.reload(); await p.waitForSelector('.game', { timeout: 180000 });
    assert.equal(await p.getAttribute('#focusBtn', 'aria-pressed'), 'false', 'toggle persisted');
    const d = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await d.goto(base); await d.waitForSelector('.game', { timeout: 180000 });
    assert.equal(await d.getAttribute('#focusBtn', 'aria-pressed'), 'false', 'desktop default full view');
    await d.click('#tab-lab'); await d.waitForSelector('#pickTracker', { timeout: 180000 });
    const pt = await d.locator('#pickTracker').innerText();
    assert.match(pt, /Prospective \(frozen pregame snapshots\)/); assert.match(pt, /Reconstructed \(earlier-week features/);
    assert.match(pt, /\d+\/\d+/);
    assert.deepEqual(errors, []);
  } finally { await b.close(); server.close(); }
});
