// POST /api/jobs/refresh: refresh data, save unplayed pregame frames, reconcile
// results, revise lessons, update validation, log the run. Idempotent and
// concurrency-safe (one in-flight run is shared by concurrent callers).
import { prepareData } from './prepare.js';
import { runEngine } from '../src/engine.js';
import { buildIndex } from '../src/stats-index.js';
import { gradeGame, snapshotFromGame } from '../src/grading.js';
import { weeklyLesson, activeLessons, withInWeekNudge, describeLessons } from '../src/research.js';
import { componentState } from '../src/calibration.js';
import { DRIVES_KIND } from '../src/drive-adjust.js';
import { pairedBoot as pairedBootLite } from '../src/drive-score.js';
import { volumeErrorModel, promotionDecision } from '../src/validation.js';
import { tdReport, volumeReport } from '../src/evaluation.js';
import { MODEL_VERSION, DEFAULT_WEIGHTS } from '../src/model.js';
import { blendStatus, blendChallenger, usageLookup, blendProbability, monitorReport, sideLines, BLEND_KIND } from '../src/usage-model.js';

let inflight = null;
export function refresh(archive, opts = {}) {
  if (inflight) return inflight.then(r => ({ ...r, shared: true }));
  inflight = runRefresh(archive, opts).finally(() => { inflight = null; });
  return inflight;
}

const withLines = (r, lines, isHome) => ({ ...(r.implied != null ? r : { ...r, ...sideLines(lines, isHome) }), isHome });
// Retro (walk-forward backfill) blend for prospective rows frozen before the blend existed: usage table of that
// week (fit strictly before it) + the frozen final chance + Sleeper as published. Shown in monitoring, never counted by the gate.
export function withBlend(archive, rows, season) {
  const looks = new Map(); const look = w => { if (!looks.has(w)) looks.set(w, usageLookup(archive.usage?.(season, w) || null)); return looks.get(w); };
  return rows.map(r => {
    if (r.challengerKind === BLEND_KIND && r.challenger != null) return { ...r, blend: r.challenger, blendSource: 'live' };
    if (!(r.chance > 0)) return r;
    const L = r.season === season ? look(r.week) : null; const u = L ? L(r, { implied: r.implied, spread: r.spread, home: r.isHome ?? r.side === 'home' }) : null;
    const b = blendProbability({ chance: r.chance, published: r.published, usage: u }); return b ? { ...r, blend: b.p, blendLegs: b.legs, blendSource: 'retro' } : r;
  });
}
export function monitorState(archive, graded, season) {
  const P = withBlend(archive, graded.filter(r => r.prospective), season);
  const live = P.filter(r => r.blendSource === 'live' && r.modelVersion === MODEL_VERSION).map(r => ({ ...r, challenger: r.blend }));
  const all = P.filter(r => r.blend != null).map(r => ({ ...r, challenger: r.blend }));
  return { live: monitorReport(live, { label: `prospective ${MODEL_VERSION} snapshots (counts toward the gate)` }), withBackfill: monitorReport(all, { label: 'all frozen snapshots; weeks before 4.6.0 scored with a walk-forward backfilled blend' }), retroWeeks: [...new Set(P.filter(r => r.blendSource === 'retro').map(r => r.week))].sort((a, b) => a - b) };
}
// Live scoreboard: prospective rows that recorded the "blend + drives" challenger (app 4.8+), vs the blend and the model.
export function drivesMonitor(graded) {
  const R = graded.filter(r => r.prospective && r.blendDrives != null && r.challenger != null && r.chance > 0);
  return { n: R.length, games: new Set(R.map(r => r.gameId)).size, withDrives_vs_blend: pairedBootLite(R, 'blendDrives', 'challenger'), withDrives_vs_model: pairedBootLite(R, 'blendDrives', 'chance'), moved: R.filter(r => Math.abs(r.blendDrives - r.challenger) > 1e-6).length };
}
// Graded rows for earlier weeks: frozen snapshots preferred, otherwise reconstructed (labeled).
export function gradedHistory(archive, prep, ix, season, uptoWeek, { lessonFree = true } = {}) {
  const rows = []; const perWeek = {};
  for (let w = 1; w <= uptoWeek; w++) {
    const games = prep.games.filter(g => g.season === season && g.week === w && g.finished);
    if (!games.length) continue;
    const snaps = new Map(archive.snapshots(season, w).map(s => [s.gameId, s]));
    let recon = null;
    const wk = [];
    for (const g of games) {
      const s = snaps.get(g.id);
      if (s) { const home = s.teams?.home?.team || g.home; wk.push(...gradeGame(ix, g, s.players, { prospective: true, callIds: s.callIds, source: 'frozen pregame snapshot' }).map(r => ({ ...withLines(r, s.lines, r.team === home), modelVersion: s.modelVersion, challengerKind: s.challenger?.status || null }))); }
      else {
        recon = recon || runEngine(prep, { week: w, ix, lessons: null, now: Date.now() });
        const G = recon.games.find(x => x.gameId === g.id); if (!G) continue;
        wk.push(...gradeGame(ix, g, [...G.sides.away.players, ...G.sides.home.players], { prospective: false, callIds: { away: G.sides.away.call?.id, home: G.sides.home.call?.id }, source: 'reconstructed from earlier weeks' }).map(r => ({ ...r, modelVersion: MODEL_VERSION })));
      }
    }
    perWeek[w] = wk; rows.push(...wk);
  }
  return { rows, perWeek };
}

export function calibrationState(archive, prep, ix, season, week) {
  const hist = gradedHistory(archive, prep, ix, season, week - 1);
  const lessonsByWeek = {};
  for (const [w, rows] of Object.entries(hist.perWeek)) lessonsByWeek[w] = weeklyLesson(rows, { season, week: +w });
  const active = activeLessons(lessonsByWeek, week);
  // in-week: games of this week already completed (before any unplayed game's forecast)
  const cur = gradedHistory(archive, prep, ix, season, week);
  const inWeekRows = (cur.perWeek[week] || []);
  const inWeek = weeklyLesson(inWeekRows, { season, week });
  const graded = hist.rows.map(r => ({ ...r, y: r.actual.td > 0 ? 1 : 0 })).filter(r => r.actual.status === 'confirmed' || r.actual.status === 'confirmed-zero');
  // endzone-4.6 challenger: 3-way blend (model, Sleeper, nflverse usage leg); the old logistic challenger is retired
  const usage = typeof archive.usage === 'function' ? archive.usage(season, week) : null;
  const challenger = { ...blendStatus(usage, { season, week }), trainingCount: graded.length, modelVersion: MODEL_VERSION };
  const drives = typeof archive.drives === 'function' ? archive.drives(season, week) : null;
  const challengerFn = blendChallenger(usage, drives);
  const prosp = graded.filter(r => r.prospective);
  const vem = volumeErrorModel(prosp);
  return { hist, cur, lessonsByWeek, active, inWeek, unplayedLessons: withInWeekNudge(active, inWeek), challenger, challengerFn, usage, drives, errorModel: vem.errorModel, coverage: vem.coverage, graded, trendHistory: graded.map(r => ({ id: r.id, week: r.week, chance: r.chance, y: r.y })) };
}

async function runRefresh(archive, { season, week, now = () => Date.now(), prep: givenPrep = null } = {}) {
  const runId = archive.startRun('refresh');
  const details = { steps: [], partial: [] };
  try {
    const prep = givenPrep || await prepareData({ season, week, force: true });
    details.season = prep.season; details.week = prep.week;
    for (const [k, s] of Object.entries(prep.sources)) if (!s.ok) details.partial.push(`${s.label}: ${s.error}`);
    const ix = buildIndex(prep);
    const cal = calibrationState(archive, prep, ix, prep.season, prep.week);
    for (const [w, L] of Object.entries(cal.lessonsByWeek)) archive.saveLesson(prep.season, +w, L);
    details.steps.push(`lessons for weeks ${Object.keys(cal.lessonsByWeek).join(',') || 'none'}`);
    const cutoffIso = new Date(now()).toISOString();
    const res = runEngine(prep, { ix, week: prep.week, weights: DEFAULT_WEIGHTS, lessons: cal.active, lessonsUnplayed: cal.unplayedLessons, now: now(), errorModel: cal.errorModel, coverage: cal.coverage, challenger: cal.challengerFn, useChallenger: !!componentState().challenger?.enabled, drives: cal.drives, useDrives: !!componentState().drives?.enabled, trendHistory: cal.trendHistory });
    let saved = 0, skipped = 0;
    const meta = { modelVersion: MODEL_VERSION, weights: res.weights, inputTimestamps: Object.fromEntries(Object.entries(prep.sources).map(([k, s]) => [k, s.fetchedAt])), sourceAvailability: Object.fromEntries(Object.entries(prep.sources).map(([k, s]) => [k, s.ok])),
      lessonsLabel: cal.active.label, challenger: { status: cal.challenger.status, reason: cal.challenger.reason, trainingCutoff: cal.challenger.cutoff, trainingCount: cal.challenger.trainingCount, usage: cal.challenger.usage, capturedCutoff: cutoffIso } };
    for (const G of res.games) {
      if (new Date(G.game.kickoff).getTime() > now()) { const r = archive.saveSnapshot(snapshotFromGame(G, meta), { now: new Date(now()) }); if (r.saved) saved++; else skipped++; }
    }
    details.steps.push(`saved ${saved} pregame frames, ${skipped} skipped`);
    // reconcile outcomes for finished games that have frozen snapshots
    const outs = [];
    for (let w = 1; w <= prep.week; w++) for (const s of archive.snapshots(prep.season, w)) {
      const g = prep.games.find(x => x.id === s.gameId); if (!g) continue;
      for (const r of gradeGame(ix, g, s.players, { prospective: true, callIds: s.callIds })) if (r.actual.status !== 'pending') outs.push({ season: g.season, week: g.week, gameId: g.id, playerId: r.id, gsis: r.gsis, payload: r.actual });
    }
    const oc = archive.upsertOutcomes(outs); details.steps.push(`outcomes inserted ${oc.inserted}, revised ${oc.revised}, unchanged ${oc.unchanged}`);
    const report = tdReport(cal.graded); const vol = volumeReport(cal.graded);
    const pairs = cal.graded.filter(r => r.challenger != null).map(r => ({ ...r }));
    const promo = promotionDecision(pairs, { modelVersion: MODEL_VERSION, kind: BLEND_KIND });
    // app 4.8: "blend + drives" second challenger, same prospective rule (its own kind; only snapshots that recorded it)
    const dPairs = cal.graded.filter(r => r.blendDrives != null).map(r => ({ ...r, challenger: r.blendDrives, challengerKind: DRIVES_KIND }));
    const drivesPromo = promotionDecision(dPairs, { modelVersion: MODEL_VERSION, kind: DRIVES_KIND });
    const monitor = monitorState(archive, cal.graded, prep.season);
    archive.saveExperiment({ season: prep.season, week: prep.week, kind: 'validation', modelVersion: MODEL_VERSION, trainingCutoff: JSON.stringify(cal.challenger.cutoff), payload: { summary: summarizeReport(report), volume: vol, promotion: promo, drivesPromotion: drivesPromo, challenger: cal.challenger, monitor, drivesMonitor: drivesMonitor(cal.graded) } });
    details.steps.push('validation updated');
    details.learned = { active: { vol: cal.active.vol, band: cal.active.band, spot: cal.active.spot, basis: cal.active.basis, label: cal.active.label }, describe: describeLessons(cal.active), inWeek: cal.inWeek?.applied ? { confirmed: cal.inWeek.confirmed } : null, promotion: { promote: promo.promote, reasons: promo.reasons }, drivesPromotion: { promote: drivesPromo.promote, reasons: drivesPromo.reasons, metrics: drivesPromo.metrics, monitor: drivesMonitor(cal.graded) } };
    archive.finishRun(runId, details.partial.length ? 'partial' : 'success', details);
    return { ok: true, runId, status: details.partial.length ? 'partial' : 'success', details };
  } catch (e) {
    details.error = String(e.message || e);
    archive.finishRun(runId, 'failed', details);
    return { ok: false, runId, status: 'failed', details };
  }
}
export function summarizeReport(r) {
  const c = r.cohorts; const s = x => ({ n: x.all.n, brier: x.all.brier, logLoss: x.all.logLoss, flat25Brier: x.all.flat25Brier, matched: x.all.matched, prospectiveN: x.prospective.n, reconstructedN: x.reconstructed.n });
  return { missingExcluded: r.missingExcluded, pending: r.pending, prospective: r.prospective, reconstructed: r.reconstructed, all: s(c.all), teamCalls: s(c.teamCalls), highTd: s(c.highTd) };
}
