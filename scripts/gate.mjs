// Weekly auto-calibration gate (run by the scheduled workflow, Tuesdays or on demand).
// 1) Walk-forward re-evaluation of data-fit safety caps on the current season: for each finished week w the caps are
//    fit only on earlier seasons + weeks < w, then the full engine is re-run with and without them. Enabled only if
//    held-out Brier AND log loss improve with game-bootstrap 95% intervals below zero and team calls / contributors
//    do not regress (point estimate). 2) Challenger: enabled only if promotionDecision (prospective pairs) passes.
// 3) Refresh the team-budget and volume-band fits for the next week. Decisions are logged to archive/state.json
//    and src/calibration-fits.json (components), which the engine and the Pages build read.
import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path';
import { loadSeason, gradeWeek } from './hist/build.mjs';
import { pairedBoot, r4 } from './hist/metrics.mjs';
import { fitBudget, fitVolCal, fitCaps } from '../src/calibration.js';
import { FileArchive, writeJson, readJson } from '../server/file-archive.js';
import { MODEL_VERSION } from '../src/model.js';
import { trendGate } from './trend-gate.mjs';
import TW from '../src/trend-weights.json' with { type: 'json' };
const ARCH = process.env.ENDZONE_ARCHIVE || 'archive'; const FITS_FILE = 'src/calibration-fits.json';
const season = Number(process.argv[2]) || null;
const prior = [2024, 2025].flatMap(s => { const f = `${ARCH}/hist/rows-${s}.json.gz`; return fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f))) : []; });
const S = await loadSeason(season || new Date().getUTCFullYear());
const yr = S.prep.season; const last = Math.max(0, ...S.prep.games.filter(g => g.season === yr && g.finished).map(g => g.week));
// only weeks whose games are all final
let full = 0; for (let w = 1; w <= last; w++) { const gs = S.prep.games.filter(g => g.season === yr && g.week === w); if (gs.length && gs.every(g => g.finished)) full = w; else break; }
const fixedRows = [], capRows = [];
for (let w = 1; w <= full; w++) {
  const before = [...prior, ...fixedRows]; const caps = fitCaps(before, { K: 100 });
  const fr = gradeWeek(S, w, { volCal: false, caps: null }); fixedRows.push(...fr);
  const cr = caps ? gradeWeek(S, w, { volCal: false, caps }) : fr; capRows.push(...cr);
}
const m = new Map(capRows.map(r => [`${r.gameId}|${r.id}`, r.chance]));
const rows = fixedRows.filter(r => r.published != null).map(r => ({ ...r, cand: m.get(`${r.gameId}|${r.id}`) ?? r.chance }));
const bt = rs => { if (!rs.length) return null; const b = pairedBoot(rs, 'cand', 'chance'); return { n: b.n, games: b.games, dBrier: r4(b.dBrier), dBrierCI: b.dBrierCI.map(r4), dLogLoss: r4(b.dLogLoss), dLogLossCI: b.dLogLossCI.map(r4) }; };
const ev = { all: bt(rows), teamCalls: bt(rows.filter(r => r.teamCall)), contributors: bt(rows.filter(r => r.contributor)), weeks: full };
const reasons = [];
if (!ev.all || ev.all.games < 40) reasons.push(`needs ≥40 finished games walk-forward (have ${ev.all?.games ?? 0})`);
else {
  if (!(ev.all.dBrierCI[1] < 0)) reasons.push(`Brier change ${ev.all.dBrier} [${ev.all.dBrierCI}] not below zero`);
  if (!(ev.all.dLogLossCI[1] < 0)) reasons.push(`log-loss change ${ev.all.dLogLoss} [${ev.all.dLogLossCI}] not below zero`);
  if (ev.teamCalls && ev.teamCalls.dBrier > 0) reasons.push(`team calls regress (${ev.teamCalls.dBrier})`);
  if (ev.contributors && ev.contributors.dBrier > 0) reasons.push(`contributors regress (${ev.contributors.dBrier})`);
}
const now = new Date().toISOString(); const nextWeek = full + 1;
const allFit = fitCaps([...prior, ...fixedRows], { K: 100 }); const capsOn = reasons.length === 0 && !!allFit;
const capsDecision = { enabled: capsOn, decidedAt: now, throughWeek: full, reason: capsOn ? `passed: Brier ${ev.all.dBrier} [${ev.all.dBrierCI}], log loss ${ev.all.dLogLoss} [${ev.all.dLogLossCI}] over ${ev.all.games} games` : `withheld: ${reasons.join('; ')}`, evaluation: ev, fit: allFit ? { pullT: allFit.pullT, pullS: allFit.pullS, ceil: allFit.ceil, cold: allFit.cold, fin: allFit.fin, floor: allFit.floor } : null };
const A = await FileArchive.open(ARCH); const st = A.state(); const promo = st.promotion;
const chDecision = { enabled: !!promo?.promote, decidedAt: now, reason: promo ? (promo.promote ? 'passed the prospective promotion rule' : `withheld: ${promo.reasons.join(' ')}`) : 'no prospective validation yet' };
// 3b) drive patterns (app 4.8): the "blend + drives" challenger must pass the same prospective promotion rule AND the
//     walk-forward fit (archive/drives/fit.json, refit every Tuesday) must give the model a positive weight. Only then does
//     the active model apply the drive adjustment (before the safety caps); otherwise weight 0.
const dPromo = st.drivesPromotion; let dFit = null; try { dFit = JSON.parse(fs.readFileSync(path.join(ARCH, 'drives', 'fit.json'), 'utf8')); } catch {}
const dW = dFit?.weight?.model || 0; const dOn = !!dPromo?.promote && dW > 0;
const drDecision = { enabled: dOn, decidedAt: now, weight: dOn ? dW : 0, fitWeight: dFit?.weight || null,
  reason: dOn ? `enabled: passed the prospective promotion rule; walk-forward model weight ${dW}` : `withheld: ${[!dPromo ? 'no prospective blend + drives snapshots graded yet' : (dPromo.promote ? null : `prospective rule: ${(dPromo.reasons || []).join(' ')}`), dW > 0 ? null : 'walk-forward weight is 0 (drive patterns did not lower log loss on earlier weeks)'].filter(Boolean).join('; ')}` };
// 4) trends agent: re-evaluate every family walk-forward (see scripts/trend-gate.mjs)
const TG = process.env.ENDZONE_SKIP_TRENDS ? null : trendGate(S, full, gradeWeek, TW, { log: (...a) => console.log('trends', ...a) });
const anyTrend = TG && Object.values(TG.weights).some(w => w > 0);
const trDecision = TG ? { enabled: anyTrend, decidedAt: now, throughWeek: full, weights: TG.weights, reason: anyTrend ? `enabled: ${Object.entries(TG.weights).filter(([, w]) => w).map(([f, w]) => `${f} ${w}`).join(', ')}` : `all families off: ${Object.entries(TG.families).map(([f, x]) => `${f} (${x.reason.replace(/^off: /, '')})`).join('; ')}`, families: Object.fromEntries(Object.entries(TG.families).map(([f, x]) => [f, { enabled: x.enabled, weight: x.weight, reason: x.reason, all: x.evaluation.all }])) } : null;
// fits file: refresh budget/volume fits for the next week; caps only when enabled
const FITS = readJson(FITS_FILE, { fits: [] });
const train = [...prior, ...fixedRows];
const entry = { season: yr, week: nextWeek, budget: fitBudget(train), volcal: fitVolCal(train), ...(capsOn ? { caps: capsDecision.fit } : {}), ...(anyTrend ? { trendWeights: TG.weights } : {}) };
FITS.fits = FITS.fits.filter(f => !(f.season === yr && f.week === nextWeek)).concat(entry).sort((a, b) => a.season - b.season || a.week - b.week);
FITS.components = { caps: { ...capsDecision, evaluation: undefined }, challenger: chDecision, drives: drDecision, ...(trDecision ? { trends: trDecision } : (FITS.components?.trends ? { trends: FITS.components.trends } : {})), modelVersion: MODEL_VERSION };
writeJson(FITS_FILE, FITS);
st.decisions = [{ at: now, season: yr, throughWeek: full, caps: { enabled: capsOn, reason: capsDecision.reason, evaluation: ev }, challenger: chDecision, trends: trDecision }, ...(st.decisions || [])].slice(0, 30);
st.components = FITS.components; A.saveState(st);
console.log(JSON.stringify({ throughWeek: full, caps: capsDecision.reason, challenger: chDecision.reason, trends: trDecision?.reason, nextWeekFit: { week: nextWeek, budget: entry.budget } }, null, 1));
