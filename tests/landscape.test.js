// endzone-4.5.1 phone/tablet landscape: compact header, no page-level horizontal overflow (tables scroll inside their
// own scroller), scrollable player panel with a visible Close button, and rotation keeps state without a reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const CHROME = '/usr/bin/google-chrome';
const SIZES = [[844, 390], [932, 430], [740, 360], [667, 375], [1180, 820]];
test('landscape layouts: header < 25% of height, no overflow, panel scrollable, close visible, rotation keeps state', { skip: !fs.existsSync(CHROME) && 'no chrome', timeout: 300000 }, async () => {
  const { chromium } = await import('playwright-core');
  const { createServer } = await import('../server/server.js');
  const { server } = await createServer({ dbFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ez-ls-')), 'a.sqlite'), log: () => {} });
  await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const measure = p => p.evaluate(() => {
    const pn = document.getElementById('panel'); const open = pn && !pn.hidden; const c = open ? pn.querySelector('[data-act=close]').getBoundingClientRect() : null;
    const offenders = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !e.closest('.tablewrap,.reswrap,#panel') && getComputedStyle(e).position !== 'fixed'; }).map(e => e.tagName + '.' + e.className).slice(0, 5);
    return { headerPct: document.querySelector('.top').getBoundingClientRect().height / innerHeight, docOverflow: document.documentElement.scrollWidth > innerWidth + 1, offenders,
      panelScrolls: open ? (pn.scrollHeight > pn.clientHeight && /auto|scroll/.test(getComputedStyle(pn).overflowY)) || [...pn.querySelectorAll('.pcol-a,.pcol-b')].some(x => x.scrollHeight > x.clientHeight) : null,
      closeVisible: c ? c.top >= 0 && c.bottom <= innerHeight && c.left >= 0 && c.right <= innerWidth && c.height >= 44 : null };
  });
  try {
    for (const [w, h] of SIZES) {
      const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true }); const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
      await p.goto(base); await p.waitForSelector('.game', { timeout: 180000 });
      let m = await measure(p); const tag = `${w}x${h}`;
      assert.ok(m.headerPct < 0.25, `${tag}: header ${Math.round(m.headerPct * 100)}% of height`); assert.ok(!m.docOverflow, `${tag}: no page overflow ${m.offenders}`);
      const tabs = await p.locator('[role=tab]').evaluateAll(ts => ts.map(t => t.getBoundingClientRect().height)); assert.ok(tabs.every(x => x >= 44), `${tag}: 44px tabs`);
      await p.locator('.game').first().click(); await p.waitForSelector('[data-act=back]');
      m = await measure(p); assert.ok(!m.docOverflow, `${tag}: matchup no page overflow ${m.offenders}`);
      await p.locator('#matchup [data-act=player]:visible').first().click(); await p.waitForSelector('#panel:not([hidden]) h3', { timeout: 60000 });
      m = await measure(p); assert.ok(m.panelScrolls, `${tag}: panel scrollable`); assert.ok(m.closeVisible, `${tag}: close button visible`);
      for (const t of ['board', 'trends', 'lab']) { await p.keyboard.press('Escape'); await p.click(`#tab-${t}`); await p.waitForTimeout(300); m = await measure(p); assert.ok(!m.docOverflow, `${tag} ${t}: no page overflow ${m.offenders}`); }
      assert.deepEqual(errors, []); await ctx.close();
    }
    // rotation portrait <-> landscape without a reload: keeps open player, board filter, scroll
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }); const p = await ctx.newPage();
    await p.goto(base); await p.waitForSelector('.game', { timeout: 180000 }); await p.evaluate(() => { window.__noReload = 1; });
    await p.click('#tab-board'); await p.click('[data-act=pos][data-pos=WR]'); await p.click('#tab-slate');
    await p.evaluate(() => window.scrollTo(0, 600)); const y0 = await p.evaluate(() => window.scrollY);
    await p.setViewportSize({ width: 844, height: 390 }); await p.waitForTimeout(400);
    assert.equal(await p.evaluate(() => window.__noReload), 1, 'no reload on rotation');
    assert.ok(Math.abs((await p.evaluate(() => window.scrollY)) - y0) < 400 || y0 === 0, 'scroll roughly kept');
    await p.locator('.game').first().click(); await p.locator('#matchup [data-act=player]:visible').first().click(); await p.waitForSelector('#panel:not([hidden]) h3', { timeout: 60000 });
    const who = await p.locator('#panelTitle').innerText();
    await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(400);
    assert.equal(await p.locator('#panel').isHidden(), false, 'panel stays open after rotation'); assert.equal(await p.locator('#panelTitle').innerText(), who, 'same player');
    await p.setViewportSize({ width: 844, height: 390 }); await p.waitForTimeout(400);
    assert.equal(await p.locator('#panelTitle').innerText(), who); assert.equal(await p.evaluate(() => window.__noReload), 1);
    await p.keyboard.press('Escape'); await p.click('#tab-board');
    assert.equal(await p.getAttribute('[data-act=pos][data-pos=WR]', 'aria-checked'), 'true', 'board filter kept');
    await ctx.close();
  } finally { await b.close(); server.close(); }
});
