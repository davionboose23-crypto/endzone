// Walk-forward test: do drive-phase features improve TD forecasts? Adds four strictly pre-game drive features to
// the usage leg (red-zone-drive and goal-to-go-drive touch concentration, opening-script concentration, and the
// lead-vs-trail second-half split interacted with the spread), refits weekly exactly like the shipped leg, and
// compares against (a) the shipped usage leg, (b) the 4.6.0 model, (c) the 4.6.0 blend challenger, with
// game-bootstrap CIs (x1000). Same rows as scripts/usage/verify.mjs (replayed history + prospective snapshots).
// Usage: node scripts/drives/verify.mjs --tables /tmp/ez [--cache /tmp/ez/usage-cache-v.json] [--out data/hist/drive-verify.json]
import fs from 'node:fs';
import { loadSeason, loadSchedule, combine, priors, featureRow, linesFor, fitCloglog } from '../usage/lib.mjs';
import { buildWeek } from '../usage/build.mjs';
import { loadTables } from './research.mjs';
import { indexTables, playerDrives, PHASES } from '../../src/drive-patterns.js';
import { usageLookup, blendProbability, cll, USAGE_FEATURES, LINE_FEATURES } from '../../src/usage-model.js';
import { pairedBoot, summary, r4 } from '../hist/metrics.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const cachef = arg('cache', '/tmp/ez/usage-cache-v.json'); const tables = loadTables(arg('tables', '/tmp/ez'), [2022, 2023, 2024, 2025, 2026]);
let C;
if (fs.existsSync(cachef)) { const j = JSON.parse(fs.readFileSync(cachef)); j.seasons.forEach(S => { S.posOf = new Map(S.posOf); }); C = combine(j.seasons, j.schedule); }
else { const seasons = []; for (const s of [2023, 2024, 2025, 2026]) seasons.push(await loadSeason(s, console.error)); const schedule = await loadSchedule();
  fs.writeFileSync(cachef, JSON.stringify({ seasons: seasons.map(S => ({ ...S, posOf: [...S.posOf] })), schedule })); C = combine(seasons, schedule); }
// ---- drive features (pre-game: drives of seasons s-1 and s before week w)
export const DRIVE_FEATURES = ['dz_rz', 'dz_gtg', 'dz_open', 'dz_script'];
const M = 10; const ph = Object.fromEntries(PHASES.map(([k, , f]) => [k, f]));
const dfCache = new Map();
function driveFeats(s, w) {
  const k = `${s}|${w}`; if (dfCache.has(k)) return dfCache.get(k);
  const I = indexTables(tables, s, w); const out = new Map();
  for (const pid of I.byP.keys()) {
    const rows = playerDrives(I, pid).flatMap(x => x.rows); let x = 0, o = 0; const acc = {};
    for (const { d, r } of rows) { const t = r.tgt + r.car, ot = d.tgt + d.car; x += t; o += ot; for (const p of ['rz', 'gtg', 'open', 'lead2H', 'trail2H']) if (ph[p](d)) { const a = acc[p] || (acc[p] = [0, 0]); a[0] += t; a[1] += ot; } }
    if (!o || !x) continue; const base = x / o; const lr = p => { const a = acc[p] || [0, 0]; return Math.log(((a[0] + M * base) / (a[1] + M)) / base); };
    out.set(pid, { dz_rz: lr('rz'), dz_gtg: lr('gtg'), dz_open: lr('open'), split: lr('lead2H') - lr('trail2H') });
  }
  dfCache.set(k, out); return out;
}
const dfRow = (pid, s, w, spread) => { const f = driveFeats(s, w).get(pid) || { dz_rz: 0, dz_gtg: 0, dz_open: 0, split: 0 }; return [f.dz_rz, f.dz_gtg, f.dz_open, f.split * (-(spread || 0) / 7)]; };
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']); const before = (s, w) => r => r.season < s || (r.season === s && r.week < w);
const fits = new Map();
function fitDrive(s, w) {
  const k = `${s}|${w}`; if (fits.has(k)) return fits.get(k);
  const Pr = priors(C, s, w), cache = { t: new Map(), d: new Map() }; const X = [], y = [];
  for (const r of C.pg) { if (!before(s, w)(r) || !SKILL.has(r.pos)) continue; const ln = linesFor(C, r.season, r.week, r.team); if (!ln) continue;
    const f = featureRow(C, Pr, cache, { pid: r.pid, pos: r.pos, s: r.season, w: r.week, team: r.team, opp: r.opp, home: ln.home, implied: ln.implied, spread: ln.spread });
    X.push([...USAGE_FEATURES.map(c => f[c]), ...dfRow(r.pid, r.season, r.week, ln.spread)]); y.push(r.tds > 0 ? 1 : 0); }
  const fit = fitCloglog(X, y, { ridge: 2 }); const o = { fit, Pr, cache }; fits.set(k, o); console.error(`fit ${k} rows ${X.length} drive coefs ${fit.b.slice(-4).map(v => v.toFixed(3)).join(',')}`); return o;
}
const bySl = new Map(); for (const r of C.rw) if (r.sleeper && r.gsis) bySl.set(r.sleeper, r.gsis);
function predictDrive(r) {
  const gsis = r.gsis || bySl.get(r.id); if (!gsis) return null; const pos = C.pos.get(gsis); if (!pos) return null;
  const { fit, Pr, cache } = fitDrive(r.season, r.week); const team = r.gameId.split('_')[r.side === 'home' ? 3 : 2]; const ln = linesFor(C, r.season, r.week, team); if (!ln) return null;
  const f = featureRow(C, Pr, cache, { pid: gsis, pos, s: r.season, w: r.week, team, opp: ln.opp, home: r.side === 'home', implied: Number.isFinite(r.implied) ? r.implied : ln.implied, spread: Number.isFinite(r.spread) ? r.spread : ln.spread });
  const x = [...USAGE_FEATURES.map(c => f[c]), ...dfRow(gsis, r.season, r.week, Number.isFinite(r.spread) ? r.spread : ln.spread)];
  let e = fit.b[0]; x.forEach((v, j) => { e += fit.b[j + 1] * (v - fit.mu[j]) / fit.sd[j]; }); return cll(e);
}
// ---- rows (identical selection to scripts/usage/verify.mjs)
const read = (t, s) => { try { return JSON.parse(fs.readFileSync(`data/hist/x-${t}-${s}.json`)); } catch { return []; } };
const rows = [];
for (const s of [2025, 2026]) for (const r of read('chk2', s)) if (r.published > 0 && r.chance > 0) rows.push({ src: 'hist', season: s, week: r.week, gameId: r.gameId, id: String(r.id), pos: r.pos, side: r.side, spread: r.spread, implied: r.implied, chance: r.chance, published: r.published, y: r.y });
for (const w of [6, 7]) { const of = `archive/2026/outcomes-w${w}.json`; if (!fs.existsSync(of)) continue; const oc = JSON.parse(fs.readFileSync(of));
  for (const f of fs.readdirSync(`archive/2026/w${w}`)) { const a = JSON.parse(fs.readFileSync(`archive/2026/w${w}/${f}`)); const p = a.latest?.payload || a.first.payload; const L = p.lines || {};
    for (const pl of p.players) { const o = oc[`${p.gameId}|${pl.id}`]; const pub = pl.published?.probability ?? (typeof pl.published === 'number' ? pl.published : null);
      if (!o?.payload || o.payload.status === 'missing' || !(pub > 0) || !(pl.chance > 0)) continue; const home = p.gameId.split('_')[3] === pl.team;
      rows.push({ src: 'prosp', season: 2026, week: w, gameId: p.gameId, id: String(pl.id), gsis: pl.gsis || null, pos: pl.pos, side: home ? 'home' : 'away', spread: home ? L.homeSpread : L.awaySpread, implied: home ? L.homeImplied : L.awayImplied, chance: pl.chance, published: pub, y: o.payload.td > 0 ? 1 : 0 }); } } }
const tablesU = new Map(); const look = (s, w) => { const k = `${s}|${w}`; if (!tablesU.has(k)) tablesU.set(k, usageLookup(buildWeek(C, s, w))); return tablesU.get(k); };
let miss = 0;
for (const r of rows) {
  const u = look(r.season, r.week)(r, { implied: r.implied, spread: r.spread, home: r.side === 'home' }); const ud = u == null ? null : predictDrive(r); if (u == null || ud == null) miss++;
  r.usage = u ?? r.published; r.usageD = u == null ? r.usage : (ud ?? u);
  r.blend3 = blendProbability({ chance: r.chance, published: r.published, usage: u }).p;
  r.blend3D = blendProbability({ chance: r.chance, published: r.published, usage: u == null ? null : (ud ?? u) }).p;
}
const k1000 = x => r4(x * 1000);
const cmp = (R, a, b) => { const q = pairedBoot(R, a, b); return { n: q.n, games: q.games, dB: k1000(q.dBrier), dBci: q.dBrierCI.map(k1000), dLL: k1000(q.dLogLoss), dLLci: q.dLogLossCI.map(k1000) }; };
const sets = { research: rows.filter(r => r.season === 2025 || (r.src === 'hist' && r.week <= 5) || (r.src === 'prosp' && r.week === 6)), hist2025: rows.filter(r => r.src === 'hist' && r.season === 2025), hist2026: rows.filter(r => r.src === 'hist' && r.season === 2026), prosp: rows.filter(r => r.src === 'prosp') };
const out = { builtAt: new Date().toISOString(), features: DRIVE_FEATURES, lineFeatures: LINE_FEATURES, missing: miss, rows: rows.length, sets: {} };
for (const [n, R] of Object.entries(sets)) out.sets[n] = { n: R.length, model: summary(R, 'chance'), blend3: summary(R, 'blend3'), blend3D: summary(R, 'blend3D'),
  usageD_vs_usage: cmp(R, 'usageD', 'usage'), blend3D_vs_blend3: cmp(R, 'blend3D', 'blend3'), blend3D_vs_model: cmp(R, 'blend3D', 'chance'), usageD_vs_model: cmp(R, 'usageD', 'chance') };
const last = [...fits.values()].at(-1)?.fit; if (last) out.lastFitDriveCoef = Object.fromEntries(DRIVE_FEATURES.map((k, i) => [k, r4(last.b[last.b.length - 4 + i])]));
fs.writeFileSync(arg('out', 'data/hist/drive-verify.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
