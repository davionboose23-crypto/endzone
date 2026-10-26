// Weekly drive-trends build (GitHub Actions + local): nflverse pbp -> drive table (archive/drives/<season>/table.json,
// seasons S-1 and S) -> walk-forward pattern detection -> archive/drives/<season>/w<week>.json (per-player drive usage
// for the last games, phase summary, and the patterns that survive FDR + shrinkage + out-of-sample persistence).
// Usage: node scripts/drives/build.mjs [--season 2026 --weeks 7,8] [--tables /tmp/ez] [--if-missing]
// Pre-game only: the week-w file reads drives from games before week w; persistence is scored on weeks before w.
import fs from 'node:fs'; import path from 'node:path';
import { loadDriveSeason } from './lib.mjs';
import { walkForward } from './research.mjs';
import { detect, playerDrives, phaseSummary, reliability, describe, SUBSETS } from '../../src/drive-patterns.js';
import { getState } from '../../server/prepare.js';
import { stable } from '../../server/file-archive.js';
const PKG = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const BASE = JSON.parse(fs.readFileSync(new URL('../../src/drive-baseline.json', import.meta.url), 'utf8'));
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = process.env.ENDZONE_ARCHIVE || 'archive';
const LAST_GAMES = 6, PER_PLAYER = 4, TOP = 30;
const writeIfChanged = (f, obj, ignore = ['builtAt']) => {
  const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null; const strip = o => { const c = { ...o }; for (const k of ignore) delete c[k]; return stable(c); };
  if (prev && JSON.stringify(strip(prev)) === JSON.stringify(strip(obj))) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); return true;
};
export async function loadDriveTables(season, { tables = null, log = console.log } = {}) {
  const out = [];
  for (const s of [season - 2, season - 1, season]) {
    const f = tables && path.join(tables, `drives-${s}.json`);
    if (f && fs.existsSync(f)) out.push(JSON.parse(fs.readFileSync(f))); else { const T = await loadDriveSeason(s, log); out.push(T); if (tables) fs.writeFileSync(f, JSON.stringify(T)); }
  }
  return out;
}
const ownRecord = (inst, t) => { const L = inst.filter(x => x.pid === t.pid && x.sub === t.sub && x.metric === t.metric); if (!L.length) return null;
  let num = 0, den = 0; for (const x of L) { const sg = x.E1 >= x.E0 ? 1 : -1; num += sg * (x.O - x.E0); den += sg * (x.E1 - x.E0); }
  return { weeks: L.length, retention: den > 1e-9 ? +(num / den).toFixed(2) : null }; };
export function buildPatterns(tables, season, week, { log = () => {} } = {}) {
  const targets = [...Array.from({ length: 14 }, (_, i) => [season - 1, i + 5]), ...Array.from({ length: Math.max(0, week - 2) }, (_, i) => [season, i + 2])];
  const WF = walkForward(tables, targets, { log });
  const fam = { drive: WF.fam.drive.fdr, phase: WF.fam.phase.fdr };
  const { I, tests } = detect(tables, season, week);
  const raw05 = f => tests.filter(t => t.fam === f && t.p < 0.05).length, nT = f => tests.filter(t => t.fam === f).length, fdr = f => tests.filter(t => t.fam === f && t.q <= 0.10).length;
  for (const t of tests) if (t.q <= 0.10) { t.own = ownRecord(WF.inst, t); t.rel = reliability(t, fam[t.fam]); }
  const kept = tests.filter(t => t.rel).sort((a, b) => (a.rel === 'strong' ? 0 : 1) - (b.rel === 'strong' ? 0 : 1) || a.q - b.q);
  const r3 = x => Math.round(x * 1000) / 1000;
  const pat = t => ({ fam: t.fam, sub: t.sub, metric: t.metric, rel: t.rel, q: +t.q.toPrecision(2), n: t.nS, opp: t.oS, shr: r3(t.shr), rest: r3(t.rest), base: r3(t.base), own: t.own || null, text: describe(t) });
  const byP = new Map(); for (const t of kept) { if (!byP.has(t.pid)) byP.set(t.pid, []); const L = byP.get(t.pid); if (L.length < PER_PLAYER && !L.some(x => x.sub === t.sub)) L.push(t); }
  const players = {}, bySleeper = {};
  for (const pid of I.byP.keys()) {
    const P = playerDrives(I, pid); const cur = P.filter(x => x.g.season === season); if (cur.length < 2) continue;
    const touches = cur.reduce((a, x) => a + x.rows.reduce((b, { r }) => b + r.tgt + r.car, 0), 0); if (touches < 8) continue;
    const pe = I.people[pid] || {}; const last = P.slice(-LAST_GAMES);
    players[pid] = { name: pe.name || pid, pos: pe.pos || null, team: cur.at(-1).g.team, summary: phaseSummary(P), curSummary: phaseSummary(cur),
      games: last.map(x => ({ s: x.g.season, w: x.g.week, opp: x.g.opp, d: x.rows.map(({ r }) => [r.tgt, r.rec, r.car, r.recYd + r.rushYd, r.rz]) })),
      patterns: (byP.get(pid) || []).map(pat) };
    if (pe.sleeper) bySleeper[pe.sleeper] = pid;
  }
  const top = kept.filter(t => players[t.pid]).slice(0, TOP).map(t => ({ pid: t.pid, name: players[t.pid].name, team: players[t.pid].team, pos: players[t.pid].pos, ...pat(t) }));
  const shipped = f => ({ strong: kept.filter(t => t.fam === f && t.rel === 'strong').length, moderate: kept.filter(t => t.fam === f && t.rel === 'moderate').length });
  return { kind: 'drive-patterns', version: 1, season, week, builtAt: new Date().toISOString(),
    source: `nflverse pbp drives, ${season - 1} + ${season} weeks before ${week} (pre-game only)`,
    method: 'Share of the team\'s touches / targets / carries on a subset of drives vs the player\'s share on his team\'s other drives in the same games (exact binomial), Benjamini-Hochberg q <= 0.10 across all tests, displayed rates shrunk toward his overall share (10 pseudo-opportunities), reliability from walk-forward out-of-sample persistence (found through week N, scored on week N+1).',
    counts: { drive: { tests: nT('drive'), raw05: raw05('drive'), expectedByChance: Math.round(nT('drive') * 0.05), fdr: fdr('drive'), ...shipped('drive') }, phase: { tests: nT('phase'), raw05: raw05('phase'), expectedByChance: Math.round(nT('phase') * 0.05), fdr: fdr('phase'), ...shipped('phase') } },
    appVersion: PKG.version, modelVersion: BASE.modelVersion,
    prediction: { adopted: BASE.adopted, note: BASE.note, decidedAt: BASE.decidedAt, hist2026: BASE.results.hist2026?.usageD_vs_usage || null },
    persistence: { targets: targets.length, drive: WF.fam.drive, phase: WF.fam.phase }, subsets: Object.fromEntries(SUBSETS.map(S => [S.key, S.label])),
    top, players, bySleeper };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const st = await getState(); const season = Number(arg('season') || st.season); const cur = Number(st.display_week || st.week);
  const weeks = arg('weeks') ? arg('weeks').split(',').map(Number) : [cur, cur + 1].filter(w => w >= 1 && w <= 18);
  const missing = weeks.filter(w => !fs.existsSync(path.join(dir, 'drives', String(season), `w${w}.json`)));
  if (process.argv.includes('--if-missing') && !missing.length) { console.log(`drive patterns present for ${season} w${weeks.join(',')}; skipping`); process.exit(0); }
  const tables = await loadDriveTables(season, { tables: arg('tables') });
  for (const T of tables.slice(1)) console.log(JSON.stringify({ table: T.season, drives: T.drives.length, written: writeIfChanged(path.join(dir, 'drives', String(T.season), 'table.json'), T, []) }));
  for (const w of weeks) {
    const P = buildPatterns(tables, season, w); const f = path.join(dir, 'drives', String(season), `w${w}.json`);
    console.log(JSON.stringify({ season, week: w, players: Object.keys(P.players).length, counts: P.counts, persistence: { drive: P.persistence.drive, phase: P.persistence.phase }, written: writeIfChanged(f, P) }));
  }
}
