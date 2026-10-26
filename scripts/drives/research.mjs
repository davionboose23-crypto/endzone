// Walk-forward research for the drive-trends agent: for every target week, detect patterns on strictly earlier
// drives (season s-1 + s before w), then score each one on week w itself. Reports how many exact drive-number and
// phase patterns survive FDR, and how much of their predicted lift holds out of sample (retention: 1 = fully, 0 = none).
// Usage: node scripts/drives/research.mjs --tables /tmp/ez [--out data/hist/drive-research.json]
import fs from 'node:fs';
import { detect, weekRows, scoreRows } from '../../src/drive-patterns.js';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
export function loadTables(dir, seasons) { return seasons.map(s => `${dir}/drives-${s}.json`).filter(f => fs.existsSync(f)).map(f => JSON.parse(fs.readFileSync(f))); }
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
export function retention(items, B = 1000) {
  const tot = a => { let num = 0, den = 0; for (const x of a) { const sg = x.E1 >= x.E0 ? 1 : -1; num += sg * (x.O - x.E0); den += sg * (x.E1 - x.E0); } return den > 1e-9 ? num / den : null; };
  if (!items.length) return { n: 0, retention: null, ciLo: null, ciHi: null };
  // sign-aligned so "fewer" patterns (E1 < E0) count the same way as "more" patterns
  const R = rng(7); const bs = []; for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < items.length; i++) s.push(items[(R() * items.length) | 0]); const v = tot(s); if (v != null) bs.push(v); }
  bs.sort((a, b) => a - b); const q = p => bs[Math.floor(p * (bs.length - 1))];
  return { n: items.length, retention: +tot(items).toFixed(3), ciLo: +q(0.025).toFixed(3), ciHi: +q(0.975).toFixed(3) };
}
// walk-forward over target weeks; returns per-family pooled OOS retention + per-pattern own records
export function walkForward(tables, targets, { q = 0.10, log = () => {} } = {}) {
  const inst = []; const runs = [];
  for (const [s, w] of targets) {
    const { tests } = detect(tables, s, w); const W = weekRows(tables, s, w); if (!W.size) continue;
    const surv = tests.filter(t => t.q <= q), raw = tests.filter(t => t.p < 0.05);
    const cnt = (L, f) => L.filter(t => t.fam === f).length;
    runs.push({ season: s, week: w, tests: tests.length, drive: { tests: cnt(tests, 'drive'), raw05: cnt(raw, 'drive'), fdr: cnt(surv, 'drive') }, phase: { tests: cnt(tests, 'phase'), raw05: cnt(raw, 'phase'), fdr: cnt(surv, 'phase') } });
    for (const t of raw) { const sc = scoreRows(W.get(t.pid), t); if (sc) inst.push({ s, w, pid: t.pid, fam: t.fam, sub: t.sub, metric: t.metric, q: t.q, p: t.p, ...sc }); }
    log(`${s} w${w}: ${tests.length} tests, drive# raw ${runs.at(-1).drive.raw05} fdr ${runs.at(-1).drive.fdr}, phase raw ${runs.at(-1).phase.raw05} fdr ${runs.at(-1).phase.fdr}`);
  }
  const fam = {};
  for (const f of ['drive', 'phase']) {
    fam[f] = { fdr: retention(inst.filter(x => x.fam === f && x.q <= q)), raw: retention(inst.filter(x => x.fam === f)), rawOnly: retention(inst.filter(x => x.fam === f && x.q > q)) };
  }
  return { runs, fam, inst };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = arg('tables', '/tmp/ez'); const tables = loadTables(dir, [2024, 2025, 2026]);
  const targets = [...Array.from({ length: 14 }, (_, i) => [2025, i + 5]), ...Array.from({ length: 6 }, (_, i) => [2026, i + 2])];
  const t0 = Date.now(); const R = walkForward(tables, targets, { log: console.log });
  const out = { builtAt: new Date().toISOString(), targets, runs: R.runs, families: R.fam, seconds: (Date.now() - t0) / 1000 };
  fs.writeFileSync(arg('out', 'data/hist/drive-research.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(R.fam, null, 1));
}
