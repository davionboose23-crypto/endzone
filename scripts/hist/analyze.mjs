import fs from 'node:fs';
import { summary, pairedBoot, r4 } from './metrics.mjs';
const tag = process.argv[2] || 'base';
for (const season of [2024, 2025, 2026]) {
  const rows = JSON.parse(fs.readFileSync(`data/hist/${tag}-${season}.json`)).filter(r => r.published != null);
  const seg = { all: () => true, QB: r => r.pos === 'QB', RB: r => r.pos === 'RB', WR: r => r.pos === 'WR', TE: r => r.pos === 'TE',
    'chance<10': r => r.chance < .1, 'chance10-25': r => r.chance >= .1 && r.chance < .25, 'chance25-40': r => r.chance >= .25 && r.chance < .4, 'chance40+': r => r.chance >= .4,
    favorite: r => r.spread < -3, underdog: r => r.spread > 3, goalLine: r => (r.glShare || 0) >= .3, thin: r => (r.gamesPlayed || 0) < 3, teamCall: r => r.teamCall, contributor: r => r.contributor, High: r => r.tdConf === 'High' };
  console.log(`\n== ${season} (${tag}) matched rows`);
  for (const [k, f] of Object.entries(seg)) { const rs = rows.filter(f); if (rs.length < 30) { console.log(k, 'n', rs.length); continue; } const b = pairedBoot(rs, 'chance', 'published', { B: 300 });
    console.log(k.padEnd(12), 'n', String(rs.length).padStart(5), 'model', JSON.stringify(summary(rs, 'chance')), 'pub', JSON.stringify(summary(rs, 'published')), 'dBrier', r4(b.dBrier), b.dBrierCI.map(r4), 'meanP', r4(rs.reduce((s, r) => s + r.chance, 0) / rs.length), 'meanPub', r4(rs.reduce((s, r) => s + r.published, 0) / rs.length), 'rate', r4(rs.reduce((s, r) => s + r.y, 0) / rs.length)); }
}
