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
    assert.equal(await p.locator('#panel .firstdrive').count(), 1, 'player page leads drive patterns with a first-drive forecast or explicit empty state');
    assert.equal(await p.locator('#panel [data-act=gotosim]').count(), 0, 'player page has no navigation to the Simulator');
    assert.equal(await p.locator('#playerSimOut [data-act=playersimrun]').count(), 1, 'player can run his sim here');
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
    await d.click('#panel [data-act=ai]'); await d.waitForSelector('#aiOut .card.ai', { timeout: 30000 });
    assert.match(await d.locator('#aiOut').innerText(), /Built-in review \(no AI key\)[\s\S]*Case for[\s\S]*Case against[\s\S]*Key risks/);
    assert.equal(await d.evaluate(() => localStorage.getItem('endzone.ai.v1')), null, 'no AI settings stored unless the user saves them');
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
    const lab = await d.locator('#view-lab').innerText(); assert.match(lab, /Trends agent validation/);
    await d.click('#tab-trends'); await d.waitForSelector('#view-trends .trendcard, #view-trends .card', { timeout: 60000 });
    const tv = await d.locator('#view-trends').innerText(); assert.match(tv, /Trends agent · week/);
    if (await d.locator('#view-trends .trendcard').count()) { assert.match(tv, /tracking, not yet proven|active|display only/); assert.match(tv, /pp/);
      await d.selectOption('#tfStatus', 'new'); const cards = await d.locator('#view-trends .trendcard').allInnerTexts(); assert.ok(cards.every(c => /New/.test(c))); }
    assert.deepEqual(errors, []);
  } finally { await b.close(); server.close(); }
});

// Deterministic lifecycle regression: exercise the shipped UI functions with a real
// engine result, without depending on this week's feeds or a long 10,000-game run.
test('UI: player sim runs in place, refreshes on progress/completion, and never takes over the game dashboard', async () => {
  const vm = await import('node:vm');
  const sim = await import('../src/sim.js');
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = name => { const a = src.indexOf(`function ${name}(`); assert.ok(a >= 0, name); return src.slice(a, src.indexOf('\n}', a) + 2); };
  const { I } = JSON.parse(fs.readFileSync(new URL('./fixtures/sim-inputs-2026w8-CAR-GB-492.json', import.meta.url)));
  const raw = sim.runSim(I, { n: 100, seed: 7 }), sum = sim.summarize(raw, I);
  const sp = sum.players.find(p => p.rec.mean + p.car.mean > 1);
  const game = { id: 'panel-game', sides: { away: { team: sum.away }, home: { team: sum.home } } };
  const p = { ...sp, chance: .25 }; delete p.gameId;
  const out = { innerHTML: '' }, panel = { gameId: game.id, playerId: p.id };
  const S = { week: 8, slate: { games: [game] }, panel, dv: { game: 'wrong-game' }, sim: { status: 'idle', key: '', pj: null, team: 'both', st: 'rec', th: 4, dst: 'rec', dth: 1 } };
  let runs = 0;
  const context = vm.createContext({ S, document: { getElementById: id => id === 'playerSimOut' ? out : null }, performance: { now: () => 10 },
    findPlayer: () => ({ p, g: game }), simChanceFor: () => null, simBlendKeep: () => {},
    esc: x => String(x ?? ''), pc: x => `${Math.round((x || 0) * 100)}%`, n1: x => (x || 0).toFixed(1),
    runSimUi: () => { runs++; Object.assign(S.sim, { status: 'running', key: `8|${sum.away}@${sum.home}|drive`, t0: 0 }); context.paintSim(); },
    SIM_LBL: { rec: 'Catches', car: 'Carries' }, playerDriveTable: sim.playerDriveTable,
    playerGameStat: sim.playerGameStat, pAtLeast: sim.pAtLeast, simPatterns: sim.simPatterns,
    simPhrase: (s, t) => `${t}+ ${s}`, simRange: () => 'range', sgn: x => x, sdiff: x => x,
    SIM_PRESETS: [], GAME_PRESETS: [], SLOT_TOP: {},
  });
  for (const name of ['simBars', 'simGapsHtml', 'simGameHtml', 'simRzHtml', 'simSitHtml', 'simDriveCardHtml', 'simTdHtml']) context[name] = () => '';
  context.simTop4Html = () => '<h3>Top 4</h3>'; context.simProfileHtml = () => '<h3>Profiles</h3>';
  for (const name of ['findSimPlayer', 'simRunForGame', 'paintPlayerSim', 'playerSimRun', 'playerSimDriveRows', 'playerSimBody', 'playerSimStoryHtml', 'simPlayerDriveHtml', 'simResultHtml', 'paintSim', 'simProgress', 'simDone']) vm.runInContext(fn(name), context);
  context.paintPlayerSim();
  assert.match(out.innerHTML, /data-act="playersimrun"/); assert.doesNotMatch(out.innerHTML, /gotosim|Open Simulator/);
  context.playerSimRun();
  assert.equal(S.dv.game, game.id, 'uses panel game, not undefined side-player gameId');
  assert.equal(S.dv.mode, undefined, 'does not switch to simulator mode'); assert.equal(S.panel, panel, 'panel stays open');
  assert.match(out.innerHTML, /Simulating/);
  context.playerSimRun(); assert.equal(runs, 1, 'no duplicate running sim');
  context.simProgress({ progress: { done: 250, n: 10000, phase: 'run' } }, S.sim.key);
  assert.match(out.innerHTML, /250 \/ 10,000/);
  context.simDone({ ok: false, error: 'test failure' }, S.sim.key);
  assert.match(out.innerHTML, /Simulation failed: test failure/); assert.match(out.innerHTML, /playersimrun/);
  context.playerSimRun();
  // Market comparison is display-only; no market is supplied by this fixture.
  context.vsMarket = () => ({});
  context.simDone({ ok: true, sum, raw, ms: 1 }, S.sim.key);
  assert.equal(S.panel, panel); assert.match(out.innerHTML, /A typical game for him/); assert.match(out.innerHTML, /What he does on each drive/);
  assert.doesNotMatch(out.innerHTML, /gotosim/);
  context.playerSimRun(); assert.equal(runs, 2, 'reuses matching completed result');
  S.sim.pj = sp.j;
  const dashboard = context.simResultHtml();
  for (const text of ['Top 4', 'Profiles', 'Result ·', 'Players · simulated', 'Game scripts', 'per-drive thresholds']) assert.ok(dashboard.includes(text), text);
  assert.doesNotMatch(dashboard, /A typical game for him|Back to full game|Switch player/);
  S.sim.sum = { ...sum, away: 'ATL', home: 'OTHER' }; context.paintPlayerSim();
  assert.match(out.innerHTML, /playersimrun/); assert.doesNotMatch(out.innerHTML, /A typical game for him/, 'wrong-game result never appears');
  assert.doesNotMatch(src, /S\.sim\.focus|applySimFocus/);
  assert.match(src, /const APP_VERSION = '4\.24\.9'/);
});
