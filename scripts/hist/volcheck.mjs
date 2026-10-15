import fs from 'node:fs';
const tag = process.argv[2] || 'budget';
for (const s of [2024, 2025, 2026]) { const r = JSON.parse(fs.readFileSync(`data/hist/${tag}-${s}.json`)); console.log(s);
  for (const m of ['rushYd', 'rec', 'recYd', 'passYd']) { const rs = r.filter(x => x.volume[m] && x.actualVol[m] != null && (m !== 'passYd' || x.pos === 'QB')); if (!rs.length) continue;
    const st = a => ({ n: a.length, mae: +(a.reduce((t, x) => t + Math.abs(x.volume[m].mean - x.actualVol[m]), 0) / a.length).toFixed(2), bias: +(a.reduce((t, x) => t + x.volume[m].mean - x.actualVol[m], 0) / a.length).toFixed(2), cov: +(a.filter(x => x.actualVol[m] >= x.volume[m].lo && x.actualVol[m] <= x.volume[m].hi).length / a.length).toFixed(3), below: +(a.filter(x => x.actualVol[m] < x.volume[m].lo).length / a.length).toFixed(3), above: +(a.filter(x => x.actualVol[m] > x.volume[m].hi).length / a.length).toFixed(3) });
    const thr = { rushYd: 25, rec: 2, recYd: 25, passYd: 150 }[m];
    console.log(' ', m, 'all', JSON.stringify(st(rs)), 'meaningful', JSON.stringify(st(rs.filter(x => x.volume[m].mean >= thr)))); } }
