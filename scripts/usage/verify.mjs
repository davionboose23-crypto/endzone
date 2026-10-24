// Walk-forward check of the SHIPPED usage leg + 3-way blend against the engine's historical forecasts.
// For every test week the usage model is refit on strictly earlier player-games (exactly what build.mjs ships),
// then joined to the replayed engine rows (data/hist/x-<tag>-<season>.json) and, for 2026, the prospective snapshots.
// Usage: node scripts/usage/verify.mjs [--tag chk2] [--alt nopull] [--cache /tmp/usage-cache-v.json] [--out data/hist/usage-verify.json]
import fs from 'node:fs';
import { loadSeason, loadSchedule, combine } from './lib.mjs';
import { buildWeek } from './build.mjs';
import { usageLookup, blendProbability, cll, eta, monitorReport } from '../../src/usage-model.js';
import { pairedBoot, summary, r4 } from '../hist/metrics.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const tag = arg('tag', 'chk2'), alt = arg('alt', 'nopull'), cachef = arg('cache', '/tmp/ez/usage-cache-v.json');
let C;
if (fs.existsSync(cachef)) { const j = JSON.parse(fs.readFileSync(cachef)); j.seasons.forEach(S => { S.posOf = new Map(S.posOf); }); C = combine(j.seasons, j.schedule); }
else { const seasons = []; for (const s of [2023, 2024, 2025, 2026]) seasons.push(await loadSeason(s, console.error)); const schedule = await loadSchedule();
  fs.writeFileSync(cachef, JSON.stringify({ seasons: seasons.map(S => ({ ...S, posOf: [...S.posOf] })), schedule })); C = combine(seasons, schedule); }
const read = (t, s) => { try { return JSON.parse(fs.readFileSync(`data/hist/x-${t}-${s}.json`)); } catch { return []; } };
const rows = [];
for (const s of [2025, 2026]) {
  const A = new Map(read(alt, s).map(r => [`${r.gameId}|${r.id}`, r.chance]));
  for (const r of read(tag, s)) if (r.published > 0 && r.chance > 0) rows.push({ src: 'hist', season: s, week: r.week, gameId: r.gameId, id: String(r.id), pos: r.pos, role: r.role, glShare: r.glShare, side: r.side, spread: r.spread, implied: r.implied, chance: r.chance, alt: A.get(`${r.gameId}|${r.id}`) ?? null, published: r.published, y: r.y, vol: r.vol });
}
for (const w of [6, 7]) { // prospective: latest pre-kickoff snapshot actually published at the time
  const of = `archive/2026/outcomes-w${w}.json`; if (!fs.existsSync(of)) continue; const oc = JSON.parse(fs.readFileSync(of));
  for (const f of fs.readdirSync(`archive/2026/w${w}`)) { const a = JSON.parse(fs.readFileSync(`archive/2026/w${w}/${f}`)); const p = a.latest?.payload || a.first.payload; const L = p.lines || {};
    for (const pl of p.players) { const o = oc[`${p.gameId}|${pl.id}`]; const pub = pl.published?.probability ?? (typeof pl.published === 'number' ? pl.published : null);
      if (!o?.payload || o.payload.status === 'missing' || !(pub > 0) || !(pl.chance > 0)) continue; const home = p.gameId.split('_')[3] === pl.team;
      rows.push({ src: 'prosp', season: 2026, week: w, gameId: p.gameId, id: String(pl.id), gsis: pl.gsis || null, pos: pl.pos, role: pl.role, glShare: pl.glShare, side: home ? 'home' : 'away', spread: home ? L.homeSpread : L.awaySpread, implied: home ? L.homeImplied : L.awayImplied, chance: pl.chance, alt: null, published: pub, y: o.payload.td > 0 ? 1 : 0, vol: pl.vol }); } } }
const tables = new Map(); const look = (s, w) => { const k = `${s}|${w}`; if (!tables.has(k)) tables.set(k, usageLookup(buildWeek(C, s, w))); return tables.get(k); };
let miss = 0;
for (const r of rows) {
  const u = look(r.season, r.week)(r, { implied: r.implied, spread: r.spread, home: r.side === 'home' }); if (u == null) miss++;
  r.usage = u ?? r.chance; // missing usage -> neutral (falls back to 2-way below)
  const b3 = blendProbability({ chance: r.chance, published: r.published, usage: u }); r.blend3 = b3.p;
  r.blend3nc = cll((eta(r.chance) + eta(r.published) + (u != null ? eta(u) : 0)) / (u != null ? 3 : 2)); // no .62 ceiling
  r.blend2 = blendProbability({ chance: r.chance, published: r.published }).p; r.usageOnly = u ?? r.published;
  if (r.alt != null) r.blend3alt = blendProbability({ chance: r.alt, published: r.published, usage: u }).p;
}
const k1000 = x => r4(x * 1000);
const cmp = (R, a, b) => { const q = pairedBoot(R, a, b); return { n: q.n, games: q.games, dB: k1000(q.dBrier), dBci: q.dBrierCI.map(k1000), dLL: k1000(q.dLogLoss), dLLci: q.dLogLossCI.map(k1000) }; };
const sets = {
  research: rows.filter(r => r.season === 2025 || (r.src === 'hist' && r.week <= 5) || (r.src === 'prosp' && r.week === 6)),
  hist2025: rows.filter(r => r.src === 'hist' && r.season === 2025), hist2026: rows.filter(r => r.src === 'hist' && r.season === 2026),
  prosp: rows.filter(r => r.src === 'prosp'),
};
const out = { tag, alt, builtAt: new Date().toISOString(), usageMissing: miss, rows: rows.length, sets: {} };
for (const [n, R] of Object.entries(sets)) {
  const H = R.filter(r => r.blend3alt != null);
  out.sets[n] = { n: R.length, model: summary(R, 'chance'), sleeper: summary(R, 'published'), blend3: summary(R, 'blend3'),
    blend3_vs_model: cmp(R, 'blend3', 'chance'), blend3_vs_sleeper: cmp(R, 'blend3', 'published'), blend2_vs_model: cmp(R, 'blend2', 'chance'),
    usage_vs_model: cmp(R, 'usageOnly', 'chance'), ceiling_effect: cmp(R, 'blend3', 'blend3nc'),
    ...(H.length ? { pubBlend: { n: H.length, blendWithPull_vs_blendNoPull: cmp(H, 'blend3', 'blend3alt'), modelWithPull_vs_noPull: cmp(H, 'chance', 'alt') } } : {}) };
}
fs.writeFileSync(arg('out', 'data/hist/usage-verify.json'), JSON.stringify(out, null, 1));
// committed baseline for the calibration view: walk-forward slices (research pool) + headline numbers
const R0 = sets.research; const mon = monitorReport(R0.map(r => ({ ...r, challenger: r.blend3 })), { label: 'walk-forward: 2025 + 2026 w1–5 replay + w6 prospective (usage leg refit weekly, strictly earlier games)' });
const H = out.sets.research;
const baseline = { builtAt: out.builtAt, label: mon.label, n: R0.length, headline: { vsModel: H.blend3_vs_model, vsSleeper: H.blend3_vs_sleeper, twoWayVsModel: H.blend2_vs_model, usageOnlyVsModel: H.usage_vs_model, ceilingEffect: H.ceiling_effect, pubBlend: H.pubBlend },
  byYear: { hist2025: out.sets.hist2025.blend3_vs_model, hist2026: out.sets.hist2026.blend3_vs_model, prosp: out.sets.prosp.blend3_vs_model }, slices: mon.slices, teGap: mon.teGap };
if (!process.argv.includes('--no-baseline')) fs.writeFileSync('src/blend-baseline.json', JSON.stringify(baseline, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
