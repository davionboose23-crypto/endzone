// Walk-forward fit + test of the drive-pattern adjustment (src/drive-adjust.js). Pre-game only:
//  * one pass over target weeks in time order; at week w the patterns, reliability labels (family + own out-of-sample
//    persistence scored only on weeks before w), the league / defense profiles and the context all use drives before w;
//  * the weight for week w is the grid value that minimises log loss on all EARLIER evaluation weeks (0 until 3 weeks);
//  * evaluation rows: frozen replayed endzone-4.6.0 history (archive/drives/eval-rows.json) + prospective archive
//    snapshots with confirmed outcomes; "blend" = the 3-way blend challenger, "model" = the active model chance;
//  * game-bootstrap paired CIs (x1000, negative = better) for blend+drives vs blend and model+drives vs model.
// Output: archive/drives/fit.json (weight for the next week + scoreboard). Run on Tuesdays by auto.yml (build --fit).
import fs from 'node:fs'; import path from 'node:path';
import { detect, reliability, scoreRows, weekRows } from '../../src/drive-patterns.js';
import { retention } from './research.mjs';
import { profiles } from './profile.mjs';
import { driveTerms, applyToChance, DRIVE_CAP, REL_WEIGHT } from '../../src/drive-adjust.js';
import { usageLookup, blendProbability } from '../../src/usage-model.js';
import { pairedBoot, summary, r4 } from '../hist/metrics.mjs';
export const GRID = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];
const PER_PLAYER = 4;
const cl = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
const ll = (R, k) => -R.reduce((s, r) => s + (r.y ? Math.log(cl(r[k])) : Math.log(1 - cl(r[k]))), 0) / R.length;
// patterns + profiles for (s, w), with persistence from inst (scored weeks strictly before w)
export function weekState(tables, s, w, inst, { q = 0.10 } = {}) {
  const { I, tests } = detect(tables, s, w);
  const prior = inst.filter(x => (x.s === s && x.w < w) || (x.s === s - 1 && x.w >= 5));
  const fam = {}; for (const f of ['drive', 'phase']) fam[f] = retention(prior.filter(x => x.fam === f && x.q <= q), 300);
  const byKey = new Map(); for (const x of prior) { const k = `${x.pid}|${x.sub}|${x.metric}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(x); }
  const own = t => { const L = byKey.get(`${t.pid}|${t.sub}|${t.metric}`); if (!L) return null; let num = 0, den = 0; for (const x of L) { const sg = x.E1 >= x.E0 ? 1 : -1; num += sg * (x.O - x.E0); den += sg * (x.E1 - x.E0); } return { weeks: L.length, retention: den > 1e-9 ? num / den : null }; };
  for (const t of tests) if (t.q <= q) { t.own = own(t); t.rel = reliability(t, fam[t.fam]); }
  const kept = tests.filter(t => t.rel).sort((a, b) => (a.rel === 'strong' ? 0 : 1) - (b.rel === 'strong' ? 0 : 1) || a.q - b.q);
  const players = {}; for (const t of kept) { const P = players[t.pid] || (players[t.pid] = { pos: I.people[t.pid]?.pos || null, patterns: [] }); if (P.patterns.length < PER_PLAYER && !P.patterns.some(x => x.sub === t.sub)) P.patterns.push({ sub: t.sub, metric: t.metric, rel: t.rel, shr: t.shr, base: t.base, q: t.q, n: t.nS }); }
  const bySleeper = {}; for (const [pid, pe] of Object.entries(I.people)) if (pe.sleeper) bySleeper[pe.sleeper] = pid;
  const pr = profiles(I, s, w);
  return { tests, players, bySleeper, league: pr.league, defense: pr.defense, offense: pr.offense, fam };
}
export function loadEvalRows({ dir = 'archive', season = 2026 } = {}) {
  const rows = []; const f = path.join(dir, 'drives', 'eval-rows.json');
  if (fs.existsSync(f)) { const J = JSON.parse(fs.readFileSync(f)); for (const a of J.rows) { const r = Object.fromEntries(J.cols.map((c, i) => [c, a[i]])); r.src = 'hist'; r.blend = r.blend3; delete r.blend3; rows.push(r); } }
  for (const s of [season]) { const sd = path.join(dir, String(s)); if (!fs.existsSync(sd)) continue;
    for (const wd of fs.readdirSync(sd).filter(x => /^w\d+$/.test(x))) { const w = +wd.slice(1); const of = path.join(sd, `outcomes-w${w}.json`); if (!fs.existsSync(of)) continue; const oc = JSON.parse(fs.readFileSync(of));
      const uf = path.join(dir, 'usage', String(s), `w${w}.json`); const look = usageLookup(fs.existsSync(uf) ? JSON.parse(fs.readFileSync(uf)) : null);
      for (const g of fs.readdirSync(path.join(sd, wd))) { const a = JSON.parse(fs.readFileSync(path.join(sd, wd, g))); const p = a.first?.payload || a.latest?.payload; if (!p) continue; const L = p.lines || {};
        for (const pl of p.players) { const o = oc[`${p.gameId}|${pl.id}`]; const pub = pl.published?.probability ?? (typeof pl.published === 'number' ? pl.published : null);
          if (!o?.payload || o.payload.status === 'missing' || o.payload.status === 'pending' || !(pub > 0) || !(pl.chance > 0)) continue; const home = p.gameId.split('_')[3] === pl.team;
          const spread = home ? L.homeSpread : L.awaySpread, implied = home ? L.homeImplied : L.awayImplied;
          const live = p.challenger?.status === 'blend3' || p.challenger?.kind === 'blend3' ? pl.challenger : null;
          const u = look ? look({ ...pl, published: pub }, { implied, spread, home }) : null;
          const blend = live ?? blendProbability({ chance: pl.chance, published: pub, usage: u })?.p;
          rows.push({ src: 'prosp', season: s, week: w, gameId: p.gameId, id: String(pl.id), gsis: pl.gsis || null, pos: pl.pos, side: home ? 'home' : 'away', spread, chance: pl.chance, published: pub, blend, blendDrivesLive: pl.blendDrives ?? null, y: o.payload.td > 0 ? 1 : 0 }); } } } }
  // prospective snapshots supersede the replayed rows for the same week (no double counting)
  const pw = new Set(rows.filter(r => r.src === 'prosp').map(r => `${r.season}|${r.week}`));
  return rows.filter(r => r.src === 'prosp' || !pw.has(`${r.season}|${r.week}`));
}
export function fitAdjust(tables, rows, { log = () => {} } = {}) {
  const wk = [...new Set(rows.map(r => `${r.season}|${r.week}`))].map(k => k.split('|').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const first = wk[0]; const targets = [];
  for (let s = first[0] - 1; s <= wk.at(-1)[0]; s++) for (let w = 2; w <= 18; w++) { if (s === first[0] - 1 && w < 5) continue; if (s === wk.at(-1)[0] && w > wk.at(-1)[1]) break; targets.push([s, w]); }
  const inst = []; const byWeek = new Map(rows.map(r => [`${r.season}|${r.week}`, []])); for (const r of rows) byWeek.get(`${r.season}|${r.week}`).push(r);
  const tablesHave = new Set(tables.map(T => T.season)); let withPat = 0;
  for (const [s, w] of targets) {
    if (!tablesHave.has(s)) continue; const t0 = Date.now(); const W = weekState(tables, s, w, inst); const R = byWeek.get(`${s}|${w}`) || [];
    for (const r of R) { const team = r.gameId.split('_')[r.side === 'home' ? 3 : 2], opp = r.gameId.split('_')[r.side === 'home' ? 2 : 3];
      const pid = r.gsis || W.bySleeper[r.id]; const T = driveTerms(pid ? W.players[pid] : null, { D: W, opp, team, pos: r.pos, spread: r.spread }); r.draw = T.raw; if (T.items.length) withPat++; }
    const WR = weekRows(tables, s, w); for (const t of W.tests) if (t.p < 0.05) { const sc = scoreRows(WR.get(t.pid), t); if (sc) inst.push({ s, w, pid: t.pid, fam: t.fam, sub: t.sub, metric: t.metric, q: t.q, p: t.p, ...sc }); }
    log(`${s} w${w}: ${Object.keys(W.players).length} players with patterns, ${R.length} eval rows, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const ev = rows.filter(r => r.draw != null && r.blend > 0 && r.chance > 0);
  const apply = (r, k, w) => applyToChance(r[k], Math.max(-DRIVE_CAP, Math.min(DRIVE_CAP, w * r.draw)));
  const best = (R, k) => { if (!R.length) return 0; let bw = 0, bl = Infinity; for (const w of GRID) { const l = ll(R.map(r => ({ y: r.y, p: apply(r, k, w) })), 'p'); if (l < bl - 1e-12) { bl = l; bw = w; } } return bw; };
  const weeks = [...new Set(ev.map(r => `${r.season}|${r.week}`))]; const path_ = [];
  for (let i = 0; i < weeks.length; i++) { const prior = ev.filter(r => weeks.indexOf(`${r.season}|${r.week}`) < i); const enough = i >= 3;
    const wb = enough ? best(prior, 'blend') : 0, wm = enough ? best(prior, 'chance') : 0; path_.push({ week: weeks[i], blend: wb, model: wm });
    for (const r of ev.filter(r => `${r.season}|${r.week}` === weeks[i])) { r.wB = wb; r.wM = wm; r.blendD = apply(r, 'blend', wb); r.modelD = apply(r, 'chance', wm); } }
  const k1000 = x => r4(x * 1000);
  const cmp = (R, a, b) => { if (!R.length) return null; const q = pairedBoot(R, a, b); return { n: q.n, games: q.games, dBrier: k1000(q.dBrier), dBrierCI: q.dBrierCI.map(k1000), dLogLoss: k1000(q.dLogLoss), dLogLossCI: q.dLogLossCI.map(k1000) }; };
  const sets = { all: ev, hist2025: ev.filter(r => r.src === 'hist' && r.season === 2025), hist2026: ev.filter(r => r.src === 'hist' && r.season === 2026), prosp: ev.filter(r => r.src === 'prosp') };
  const results = {}; for (const [k, R] of Object.entries(sets)) results[k] = { n: R.length, touched: R.filter(r => r.draw).length, blend: summary(R, 'blend'), blendDrives: summary(R, 'blendD'), model: summary(R, 'chance'), modelDrives: summary(R, 'modelD'), blendDrives_vs_blend: cmp(R, 'blendD', 'blend'), modelDrives_vs_model: cmp(R, 'modelD', 'chance') };
  const wNext = { blend: best(ev, 'blend'), model: best(ev, 'chance') };
  const moved = ev.filter(r => Math.abs(r.blendD - r.blend) > 1e-9).map(r => Math.abs(r.blendD - r.blend)); moved.sort((a, b) => a - b);
  return { kind: 'drive-adjust-fit', version: 1, builtAt: new Date().toISOString(), grid: GRID, cap: '+-10% of lambda', relWeight: REL_WEIGHT,
    rows: ev.length, rowsWithPatterns: withPat, weightPath: path_, weight: wNext, results,
    movedPP: moved.length ? { n: moved.length, median: r4(moved[moved.length >> 1] * 100), p90: r4(moved[Math.floor(moved.length * 0.9)] * 100), max: r4(moved.at(-1) * 100) } : null };
}
