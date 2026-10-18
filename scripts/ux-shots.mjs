// Headless audit screenshots of every screen at 390px and 1280px. Usage: node scripts/ux-shots.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
const out = process.argv[2] || 'shots'; const base = process.argv[3] || 'http://localhost:8787/';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const SIZES = process.env.SIZES ? process.env.SIZES.split(',').map(x => x.split('x').map(Number)) : [[390, 844], [1280, 900]];
for (const [w, h] of SIZES) {
  const p = await (await b.newContext({ viewport: { width: w, height: h }, isMobile: w < 1100 && !!process.env.MOBILE, hasTouch: !!process.env.MOBILE })).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  const shot = async n => { await p.waitForTimeout(400); await p.screenshot({ path: `${out}/${n}-${w}x${h}.png`, fullPage: !!process.env.FULL && n !== 'panel' }); };
  await p.goto(base); await p.waitForSelector('.game', { timeout: 240000 }); await shot('slate');
  const ov = await p.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.tablewrap,.reswrap,[tabindex]')).slice(0, 8).map(e => e.tagName + '.' + e.className));
  console.log(`${w}x${h}`, 'overflow', JSON.stringify(ov));
  await p.locator('.game').first().click(); await p.waitForSelector('[data-act=back]'); await shot('matchup');
  await p.locator('#matchup [data-act=player]:visible').first().click(); await p.waitForSelector('#panel:not([hidden]) h3', { timeout: 60000 }); await shot('panel');
  const m = await p.evaluate(() => { const pn = document.getElementById('panel'); const c = pn.querySelector('[data-act=close]').getBoundingClientRect(); const hd = document.querySelector('.top').getBoundingClientRect();
    return { header: Math.round(hd.height), headerPct: Math.round(100 * hd.height / innerHeight), panelScroll: pn.scrollHeight > pn.clientHeight, panelOverflowY: getComputedStyle(pn).overflowY, closeVisible: c.top >= 0 && c.bottom <= innerHeight && c.right <= innerWidth, docOverflowX: document.documentElement.scrollWidth > innerWidth + 1 }; });
  console.log(`${w}x${h}`, JSON.stringify(m));
  await p.click('[data-act=close]'); await p.click('[data-act=back]');
  const r = p.locator('[data-act=slateview][data-view=results]'); if (await r.count()) { await r.click(); await shot('results'); await p.locator('[data-act=slateview][data-view=games]').click(); }
  for (const t of ['board', 'trends', 'lab']) { await p.click(`#tab-${t}`); await p.waitForTimeout(800); await shot(t); }
  await p.click('#tab-slate'); await p.click('#focusBtn'); await p.locator('.game').first().click(); await shot('focus-matchup'); await p.click('#focusBtn');
  console.log(w, 'errors', JSON.stringify(errs));
}
await b.close();
