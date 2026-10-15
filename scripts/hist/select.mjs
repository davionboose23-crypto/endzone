// Candidate selection, walk-forward at season level: value picked by log loss on earlier seasons, then tested held-out.
import fs from 'node:fs';
import { brier, logloss, pairedBoot, r4 } from './metrics.mjs';
const fams = JSON.parse(process.argv[2] || '{}'); const base = process.argv[3] || 'chk';
const load = (t, s) => { const f = `data/hist/x-${t}-${s}.json`; return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)).filter(r => r.published != null) : null; };
const B = {}; for (const s of [2024, 2025, 2026]) B[s] = load(base, s);
const join = (s, t) => { const m = new Map(load(t, s).map(r => [`${r.gameId}|${r.id}`, r.chance])); return B[s].map(r => ({ ...r, cand: m.get(`${r.gameId}|${r.id}`) ?? r.chance, pub: r.published })); };
const out = {};
for (const [fam, vals] of Object.entries(fams)) {
  const ll = {}; for (const t of vals) for (const s of [2024, 2025]) { const j = join(s, t); ll[t] = ll[t] || {}; ll[t][s] = { ll: logloss(j, 'cand'), b: brier(j, 'cand'), n: j.length }; }
  const baseLL = s => logloss(B[s], 'chance');
  const pick = seasons => { let best = base, bv = seasons.reduce((a, s) => a + baseLL(s) * B[s].length, 0); for (const t of vals) { const v = seasons.reduce((a, s) => a + ll[t][s].ll * ll[t][s].n, 0); if (v < bv - 1e-9) { bv = v; best = t; } } return best; };
  const res = { grid: Object.fromEntries(vals.map(t => [t, Object.fromEntries([2024, 2025, 2026].map(s => { const j = join(s, t); return [s, [r4(brier(j, 'cand')), r4(logloss(j, 'cand'))]]; }))])) };
  for (const [s, sel] of [[2025, [2024]], [2026, [2024, 2025]]]) {
    const t = pick(sel); if (t === base) { res[s] = { pick: base, note: 'no candidate value beat baseline on earlier seasons' }; continue; }
    const j = join(s, t); const g = k => j.filter(k);
    const bt = (rows) => { const b = pairedBoot(rows, 'cand', 'chance'); return { n: b.n, dB: r4(b.dBrier), dBCI: b.dBrierCI.map(r4), dLL: r4(b.dLogLoss), dLLCI: b.dLogLossCI.map(r4) }; };
    res[s] = { pick: t, all: bt(j), teamCall: bt(g(r => r.teamCall)), contributor: bt(g(r => r.contributor)), vsPub: (() => { const b = pairedBoot(j, 'cand', 'pub'); return { dB: r4(b.dBrier), dBCI: b.dBrierCI.map(r4), dLL: r4(b.dLogLoss), dLLCI: b.dLogLossCI.map(r4) }; })() };
  }
  out[fam] = res; console.log(fam, JSON.stringify({ 2025: res[2025], 2026: res[2026] }));
}
fs.writeFileSync(`data/hist/select-${base}.json`, JSON.stringify(out, null, 1));
