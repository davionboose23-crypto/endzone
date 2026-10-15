// node scripts/hist/compare.mjs <tagA> <tagB> [seasons]  — held-out comparison with game-level bootstrap.
import fs from 'node:fs';
import { summary, pairedBoot, r4 } from './metrics.mjs';
const [A, B] = [process.argv[2], process.argv[3]]; const seasons = (process.argv[4] || '2025,2026').split(',').map(Number);
const res = {};
for (const s of seasons) {
  const a = JSON.parse(fs.readFileSync(`data/hist/${A}-${s}.json`)), b = new Map(JSON.parse(fs.readFileSync(`data/hist/${B}-${s}.json`)).map(r => [r.gameId + '|' + r.id, r]));
  const rows = a.map(r => { const o = b.get(r.gameId + '|' + r.id); return o && r.published != null ? { gameId: r.gameId, y: r.y, A: r.chance, B: o.chance, P: r.published, teamCall: r.teamCall, teamCallB: o.teamCall, contributor: r.contributor, highA: r.tdConf === 'High', highB: o.tdConf === 'High', pos: r.pos } : null; }).filter(Boolean);
  const groups = { all: () => true, teamCall: r => r.teamCall, contributor: r => r.contributor, QB: r => r.pos === 'QB', RB: r => r.pos === 'RB', WR: r => r.pos === 'WR', TE: r => r.pos === 'TE' };
  res[s] = {};
  for (const [g, f] of Object.entries(groups)) {
    const rs = rows.filter(f); if (rs.length < 30) { res[s][g] = { n: rs.length }; continue; }
    const ab = pairedBoot(rs, 'B', 'A', { B: 1000 }), bp = pairedBoot(rs, 'B', 'P', { B: 1000 }), ap = pairedBoot(rs, 'A', 'P', { B: 1000 });
    res[s][g] = { n: rs.length, games: ab.games, [A]: summary(rs, 'A'), [B]: summary(rs, 'B'), published: summary(rs, 'P'),
      [`${B}-${A}`]: { dBrier: r4(ab.dBrier), ci: ab.dBrierCI.map(r4), dLogLoss: r4(ab.dLogLoss), ci2: ab.dLogLossCI.map(r4) },
      [`${A}-pub`]: { dBrier: r4(ap.dBrier), ci: ap.dBrierCI.map(r4), dLogLoss: r4(ap.dLogLoss), ci2: ap.dLogLossCI.map(r4) },
      [`${B}-pub`]: { dBrier: r4(bp.dBrier), ci: bp.dBrierCI.map(r4), dLogLoss: r4(bp.dLogLoss), ci2: bp.dLogLossCI.map(r4) } };
  }
  // team calls by each version's own picks (hit rate)
  const tc = (rowsAll, key) => { const t = rowsAll.filter(r => r.teamCall); return `${t.filter(r => r.y).length}/${t.length}`; };
  res[s].teamCallHits = { [A]: tc(a), [B]: tc([...b.values()]) };
}
console.log(JSON.stringify(res, null, 1));
fs.writeFileSync(`data/hist/compare-${A}-vs-${B}.json`, JSON.stringify(res, null, 1));
