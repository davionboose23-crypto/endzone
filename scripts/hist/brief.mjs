import { execFileSync } from 'node:child_process';
const [A, B] = process.argv.slice(2);
const o = JSON.parse(execFileSync('node', ['scripts/hist/compare.mjs', A, B], { maxBuffer: 1e8 }).toString());
for (const [y, g] of Object.entries(o)) { console.log(y, 'teamCallHits', JSON.stringify(g.teamCallHits));
  for (const k of ['all', 'teamCall', 'contributor', 'QB', 'RB', 'WR', 'TE']) { const v = g[k]; if (!v?.[A]) continue;
    const d = v[`${B}-${A}`], p = v[`${B}-pub`];
    console.log(`  ${k.padEnd(11)} n${v.n} ${A} ${v[A].brier}/${v[A].logLoss} ${B} ${v[B].brier}/${v[B].logLoss} pub ${v.published.brier}/${v.published.logLoss} | ${B}-${A} dB ${d.dBrier} [${d.ci}] dLL ${d.dLogLoss} [${d.ci2}] | ${B}-pub dB ${p.dBrier} [${p.ci}] dLL ${p.dLogLoss} [${p.ci2}]`); } }
