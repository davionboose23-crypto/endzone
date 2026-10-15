// Walk-forward volume recalibration: per metric x tier, fit on prior weeks/seasons only.
import fs from 'node:fs';
import { THR, fitVolCal, applyVolCal } from '../../src/calibration.js';
const tierOf = (m, mean) => (mean >= THR[m] ? 'hi' : 'lo');
export { fitVolCal };
if (process.argv[1].endsWith('volcal.mjs')) {
  const tag = process.argv[2] || 'budget';
  const all = {}; for (const s of [2024, 2025, 2026]) all[s] = JSON.parse(fs.readFileSync(`data/hist/${tag}-${s}.json`));
  for (const s of [2025, 2026]) {
    const res = {}; const weeks = [...new Set(all[s].map(r => r.week))].sort((a, b) => a - b);
    for (const w of weeks) {
      const train = [...Object.keys(all).filter(y => +y < s).flatMap(y => all[y]), ...all[s].filter(r => r.week < w)];
      const cal = fitVolCal(train);
      for (const x of all[s].filter(r => r.week === w)) for (const m of Object.keys(THR)) {
        if (!x.volume[m] || x.actualVol[m] == null || (m === 'passYd' && x.pos !== 'QB')) continue;
        const v2 = applyVolCal(cal, m, x.volume[m]); const a = x.actualVol[m];
        for (const [lab, v] of [['before', x.volume[m]], ['after', v2]]) for (const t of ['all', tierOf(m, x.volume[m].mean)]) {
          const k = `${m}|${t}|${lab}`; const o = (res[k] ||= { n: 0, ae: 0, cov: 0, w: 0 });
          o.n++; o.ae += Math.abs(v.mean - a); o.cov += a >= v.lo && a <= v.hi; o.w += v.hi - v.lo; } } }
    console.log(s); for (const m of Object.keys(THR)) for (const t of ['all', 'hi']) { const b = res[`${m}|${t}|before`], a = res[`${m}|${t}|after`]; if (!b) continue;
      console.log(`  ${m} ${t === 'hi' ? 'meaningful' : 'all'} n${b.n} MAE ${(b.ae / b.n).toFixed(2)}->${(a.ae / a.n).toFixed(2)} cov ${(b.cov / b.n).toFixed(3)}->${(a.cov / a.n).toFixed(3)} width ${(b.w / b.n).toFixed(1)}->${(a.w / a.n).toFixed(1)}`); }
  }
  const final = fitVolCal(Object.values(all).flat()); console.log(final);
}
