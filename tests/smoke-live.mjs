// Real-data smoke test against live Sleeper + nflverse feeds for the current week.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { prepareData } from '../server/prepare.js';
import { Archive } from '../server/archive.js';
import { refresh, calibrationState } from '../server/jobs.js';
import { runEngine } from '../src/engine.js';
import { buildIndex } from '../src/stats-index.js';
import { tdReport, volumeReport } from '../src/evaluation.js';
const t0 = Date.now();
const prep = await prepareData({ force: true });
const out = { ranAt: new Date().toISOString(), season: prep.season, week: prep.week, currentWeek: prep.currentWeek, prepareMs: Date.now() - t0, payloadBytes: JSON.stringify(prep).length,
  sources: Object.fromEntries(Object.entries(prep.sources).map(([k, s]) => [k, { ok: s.ok, rows: s.rows, error: s.error || undefined }])) };
const ix = buildIndex(prep);
const a = await Archive.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ez-smoke-')), 'smoke.sqlite'));
const job = await refresh(a, { prep }); out.refresh = { status: job.status, steps: job.details.steps };
const cal = calibrationState(a, prep, ix, prep.season, prep.week);
const t1 = Date.now();
const res = runEngine(prep, { ix, lessons: cal.active, lessonsUnplayed: cal.unplayedLessons });
out.engineMs = Date.now() - t1;
out.identity = { players: res.identity.players.length, rejected: res.identity.rejected.length, unverified: res.identity.unverified.length };
const all = res.games.flatMap(G => [...G.sides.away.players, ...G.sides.home.players]);
out.games = res.games.map(G => ({ id: G.gameId, kickoff: G.game.kickoff, started: G.started, spread: G.sides.away.lines.awaySpread, total: G.sides.away.lines.total, linesKnown: G.sides.away.lines.known,
  away: { team: G.sides.away.team, implied: +G.sides.away.implied.toFixed(2), modelTd: +G.sides.away.teamLambda.toFixed(2), budget: +G.sides.away.tdBudget.toFixed(2), players: G.sides.away.players.length, excluded: G.sides.away.excluded.length, call: (p => p && `${p.name} ${(p.chance * 100).toFixed(1)}% ${p.tdConf.level}`)(G.sides.away.players.find(p => p.id === G.sides.away.call?.id)) },
  home: { team: G.sides.home.team, implied: +G.sides.home.implied.toFixed(2), modelTd: +G.sides.home.teamLambda.toFixed(2), budget: +G.sides.home.tdBudget.toFixed(2), players: G.sides.home.players.length, excluded: G.sides.home.excluded.length, call: (p => p && `${p.name} ${(p.chance * 100).toFixed(1)}% ${p.tdConf.level}`)(G.sides.home.players.find(p => p.id === G.sides.home.call?.id)) } }));
out.counts = { players: all.length, highTd: all.filter(p => p.tdConf.level === 'High').length, medTd: all.filter(p => p.tdConf.level === 'Med').length, withPublished: all.filter(p => p.published).length, risers: all.filter(p => p.riser).length, over50: all.filter(p => p.chance > 0.5).length, maxChance: Math.max(...all.map(p => p.chance)) };
out.top10 = all.slice().sort((x, y) => y.chance - x.chance).slice(0, 10).map(p => `${p.name} ${p.team} ${(p.chance * 100).toFixed(1)}% [${p.tdConf.level}] edge ${p.edge == null ? 'n/a' : p.edge.toFixed(1)}`);
out.weeklyPick = (p => p && `${p.name} ${(p.chance * 100).toFixed(1)}% ${p.tdConf.level}`)(all.find(p => p.id === res.weeklyPickId));
out.qbPassTd = all.filter(p => p.pos === 'QB' && p.passTd && p.vol.att > 20).slice(0, 8).map(p => `${p.name} ${p.passTd.display} (${p.passTd.interval.join('-')}) ${p.passTd.level}`);
const rep = tdReport(cal.graded); const c = rep.cohorts;
const m = x => x && { n: x.n, brier: x.brier && +x.brier.toFixed(4), logLoss: x.logLoss && +x.logLoss.toFixed(4), flat25Brier: x.flat25Brier && +x.flat25Brier.toFixed(4), matchedN: x.matched.n, matchedModel: x.matched.model && +x.matched.model.toFixed(4), matchedPublished: x.matched.published && +x.matched.published.toFixed(4) };
out.reconstructedBacktestWeeks1toPrev = { note: 'Reconstructed from earlier-week features (not prospective).', prospective: rep.prospective, reconstructed: rep.reconstructed, missingExcluded: rep.missingExcluded,
  all: m(c.all.all), contributors: m(c.contributors.all), teamCalls: m(c.teamCalls.all), highTd: m(c.highTd.all), bins: c.all.all.bins.map(b => `${b.label}: n${b.n} avg ${(b.avgChance * 100 || 0).toFixed(1)}% hit ${(b.hitRate * 100 || 0).toFixed(1)}%`),
  teamCallHits: `${c.teamCalls.all.scored}/${c.teamCalls.all.n}`, highHits: `${c.highTd.all.scored}/${c.highTd.all.n}` };
const vr = volumeReport(cal.graded); out.volumeReconstructed = Object.fromEntries(Object.entries(vr).filter(([k]) => k !== 'passTd').map(([k, v]) => [k, { n: v.overall.n, mae: +v.overall.mae?.toFixed(2), bias: +v.overall.bias?.toFixed(2), coverage80: +v.overall.coverage?.toFixed(3), highCoverage: v.byConfidence.High ? +v.byConfidence.High.coverage?.toFixed(3) : null, highN: v.byConfidence.High?.n || 0 }]));
out.lessons = { active: cal.active.vol, band: cal.active.band, spot: cal.active.spot, label: cal.active.label, inWeek: { applied: cal.inWeek.applied, confirmed: cal.inWeek.confirmed } };
out.challenger = { status: cal.challenger.fit ? cal.challenger.kind : 'not fit', trainingCount: cal.challenger.trainingCount, reason: cal.challenger.reason };
fs.writeFileSync(new URL('../SMOKE_RESULTS.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
