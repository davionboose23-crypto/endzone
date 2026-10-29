// Builds endzone-standalone.html: one self-contained file (app + worker + styles + bundled nflverse fallback).
import * as esbuild from 'esbuild';
import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const alias = { name: 'alias', setup(b) {
  b.onResolve({ filter: /^\/src\// }, a => ({ path: path.join(ROOT, a.path) }));
  b.onResolve({ filter: /live-feeds\.js$/ }, a => a.importer.includes('/server/') ? { path: path.join(ROOT, 'standalone/live-feeds-browser.js') } : undefined);
  b.onResolve({ filter: /feed-cache\.js$/ }, a => a.importer.includes('/server/') ? { path: path.join(ROOT, 'standalone/feed-cache-browser.js') } : undefined);
  b.onResolve({ filter: /archive\.js$/ }, a => a.importer.includes('/server/') ? { path: path.join(ROOT, 'standalone/empty.js') } : undefined);
} };
fs.writeFileSync(path.join(ROOT, 'standalone/empty.js'), 'export const Archive = null;\n');
const bundleJson = fs.readFileSync(path.join(ROOT, 'standalone/nflverse-bundle.json'));
const b64 = zlib.gzipSync(bundleJson, { level: 9 }).toString('base64');
const w = await esbuild.build({ entryPoints: [path.join(ROOT, 'standalone/sa-worker.js')], bundle: true, format: 'iife', write: false, minify: true, target: 'es2022', plugins: [alias], define: { __BUNDLE_B64__: JSON.stringify(b64) }, platform: 'browser' });
const workerCode = w.outputFiles[0].text;
const sw = await esbuild.build({ entryPoints: [path.join(ROOT, 'src/sim-worker.js')], bundle: true, format: 'iife', write: false, minify: true, target: 'es2022', plugins: [alias], platform: 'browser' });
const simCode = sw.outputFiles[0].text;
const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  .replace("const worker = new Worker('/src/worker.js', { type: 'module' });", "const worker = window.__ezMakeWorker();")
  .replace(/fetch\('\/api\/jobs\/refresh'/, "window.__ezJob('/api/jobs/refresh'");
if (!appSrc.includes('__ezMakeWorker') || !appSrc.includes('__ezJob')) throw new Error('app.js patch points not found');
const a = await esbuild.build({ stdin: { contents: appSrc, resolveDir: path.join(ROOT, 'public'), loader: 'js' }, bundle: true, format: 'esm', write: false, minify: true, target: 'es2022', plugins: [alias] });
let html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const bundle = JSON.parse(bundleJson);
const shim = `window.__EZ_WORKER__=${JSON.stringify(workerCode).replace(/<\/script/gi, '<\\/script')};
window.__ezMakeWorker=function(){
  // file:// pages cannot start workers in most browsers; run the same worker code in-page instead.
  var inPage = function(){ var w={onmessage:null,onerror:null}; var fs={onmessage:null};
    fs.postMessage=function(m){setTimeout(function(){w.onmessage&&w.onmessage({data:m});},0);};
    fs.fetch=fetch.bind(window); fs.addEventListener=function(){}; fs.__EZ_BASE__=location.href; window.__ezInPage=true;
    new Function('self','fetch','postMessage',window.__EZ_WORKER__)(fs,function(){return fs.fetch.apply(null,arguments);},fs.postMessage);
    w.postMessage=function(m){var c=structuredClone(m);setTimeout(function(){fs.onmessage&&fs.onmessage({data:c});},0);}; w.terminate=function(){}; return w; };
  if (location.protocol==='file:' || typeof Worker==='undefined') return inPage();
  try { return new Worker(URL.createObjectURL(new Blob(['self.__EZ_BASE__='+JSON.stringify(location.href)+';\\n'+window.__EZ_WORKER__],{type:'text/javascript'}))); } catch(e){ return inPage(); }
};
window.__EZ_SIM__=${JSON.stringify(simCode).replace(/<\/script/gi, '<\\/script')};
window.__ezMakeSimWorker=function(){ if (location.protocol==='file:' || typeof Worker==='undefined') return null; try { return new Worker(URL.createObjectURL(new Blob([window.__EZ_SIM__],{type:'text/javascript'}))); } catch(e){ return null; } };
window.__ezJob=async()=>new Response(JSON.stringify({ok:true,status:'standalone',details:{steps:['Standalone file: no server job. Each load or Refresh before kickoff saves pregame frames in this browser and recomputes lessons from finished games.']}}),{status:200,headers:{'content-type':'application/json'}});`;
const banner = `<div id="sa-note" class="small sa-note" role="note" tabindex="0" title="Tap to expand" onclick="this.classList.toggle('open')" onkeydown="if(event.key==='Enter')this.classList.toggle('open')" style="padding:6px 12px;background:#14202e;color:#cfd8e3">Standalone file — no server. Sleeper and the nflverse schedule load live in your browser. nflverse release files (rosters, ID map, weekly history, play-by-play, snaps, FTN) are blocked by browser CORS, so the copy captured ${bundle.capturedAt.slice(0, 16).replace('T', ' ')} UTC is used and labeled stale in Sources. Frames and settings are stored only in this browser.</div>`;
html = html.replace('<link rel="stylesheet" href="/styles.css">', () => `<style>${css}</style>`)
  .replace('<script type="module" src="/app.js"></script>', () => `<script>${shim}</script>\n<script type="module">${a.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`)
  .replace(/<body([^>]*)>/, (_, attrs) => `<body${attrs}>${banner}`);
if (html.includes('src="/app.js"') || html.includes('href="/styles.css"')) throw new Error('inline failed');
fs.writeFileSync(path.join(ROOT, 'endzone-standalone.html'), html);
console.log('wrote endzone-standalone.html', (html.length / 1024).toFixed(0), 'KB; worker', (workerCode.length / 1024).toFixed(0), 'KB; sim worker', (simCode.length / 1024).toFixed(0), 'KB; bundle b64', (b64.length / 1024).toFixed(0), 'KB');
