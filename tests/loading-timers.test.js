// Loading timers (spec §3): "Try again" at 20 s, plain timeout + cancel at 50 s.
// Uses a hanging /api/data and Playwright's fake clock in headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const CHROME = '/usr/bin/google-chrome';
test('loading timers: Try again at 20s, timeout + cancel at 50s', { skip: !fs.existsSync(CHROME) && 'no chrome', timeout: 120000 }, async () => {
  const { chromium } = await import('playwright-core');
  const { createServer } = await import('../server/server.js');
  const { server: real } = await createServer({ dbFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ez-tm-')), 'a.sqlite'), log: () => {} });
  let dataReqs = 0, aborted = 0;
  const front = http.createServer((req, res) => {
    if (req.url.startsWith('/api/data')) { dataReqs++; req.on('close', () => { if (!res.writableEnded) aborted++; }); res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.write('{"type":"stage","stage":1}\n'); return; } // never finishes
    real.emit('request', req, res);
  });
  await new Promise(r => front.listen(0, r)); const base = `http://127.0.0.1:${front.address().port}`;
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const p = await (await b.newContext()).newPage();
    await p.clock.install();
    await p.goto(base);
    await p.waitForFunction(() => !document.getElementById('loading').hidden);
    await p.waitForFunction(() => 1, null, { timeout: 2000 });
    assert.equal(await p.locator('#loading [data-act=retry]').count(), 0, 'no Try again before 20s');
    await p.clock.runFor(19000);
    assert.equal(await p.locator('#loading [data-act=retry]').count(), 0, 'still none at 19s');
    await p.clock.runFor(1500);
    assert.equal(await p.locator('#loading [data-act=retry]').count(), 1, 'Try again offered after 20s');
    assert.doesNotMatch(await p.locator('#loading').innerText(), /taking too long/);
    await p.clock.runFor(30000);
    const txt = await p.locator('#loading').innerText();
    assert.match(txt, /taking too long/); assert.match(txt, /within 50 seconds/); assert.match(txt, /cancelled/);
    assert.equal(await p.locator('#loading [data-act=retry]').count(), 1, 'retry offered at timeout');
    const t0 = Date.now(); while (aborted < 1 && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 100));
    assert.ok(aborted >= 1, 'abandoned /api/data request was cancelled');
    await p.click('#loading [data-act=retry]');
    const t1 = Date.now(); while (dataReqs < 2 && Date.now() - t1 < 5000) await new Promise(r => setTimeout(r, 100));
    assert.ok(dataReqs >= 2, 'retry issues a new request');
  } finally { await b.close(); front.close(); real.close(); }
});
