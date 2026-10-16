// Web Worker orchestration: staged loading, recovery cache, cancellation, stale
// response protection (request ids), weight recalculation of unplayed games only.
import { fetchPrepared, saveLastSuccessful, loadLastSuccessful, STAGES } from './feeds.js';
import { runEngine } from './engine.js';
import { buildIndex } from './stats-index.js';
import { DEFAULT_WEIGHTS, MODEL_VERSION, sanitizeWeights } from './model.js';
import { playerDetail } from './forecast-details.js';
import { thresholdExplorer } from './player-research.js';
import { gradeGame } from './grading.js';
import { tdReport, volumeReport } from './evaluation.js';
import { challengerProbability } from './validation.js';
import { componentState } from './calibration.js';
import { gameResults, weekResults } from './results.js';

const state = { prep: null, ix: null, identity: null, archive: null, base: null, live: null, controller: null, token: null, weights: DEFAULT_WEIGHTS };
const post = (m) => self.postMessage(m);
const headers = () => (state.token ? { authorization: `Bearer ${state.token}` } : {});
const authFetch = (u, o = {}) => fetch(u, { ...o, headers: { ...(o.headers || {}), ...headers() } });

async function loadArchive(season, week, signal) {
  try { const r = await authFetch(`/api/archive?season=${season}&week=${week}`, { signal }); if (r.status === 401) throw Object.assign(new Error('auth'), { auth: true }); if (!r.ok) throw new Error(`archive HTTP ${r.status}`); const a = await r.json(); saveLastSuccessful(`archive:${season}:${week}`, a); return { ...a, stale: false }; }
  catch (e) { if (e.auth) throw e; const c = await loadLastSuccessful(`archive:${season}:${week}`); return c ? { ...c.value, stale: true, staleError: String(e.message) } : { snapshots: [], lessons: {}, activeCalibration: null, uncertainty: {}, challenger: null, stale: true, staleError: String(e.message) }; }
}
function challengerFn(a) { const c = a?.challenger; return c?.fit ? (p => challengerProbability({ fit: c.fit }, p, null, null)) : null; }

function compute(weights) {
  const a = state.archive || {}; const cal = a.activeCalibration || {};
  const common = { ix: state.ix, identity: state.identity, lessons: cal.active || null, lessonsUnplayed: cal.unplayed || null, errorModel: a.uncertainty?.errorModel || null, coverage: a.uncertainty?.coverage || null, challenger: challengerFn(a), useChallenger: !!componentState().challenger?.enabled, now: Date.now() };
  // production (default-weight) run supplies frozen/reconstructed started games
  if (!state.base) state.base = runEngine(state.prep, { ...common, weights: DEFAULT_WEIGHTS });
  const live = sameWeights(weights, DEFAULT_WEIGHTS) ? state.base : runEngine(state.prep, { ...common, weights });
  state.live = live;
  const snaps = new Map((a.snapshots || []).map(s => [s.gameId, s]));
  const games = live.games.map((G, i) => {
    const B = state.base.games[i];
    const snap = snaps.get(G.gameId);
    const pack = (src, frozen) => ({ id: src.gameId, game: G.game, gameLambda: src.gameLambda, started: G.started, historical: src.historical, frozen,
      sides: Object.fromEntries(['away', 'home'].map(s => { const S = src.sides[s]; return [s, { team: S.team, opp: S.opp, spread: S.spread, implied: S.implied, lines: S.lines, weather: S.weather, teamLambda: S.teamLambda, tdBudget: S.tdBudget, teamNotes: S.teamNotes, call: S.call, players: S.players, excluded: S.excluded, transfers: S.transfers }]; })) });
    if (G.started && snap) {
      const out = pack(B, 'snapshot');
      for (const s of ['away', 'home']) { const ids = new Set(snap.roster[s].map(r => r.id)); out.sides[s].players = snap.players.filter(p => ids.has(p.id)); out.sides[s].call = { ...(out.sides[s].call || {}), id: snap.callIds[s], why: ['Frozen pregame call.'] }; out.sides[s].teamLambda = snap.teams[s].teamLambda; out.sides[s].tdBudget = snap.teams[s].tdBudget; }
      out.capturedAt = snap.capturedAt; out.snapshotModel = snap.modelVersion; out.gameLambda = snap.gameLambda;
      return out;
    }
    if (G.started) return pack(B, 'reconstructed');
    return pack(G, 'live');
  });
  for (const g of games) if (g.game.finished) { try { g.results = gameResults(state.ix, g.game, g.sides, { frozen: g.frozen }); } catch (e) { g.results = null; } }
  return { games, weeklyPickId: live.weeklyPickId, riserId: live.riserId };
}
const sameWeights = (a, b) => Object.keys(DEFAULT_WEIGHTS).every(k => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 1e-9);

function slateMessage(reqId, extra = {}) {
  const c = compute(state.weights);
  const all = c.games.flatMap(g => [...g.sides.away.players, ...g.sides.home.players]);
  const unplayed = c.games.filter(g => !g.started).flatMap(g => [...g.sides.away.players, ...g.sides.home.players]);
  const sorted = unplayed.slice().sort((a, b) => ((a.tdConf?.level === 'High' ? 0 : 1) - (b.tdConf?.level === 'High' ? 0 : 1)) || b.chance - a.chance);
  const pick = sorted[0] || null;
  const riser = unplayed.filter(p => p.riser).sort((a, b) => b.chance - a.chance)[0] || null;
  return { type: 'slate', reqId, season: state.prep.season, week: state.prep.week, currentWeek: state.prep.currentWeek, generatedAt: state.prep.generatedAt, sources: state.prep.sources,
    games: c.games, weekResults: weekResults(c.games), learned: state.archive?.learned || null, repoArchive: !!state.archive?.repoArchive, weeklyPickId: pick?.id || null, riserId: riser?.id || null, modelVersion: MODEL_VERSION, weights: state.weights,
    audit: { rejected: state.identity.rejected, unverified: state.identity.unverified, excluded: c.games.flatMap(g => [...g.sides.away.excluded, ...g.sides.home.excluded].map(e => ({ ...e, team: e.team }))) },
    lessons: state.archive?.activeCalibration || null, archiveStale: !!state.archive?.stale, challenger: state.archive?.challenger || null, research: state.archive?.researchStatus || null, pickTracker: state.archive?.pickTracker || null, lastRun: state.archive?.lastRun || null, ...extra };
}

async function load(m) {
  state.controller?.abort();
  const ctl = new AbortController(); state.controller = ctl;
  const reqId = m.reqId; state.weights = sanitizeWeights(m.weights || DEFAULT_WEIGHTS);
  if (m.token !== undefined) state.token = m.token;
  try {
    const prep = await fetchPrepared({ season: m.season, week: m.week, force: m.force, signal: ctl.signal, fetchFn: authFetch, onStage: s => post({ type: 'stage', reqId, ...s }) });
    if (ctl.signal.aborted) return;
    saveLastSuccessful(`prep:${prep.season}:${prep.week}`, prep); saveLastSuccessful('prep:last', prep);
    post({ type: 'stage', reqId, stage: 4, label: STAGES[3] });
    const archive = await loadArchive(prep.season, prep.week, ctl.signal);
    if (ctl.signal.aborted) return;
    setData(prep, archive);
    post(slateMessage(reqId, { stale: false }));
  } catch (e) {
    if (ctl.signal.aborted) return post({ type: 'cancelled', reqId });
    if (String(e.message).includes('401') || e.auth) return post({ type: 'auth', reqId });
    const cached = (m.week && await loadLastSuccessful(`prep:${m.season}:${m.week}`)) || await loadLastSuccessful('prep:last');
    if (cached) {
      const archive = await loadArchive(cached.value.season, cached.value.week).catch(() => ({ snapshots: [] }));
      setData(cached.value, archive);
      post(slateMessage(reqId, { stale: true, staleSince: cached.savedAt, error: String(e.message) }));
    } else post({ type: 'error', reqId, error: String(e.message) });
  }
}
function setData(prep, archive) { state.prep = prep; state.ix = buildIndex(prep); state.identity = null; state.base = null; state.archive = archive;
  const r = runEngine(prep, { ix: state.ix, weights: DEFAULT_WEIGHTS, lessons: archive?.activeCalibration?.active || null, lessonsUnplayed: archive?.activeCalibration?.unplayed || null, errorModel: archive?.uncertainty?.errorModel || null, coverage: archive?.uncertainty?.coverage || null, challenger: challengerFn(archive) });
  state.identity = r.identity; state.base = r; }

function findRaw(gameId, playerId) {
  const run = state.live || state.base; const G = run.games.find(g => g.gameId === gameId); if (!G) return null;
  for (const s of ['away', 'home']) { const p = G.sides[s].raw.find(x => x.id === playerId); if (p) return { G, s, p, run }; }
  return null;
}
function backtest(reqId) {
  const a = state.archive || {}; const snaps = new Map((a.snapshots || []).map(s => [s.gameId, s]));
  const preds = [];
  for (const G of state.base.games) {
    const g = G.game; if (!g.finished) continue; const snap = snaps.get(g.id);
    if (snap) preds.push(...gradeGame(state.ix, g, snap.players, { prospective: true, callIds: snap.callIds, source: 'frozen snapshot' }));
    else preds.push(...gradeGame(state.ix, g, [...G.sides.away.players, ...G.sides.home.players], { prospective: false, callIds: { away: G.sides.away.call?.id, home: G.sides.home.call?.id }, source: 'reconstructed' }));
  }
  post({ type: 'backtest', reqId, week: state.prep.week, td: tdReport(preds), volume: volumeReport(preds), finishedGames: state.base.games.filter(G => G.game.finished).length });
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'load') return load(m);
    if (m.type === 'cancel') { state.controller?.abort(); return; }
    if (!state.prep) return post({ type: 'error', reqId: m.reqId, error: 'No slate loaded yet' });
    if (m.type === 'recalc') { state.weights = sanitizeWeights(m.weights); return post(slateMessage(m.reqId, { recalculated: true })); }
    if (m.type === 'detail') {
      const f = findRaw(m.gameId, m.playerId); if (!f) return post({ type: 'detail', reqId: m.reqId, error: 'Player not found' });
      const slate = f.run.games.find(g => g.gameId === m.gameId) ? f.run.games.flatMap(g => [...g.sides.away.raw, ...g.sides.home.raw]) : [];
      return post({ type: 'detail', reqId: m.reqId, playerId: m.playerId, gameId: m.gameId, detail: playerDetail(f.run.W, f.G, f.s, f.p, slate) });
    }
    if (m.type === 'threshold') {
      const f = findRaw(m.gameId, m.playerId); if (!f) return;
      const games = [...f.p.f.logs, ...f.p.f.prevLogs];
      return post({ type: 'threshold', reqId: m.reqId, result: thresholdExplorer(games, m.metric, Number(m.threshold), { season: state.prep.season, week: state.prep.week }) });
    }
    if (m.type === 'backtest') return backtest(m.reqId);
  } catch (e) { post({ type: 'error', reqId: m.reqId, error: String(e.message || e) }); }
};
