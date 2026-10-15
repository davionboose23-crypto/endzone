// Direct held-out diff of x-<tag> vs x-<base> for one season, with game bootstrap; optional calibration by bin.
import fs from 'node:fs';
import { brier, logloss, pairedBoot, r4 } from './metrics.mjs';
const [tag, season, base = 'chk'] = process.argv.slice(2);
const L = t => JSON.parse(fs.readFileSync(`data/hist/x-${t}-${season}.json`));
const m = new Map(L(tag).map(r => [`${r.gameId}|${r.id}`, r])); const rows = L(base).filter(r => r.published != null).map(r => ({ ...r, cand: m.get(`${r.gameId}|${r.id}`)?.chance ?? r.chance }));
const bt = (rs, a = 'cand', b = 'chance') => { const x = pairedBoot(rs, a, b); return `n${x.n} dB ${r4(x.dBrier)} [${x.dBrierCI.map(r4)}] dLL ${r4(x.dLogLoss)} [${x.dLogLossCI.map(r4)}]`; };
console.log(`${tag} vs ${base} ${season}: cand ${r4(brier(rows, 'cand'))}/${r4(logloss(rows, 'cand'))} base ${r4(brier(rows, 'chance'))}/${r4(logloss(rows, 'chance'))} pub ${r4(brier(rows, 'published'))}/${r4(logloss(rows, 'published'))}`);
console.log('  all', bt(rows)); console.log('  teamCall', bt(rows.filter(r => r.teamCall))); console.log('  contributor', bt(rows.filter(r => r.contributor)));
console.log('  vs pub', bt(rows, 'cand', 'published'));
