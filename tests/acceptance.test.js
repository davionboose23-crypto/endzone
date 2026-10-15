import { readFileSync } from 'node:fs';
// Acceptance tests mapped 1:1 to spec section 24 items 1-18.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeFixture, byName } from './fixture.js';
import { mockFetch, csv } from './helpers.js';
import { setFetch, streamCsv, fetchJson, request, isAllowed, SOURCES, looksLikeHtml } from '../server/live-feeds.js';
import { FeedCache } from '../server/feed-cache.js';
import { prepareData, cache as prepCache } from '../server/prepare.js';
import { Archive } from '../server/archive.js';
import { refresh, calibrationState } from '../server/jobs.js';
import { runEngine } from '../src/engine.js';
import { buildIndex } from '../src/stats-index.js';
import { buildIdentity, availability } from '../src/roster.js';
import { lines, parseScheduleRow, easternToUtc, requestGate, weather } from '../src/feeds.js';
import { distribution, firstTd, safetyCalibrate, americanFair, publishedProbability, edgePts, sumComponents, DEFAULT_WEIGHTS, MODEL_VERSION } from '../src/model.js';
import { binOf, spotRate, leagueRates } from '../src/spots.js';
import { tdConfidence, volumeConfidence } from '../src/confidence.js';
import { sortPlayers, compareDefault } from '../src/ranking.js';
import { snapshotPassTd } from '../src/passing-touchdowns.js';
import { midrankPercentile, thresholdExplorer } from '../src/player-research.js';
import { gradeRows, spotReport, tdReport, classifyMiss } from '../src/evaluation.js';
import { weeklyLesson, activeLessons, withInWeekNudge } from '../src/research.js';
import { trainChallenger, promotionDecision } from '../src/validation.js';
import { actualOutcome } from '../src/forecast-details.js';
import { snapshotFromGame, gradeGame } from '../src/grading.js';
import { CsvStream, parseCsv } from '../server/csv.js';

const EARLY = Date.parse('2030-09-01T00:00:00Z');
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ez-')), 'a.sqlite');
const allRaw = r => r.games.flatMap(G => [...G.sides.away.raw, ...G.sides.home.raw]);
const SCHED_H = ['game_id', 'season', 'game_type', 'week', 'gameday', 'weekday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score', 'location', 'spread_line', 'total_line', 'roof', 'temp', 'wind', 'stadium'];
function feedRoutes({ primaryFails = false, pbpHtml = false } = {}) {
  const sched = csv(SCHED_H, [
    ['2030_05_KC_BUF', 2030, 'REG', 5, '2030-10-06', 'Sunday', '13:00', 'KC', '', 'BUF', '', 'Home', 3, 47.5, 'outdoors', '', '', 'Highmark'],
    ['2030_05_MIA_NYJ', 2030, 'REG', 5, '2030-10-07', 'Monday', '20:15', 'MIA', '', 'NYJ', '', 'Home', '', '', 'outdoors', '', '', 'MetLife'],
    ['2030_05_LAR_JAC', 2030, 'REG', 5, '2030-10-06', 'Sunday', '16:25', 'LAR', '', 'JAC', '', 'Home', 0, 44, 'dome', '', '', 'X'],
    ['2030_04_KC_MIA', 2030, 'REG', 4, '2030-09-29', 'Sunday', '13:00', 'KC', 24, 'MIA', 20, 'Home', -2.5, 45, 'outdoors', 70, 4, 'Y'],
    ['2030_19_KC_BUF', 2030, 'POST', 19, '2031-01-10', 'Saturday', '13:00', 'KC', '', 'BUF', '', 'Home', 1, 50, 'outdoors', '', '', 'Z']]);
  const r = {
    [SOURCES.state()]: { body: JSON.stringify({ season: '2030', week: 5, display_week: 5 }) },
    [SOURCES.schedule()]: primaryFails ? { status: 503, body: 'down' } : { body: sched },
    [SOURCES.scheduleFallback()]: { body: sched },
    [SOURCES.players()]: { body: JSON.stringify({ 1: { player_id: '1', full_name: 'A Runner', position: 'RB', team: 'KC', gsis_id: '00-1' } }) },
    [SOURCES.stats(2030, 5)]: { status: 404, body: 'nope' },
    [SOURCES.pbp(2030)]: pbpHtml ? { body: '<!DOCTYPE html><html><body>Sign in</body></html>', headers: { 'content-type': 'text/html' } } : { status: 404, body: '' },
  };
  for (let w = 1; w <= 4; w++) r[SOURCES.stats(2030, w)] = { body: JSON.stringify({ 1: { rush_att: 10, rush_yd: 40 } }) };
  for (let w = 1; w <= 5; w++) r[SOURCES.projections(2030, w)] = { body: JSON.stringify({ 1: { rush_att: 12, rush_td: 0.4 } }) };
  return r;
}

test('1. current week/season, complete slate, 404 week, schedule fallback, spread sign, unknown-line flag', async () => {
  prepCache.clear(); const calls = []; setFetch(mockFetch(feedRoutes({ primaryFails: true }), calls));
  try {
    const prep = await prepareData({});
    assert.equal(prep.season, 2030); assert.equal(prep.week, 5); assert.equal(prep.currentWeek, 5);
    const wk = prep.games.filter(g => g.season === 2030 && g.week === 5);
    assert.equal(wk.length, 3, 'all regular-season games of the week, no postseason');
    assert.ok(prep.sources.scheduleFallback?.ok && !prep.sources.schedule.ok, 'fallback schedule used');
    assert.deepEqual(prep.weekly[5].stats, {}, '404 week becomes empty map');
    assert.ok(wk.some(g => g.away === 'LA' && g.home === 'JAX'), 'team aliases normalized');
    const kc = wk.find(g => g.id === '2030_05_KC_BUF'); const L = lines(kc);
    assert.equal(L.awaySpread, 3); assert.equal(L.homeSpread, -3); assert.equal(L.awayImplied, 47.5 / 2 - 1.5); assert.equal(L.homeImplied, 47.5 / 2 + 1.5); assert.equal(L.known, true);
    const un = lines(wk.find(g => g.id === '2030_05_MIA_NYJ')); assert.equal(un.known, false); assert.equal(un.total, 44.5); assert.equal(un.awaySpread, 0);
    const zero = lines(wk.find(g => g.away === 'LA')); assert.equal(zero.known, true); assert.equal(zero.awaySpread, 0, 'legitimate zero spread kept');
    // DST-aware kickoffs: EDT (UTC-4) in October, EST (UTC-5) in December
    assert.equal(easternToUtc('2030-10-06', '13:00'), '2030-10-06T17:00:00.000Z'); assert.equal(easternToUtc('2030-12-08', '13:00'), '2030-12-08T18:00:00.000Z');
    assert.equal(easternToUtc('2030-11-03', '13:00'), '2030-11-03T18:00:00.000Z', 'day DST ends');
    assert.equal(kc.finished, false, 'no result inferred from kickoff passing');
  } finally { setFetch(null); }
});

test('2. optional outages, stale recovery, no stale overwrite, retries, cancellation, no HTML parsed', async () => {
  prepCache.clear(); setFetch(mockFetch(feedRoutes({ pbpHtml: true })));
  try {
    const prep = await prepareData({});
    assert.ok(prep.games.length > 0); assert.equal(prep.zones, null, 'pbp HTML rejected, not parsed'); assert.equal(prep.sources.pbp.ok, false); assert.match(prep.sources.pbp.error, /HTML/);
    assert.equal(prep.sources.snaps.ok, false); assert.equal(prep.sources.snaps.optional, true);
  } finally { setFetch(null); }
  // HTML detection
  assert.ok(looksLikeHtml('  <!DOCTYPE html><html>')); assert.ok(!looksLikeHtml('a,b\n1,2'));
  setFetch(mockFetch({ 'https://x/h.csv': { body: '<html><body>login</body></html>' } }));
  await assert.rejects(streamCsv('https://x/h.csv', o => o), /HTML/); setFetch(null);
  // gzip detected from bytes even with a .csv name / wrong header
  const gz = zlib.gzipSync('a,b\n1,"x\ny"\n2,"q""z"\n');
  setFetch(mockFetch({ 'https://x/g.csv': { body: gz, headers: { 'content-type': 'text/plain' } } }));
  const rows = await streamCsv('https://x/g.csv', o => o); setFetch(null);
  assert.deepEqual(rows, [{ a: '1', b: 'x\ny' }, { a: '2', b: 'q"z' }]);
  // retries on transient failures
  let n = 0; setFetch(async () => { n++; return n < 3 ? new Response('busy', { status: 503 }) : new Response('{"ok":1}'); });
  assert.deepEqual(await fetchJson('https://x/r.json', { retries: 3 }), { ok: 1 }); assert.equal(n, 3); setFetch(null);
  // cancellation
  const ctl = new AbortController(); ctl.abort(); setFetch(mockFetch({}));
  await assert.rejects(request('https://x/c', { signal: ctl.signal }), /cancelled/); setFetch(null);
  // stale cache recovery
  let t = 0; const fc = new FeedCache({ freshMs: 10, now: () => t });
  await fc.get('k', async () => 'v1'); t = 100;
  const r = await fc.get('k', async () => { throw new Error('down'); });
  assert.equal(r.value, 'v1'); assert.equal(r.stale, true);
  // a fresh cache entry is served without refetch; TTL alone never triggers a load
  let loads = 0; const fc2 = new FeedCache({ freshMs: 1e9 }); await fc2.get('a', async () => ++loads); await fc2.get('a', async () => ++loads); assert.equal(loads, 1);
  // no stale worker overwrite
  const g = requestGate(); const a = g.next(); const b = g.next(); assert.equal(g.isCurrent(a), false); assert.equal(g.isCurrent(b), true);
  // feed relay allowlist
  assert.ok(isAllowed('https://api.sleeper.app/v1/stats/nfl/regular/2026/6')); assert.ok(!isAllowed('https://api.sleeper.app/v1/user/123')); assert.ok(!isAllowed('https://evil.example/x.csv'));
});

test('3. identity dedupe, real reserves retained, unverified cannot be High, unavailable excluded, historical roster preserved', async () => {
  const players = [
    { id: '1', name: 'Joe Back', pos: 'RB', team: 'KC', gsis: '00-1', active: true, depth: 1 },
    { id: '2', name: 'Joe Back', pos: 'RB', team: 'KC', gsis: '00-1', active: false }, // duplicate by GSIS
    { id: '3', name: 'Sam Wide', pos: 'WR', team: 'KC', espn: '55', active: true },
    { id: '4', name: 'Sam Wide', pos: 'WR', team: 'KC', espn: '55', active: false }, // duplicate by ESPN
    { id: '5', name: 'Quiet Reserve', pos: 'TE', team: 'KC', gsis: '00-5', active: true },  // no stats, on roster
    { id: '6', name: 'Test Player', pos: 'WR', team: 'KC' },
    { id: '7', name: 'Squad Guy', pos: 'WR', team: 'KC', gsis: '00-7' },
    { id: '8', name: 'Ghost', pos: 'RB', team: 'KC', gsis: '00-8' },
  ];
  const roster = [{ gsis: '00-1', sleeper: '1', team: 'KC', status: 'ACT', week: 5, name: 'Joe Back', pos: 'RB' }, { gsis: '00-5', sleeper: '5', team: 'KC', status: 'ACT', week: 5, name: 'Quiet Reserve', pos: 'TE' },
    { gsis: '00-7', sleeper: '7', team: 'KC', status: 'DEV', week: 5, name: 'Squad Guy', pos: 'WR' }, { gsis: null, sleeper: '3', team: 'KC', status: 'ACT', week: 5, name: 'Sam Wide', pos: 'WR' }];
  const id = buildIdentity({ players, roster, currentWeek: 5 });
  const ids = id.players.map(p => p.id).sort();
  assert.deepEqual(ids, ['1', '3', '5', '8']);
  assert.ok(id.rejected.some(r => /Duplicate/.test(r.reason) && r.id === '2')); assert.ok(id.rejected.some(r => r.id === '4'));
  assert.ok(id.rejected.some(r => r.id === '6' && /Placeholder/.test(r.reason))); assert.ok(id.rejected.some(r => r.id === '7' && /Practice squad/.test(r.reason)));
  assert.equal(id.players.find(p => p.id === '5').verified, true, 'real reserve with no stats retained and verified');
  assert.equal(id.players.find(p => p.id === '8').verified, false); assert.ok(id.unverified.some(u => u.id === '8'));
  // no roster feed => pending
  assert.ok(buildIdentity({ players, roster: null }).players.every(p => p.verified === null));
  // unverified cannot receive High in engine output
  const prep = makeFixture({ mutate: p => { p.roster = p.roster.filter(r => r.name !== 'KC RB1'); p.logs = p.logs.filter(l => !(l[1] === 'KC RB1' && l[4] >= 2)); } });
  const res = runEngine(prep, { now: EARLY });
  const kc = byName(res, 'KC RB1').p; assert.equal(kc.verified, false); assert.notEqual(kc.tdConf.level, 'High');
  // unavailable excluded
  assert.equal(availability({ injury: 'Out' }).excluded, true); assert.equal(availability({ injury: 'IR' }).excluded, true); assert.equal(availability({ injury: 'Sus' }).excluded, true);
  const prep2 = makeFixture({ mutate: p => { p.players.find(x => x.name === 'BUF WR1').injury = 'Out'; } });
  const r2 = runEngine(prep2, { now: EARLY });
  assert.equal(byName(r2, 'BUF WR1'), null, 'Out player not in recommendations');
  assert.ok(r2.games.some(G => [...G.sides.away.excluded, ...G.sides.home.excluded].some(e => e.name === 'BUF WR1' && e.reason === 'Out')), 'exclusion inspectable');
  // historical roster preservation: a frozen snapshot keeps the pregame team even after a trade
  const a = await Archive.open(tmpDb()); const res3 = runEngine(makeFixture(), { now: EARLY });
  const G = res3.games[0]; a.saveSnapshot(snapshotFromGame(G, { modelVersion: MODEL_VERSION, weights: DEFAULT_WEIGHTS }), { now: new Date(EARLY) });
  const traded = makeFixture({ mutate: p => { const x = p.players.find(y => y.id === G.sides.away.players[0].id); x.team = 'MIA'; } });
  runEngine(traded, { now: EARLY });
  const snap = a.snapshots(2030, 5)[0]; assert.equal(snap.roster.away[0].team, G.sides.away.team);
});

test('4. injury transfer uses observed work and the snap leader; goal-line spots go to the right back', () => {
  // KC RB1 out; RB2 has the most snaps; RB3 owns inside-5 carries; RB2 has more rush yards
  const prep = makeFixture({ mutate: p => {
    p.players.find(x => x.name === 'KC RB1').injury = 'Out';
    const g = n => p.players.find(x => x.name === n).gsis;
    for (const s of p.snaps) { if (s[6] === 'KC RB2') s[4] = 60; if (s[6] === 'KC RB3') s[4] = 15; }
    p.zones = p.zones.filter(z => !(z[0] === g('KC RB2') && z[5] === 'r' && z[6] <= 2));
    for (const w of [2, 3, 4]) { const gm = p.games.find(x => x.week === w && (x.away === 'KC' || x.home === 'KC')); p.zones.push([g('KC RB3'), w, gm.id, 'KC', gm.away === 'KC' ? gm.home : gm.away, 'r', 1, 3, 1, 9, 6, 0, 0, 0, 0, 0]); }
  } });
  const res = runEngine(prep, { now: EARLY });
  const side = res.games.find(G => G.sides.away.team === 'KC' || G.sides.home.team === 'KC'); const S = side.sides.away.team === 'KC' ? side.sides.away : side.sides.home;
  const ex = S.excluded.find(e => e.name === 'KC RB1'); assert.ok(ex?.transfer, 'transfer recorded');
  assert.equal(ex.transfer.toName, 'KC RB2', 'snap leader takes the work'); assert.equal(ex.transfer.glToName, 'KC RB3', 'goal-line spots go to the inside-5 back');
  assert.ok(Object.values(ex.transfer.vacated).every(v => v >= 0)); assert.ok(ex.transfer.weeks.every(w => w >= 2), 'only last-three-weeks observed work');
  const rb2 = S.raw.find(p => p.name === 'KC RB2'); assert.equal(rb2.replacing?.name, 'KC RB1');
  // a reserve with no observed work vacates nothing
  const prep2 = makeFixture({ mutate: p => { p.players.find(x => x.name === 'KC QB2').injury = 'Out'; } });
  const r2 = runEngine(prep2, { now: EARLY });
  const ex2 = r2.games.flatMap(G => [...G.sides.away.excluded, ...G.sides.home.excluded]).find(e => e.name === 'KC QB2'); assert.equal(ex2.transfer, null);
});

test('5. one lambda: distribution sums to 1, anytime = 1-P0, two-plus = P2+P3+, components & passing reconcile', () => {
  for (const l of [0, 0.01, 0.3, 0.8, 1.7, 4]) {
    const d = distribution(l); assert.ok(Math.abs(d.p0 + d.p1 + d.p2 + d.p3plus - 1) < 1e-12); assert.ok(Math.abs(d.anytime - (1 - d.p0)) < 1e-12); assert.ok(Math.abs(d.twoPlus - (d.p2 + d.p3plus)) < 1e-12);
  }
  assert.equal(firstTd(0.5, 0), 0); assert.equal(firstTd(0, 2), 0);
  assert.equal(americanFair(0.25), 300); assert.equal(americanFair(0.5), -100); assert.equal(americanFair(0.8), -400); assert.equal(americanFair(0), null); assert.equal(americanFair(1), null);
  assert.ok(Math.abs(publishedProbability(0.5) - (1 - Math.exp(-0.5))) < 1e-12); assert.equal(publishedProbability(null), null); assert.equal(edgePts(0.4, null), null);
  const res = runEngine(makeFixture(), { now: EARLY });
  for (const G of res.games) {
    for (const s of ['away', 'home']) {
      const S = G.sides[s]; let rec = 0;
      for (const p of S.raw) {
        assert.ok(Math.abs(sumComponents(p.components) - p.lambda) < 1e-9, 'components sum to lambda');
        assert.ok(Math.abs(p.chance - (1 - Math.exp(-p.lambda))) < 1e-9); assert.ok(Math.abs(p.dist.anytime - p.chance) < 1e-9);
        assert.ok(Object.keys(p.components).every(k => /^[rt][0-3]$/.test(k)), 'no passing component in anytime');
        rec += p.components.t0 + p.components.t1 + p.components.t2 + p.components.t3;
      }
      const qbTd = S.raw.filter(p => p.pos === 'QB').reduce((a, q) => a + q.passTd.expected, 0);
      assert.ok(Math.abs(qbTd - rec) < 1e-9, 'QB passing TDs equal team receiving-score intensity');
      assert.ok(Math.abs(S.teamLambda - S.raw.reduce((a, p) => a + p.lambda, 0)) < 1e-9);
    }
    const gl = G.sides.away.teamLambda + G.sides.home.teamLambda; const p = G.sides.home.raw[0];
    assert.ok(Math.abs(p.firstTd - (1 - Math.exp(-gl)) * p.lambda / gl) < 1e-9);
  }
});

test('6. nonoverlapping bins, outside not double counted, cold-goal reduction, missing zone actuals not zero', () => {
  assert.deepEqual([1, 5, 6, 10, 11, 20, 21, 80].map(binOf), [1, 1, 2, 2, 3, 3, 0, 0]);
  const league = leagueRates([]);
  assert.equal(league.rates.r[1], 0.48); assert.ok(league.rates.r[3] < 0.01, '11-20 rushing crushed'); assert.ok(league.rates.r[2] > 0.34 && league.rates.t[2] > 0.48, '6-10 upward correction');
  const warm = spotRate('r', 1, { looks: 2, scores: 1, recentLooks: 1, recentScores: 1 }, league);
  const cold = spotRate('r', 1, { looks: 5, scores: 0, recentLooks: 3, recentScores: 0 }, league);
  assert.equal(cold.cold, true); assert.ok(cold.rate <= 0.32); assert.ok(cold.rate < warm.rate); assert.match(cold.notes[0], /inside the 5 and has not scored/);
  const res = runEngine(makeFixture(), { now: EARLY });
  for (const p of allRaw(res)) {
    const rz = ['r1', 'r2', 'r3'].reduce((a, k) => a + p.spots[k].opps, 0);
    assert.ok(Math.abs(p.spots.r0.opps - Math.max(0, p.vol.carries - rz)) < 1e-9, 'outside carries exclude red-zone carries');
  }
  // missing zone actuals
  const prep = makeFixture(); const ix = buildIndex(prep); const g = prep.games.find(x => x.week === 4);
  ix.zoneGameSet.delete(g.id);
  const pl = prep.players.find(x => x.team === g.away && x.name.endsWith('RB1'));
  const a = actualOutcome(ix, pl, g); assert.equal(a.spotKnown, false); assert.equal(a.spotTd, null);
  const rows = [{ p: 0.4, y: 0, actual: a, components: { r1: 0.3 }, name: 'x' }];
  const sr = spotReport(rows); assert.equal(sr.excludedUnknown, 1); assert.equal(sr.meaningfulZero.length, 0);
  assert.match(classifyMiss({ actual: { ...a, carries: 20, targets: 3 }, vol: { carries: 16, targets: 3 } }), /unknown/);
});

test('7. shared caps; safety ceilings survive calibration and lessons; soft lifts do not create fringe stars', () => {
  const res = runEngine(makeFixture(), { now: EARLY });
  for (const G of res.games) for (const s of ['away', 'home']) assert.ok(G.sides[s].teamLambda <= G.sides[s].tdBudget + 1e-9);
  for (const G of res.games) for (const s of ['away', 'home']) for (const k of ['carries', 'targets', 'att']) { const F = G.sides[s].fits[k]; assert.ok(G.sides[s].raw.reduce((a, p) => a + p.vol[k], 0) <= Math.max(F.budget, F.sum * F.factor) + 1e-6); }
  assert.equal(safetyCalibrate(0.7, { insideFinisher: true, recentFinisher: false, coldGoal: false }).chance, 0.5);
  assert.equal(safetyCalibrate(0.7, { insideFinisher: true, recentFinisher: false, coldGoal: true }).chance, 0.46);
  assert.equal(safetyCalibrate(0.9, { insideFinisher: true, recentFinisher: true }).chance, 0.62);
  assert.ok(safetyCalibrate(0.45, { insideFinisher: false }).chance < 0.45 && safetyCalibrate(0.45, { insideFinisher: false }).chance > 0.28);
  // aggressive lesson cannot push past ceilings
  const lessons = { band: { lt15: 1.15, '15to25': 1.15, '25to35': 1.15, '35to50': 1.05, '50plus': 1.08 }, spot: { r1: 1.3, r2: 1.3, r3: 1.3, t1: 1.3, t2: 1.3, t3: 1.3 }, vol: {} };
  const big = runEngine(makeFixture(), { now: EARLY, lessons, weights: { ...DEFAULT_WEIGHTS, redZone: 1.5, goalLine: 1.4 } });
  for (const p of allRaw(big)) { assert.ok(p.chance <= 0.62 + 1e-9); if (!p.recentFinisher) assert.ok(p.chance <= 0.5 + 1e-9, `${p.name} ${p.chance}`); }
  // fringe player in a soft matchup is not lifted
  for (const p of allRaw(res)) if (p.recentRzLooks < 2 && p.matchup && p.matchup.factor > 1) { assert.equal(p.liftBlocked, true); assert.equal(p.matchupFactor, 1); }
});

test('8. repeat scoring counted by separate games; one multi-TD game is not a streak; riser/next option need real work', () => {
  const prep = makeFixture({ mutate: p => {
    const set = (name, tds) => { for (const l of p.logs) if (l[1] === name) { l[10] = tds[l[4]] ?? 0; l[16] = 0; } };
    set('KC WR1', {}); for (const l of p.logs) if (l[1] === 'KC WR1') l[16] = l[4] === 1 ? 3 : 0; // 3 TD in week 1, blanks after
    set('BUF RB1', { 1: 1, 2: 1, 3: 0, 4: 1 });
  } });
  const res = runEngine(prep, { now: EARLY });
  const wr = byName(res, 'KC WR1').p; assert.equal(wr.f.scoringLast5, 1, 'multi-TD game counts once'); assert.equal(wr.f.spike, true); assert.match(wr.f.spikeNote, /one game/);
  const rb = byName(res, 'BUF RB1').p; assert.equal(rb.f.scoringLast5, 3);
  for (const p of allRaw(res)) {
    if (p.riser) assert.ok(p.recentRzLooks >= 2 || p.replacing || p.f.games.at(-1)?.td > 0 || p.matchup?.soft, 'riser has real evidence');
    if (p.secondOption) assert.ok(p.recentRzLooks >= 3);
  }
});

test('9. High TD first everywhere; explicit stat sorts; recommendation name/photo/id/chance match', () => {
  const res = runEngine(makeFixture(), { now: EARLY });
  for (const G of res.games) for (const s of ['away', 'home']) {
    const P = G.sides[s].players; // compact, in display order
    for (let i = 1; i < P.length; i++) assert.ok(compareDefault(P[i - 1], P[i]) <= 0);
    const call = P.find(p => p.id === G.sides[s].call.id); const raw = G.sides[s].raw.find(p => p.id === call.id);
    assert.equal(call.name, raw.name); assert.equal(call.chance, Math.round(raw.chance * 1e4) / 1e4); assert.equal(call.photo.sleeper, raw.photo.sleeper);
    assert.ok(call.photo.sleeper.includes(call.id));
    assert.ok(G.sides[s].call.why.join(' ').includes(call.name));
    if (!G.sides[s].call.isLeader) assert.match(G.sides[s].call.why[0], /numerical leader/);
  }
  const all = res.games.flatMap(G => [...G.sides.away.players, ...G.sides.home.players]);
  const byRec = sortPlayers(all, 'recYd'); for (let i = 1; i < byRec.length; i++) assert.ok(byRec[i - 1].volume.recYd.mean >= byRec[i].volume.recYd.mean);
  const byPass = sortPlayers(all, 'passTd'); const firstNonQb = byPass.findIndex(p => p.pos !== 'QB'); assert.ok(byPass.slice(firstNonQb).every(p => p.pos !== 'QB'), 'missing values last');
  const callsBefore = res.games.map(G => G.sides.away.call.id + G.sides.home.call.id).join(); sortPlayers(all, 'rushYd');
  assert.equal(res.games.map(G => G.sides.away.call.id + G.sides.home.call.id).join(), callsBefore, 'stat sort leaves team calls unchanged');
  const pick = all.find(p => p.id === res.weeklyPickId); assert.ok(pick); const top = sortPlayers(all.filter(p => !p.started), 'default')[0]; assert.equal(pick.id, top.id);
});

test('10. independent metric confidence; availability final; favorable defense cannot undo a block', () => {
  const res = runEngine(makeFixture(), { now: EARLY });
  const rows = allRaw(res);
  assert.ok(rows.some(p => p.tdConf.level !== p.volConf.recYd.level), 'areas are independent');
  const p = rows.find(x => x.name.endsWith('WR1'));
  const doubt = { ...p, avail: { ...availability({ injury: 'Doubtful' }) } };
  assert.equal(tdConfidence(doubt).level, 'Low'); for (const m of ['rushYd', 'rec', 'recYd']) assert.equal(volumeConfidence(m, doubt, p.volume[m]).level === 'High', false);
  assert.equal(volumeConfidence('rec', doubt, p.volume.rec).level === 'High', false);
  const q = { ...p, verified: false };
  const fav = { ...p.volume.rec, defense: { allowed: 0.9, league: 0.6 } };
  assert.notEqual(volumeConfidence('rec', q, fav).level, 'High', 'favorable defense cannot override an unverified block');
  const tight = { ...p.volume.rec, defense: { allowed: 0.5, league: 0.65 } };
  assert.notEqual(volumeConfidence('rec', p, tight).level, 'High', 'tight defense drops High');
  assert.ok(volumeConfidence('rec', p, p.volume.rec, { coverage: 0.6 }).level !== 'High', 'coverage < 72% blocks High');
  assert.equal(volumeConfidence('rec', p, p.volume.rec).provisional, true);
  const tiny = { ...p, vol: { ...p.vol, targets: 0.1 } }; assert.equal(volumeConfidence('rec', tiny, p.volume.rec).level, 'Low');
});

test('11. passing TD: one decimal, separate provisional confidence, excluded from QB anytime, old snapshot unavailable', () => {
  const res = runEngine(makeFixture(), { now: EARLY });
  const qb = byName(res, 'KC QB1').p; assert.match(qb.passTd.display, /^\d+\.\d$/); assert.ok(['Med', 'Low'].includes(qb.passTd.level)); assert.equal(qb.passTd.provisional, true);
  assert.ok(qb.passTd.interval[0] <= qb.passTd.expected && qb.passTd.interval[1] >= qb.passTd.expected);
  // changing receiving output changes passing TDs but not the QB's own anytime chance
  const r2 = runEngine(makeFixture(), { now: EARLY, weights: { ...DEFAULT_WEIGHTS, tePremium: 1.3 } });
  const qb2 = byName(r2, 'KC QB1').p; assert.ok(Math.abs(qb2.chance - qb.chance) < 0.02);
  const compact = res.games.flatMap(G => [...G.sides.away.players, ...G.sides.home.players]);
  assert.ok(compact.filter(p => p.pos !== 'QB').every(p => p.passTd === null));
  // User-requested deviation: no QB-only columns in matchup/Board tables; QB rows carry an inline pass line.
  { const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.ok(!/<th[^>]*>QB pass (TD|yds)<\/th>/.test(app), 'no QB pass columns'); assert.ok(/const qbLine = p => p\.pos === 'QB'/.test(app)); assert.match(app, /SORTS|passTd/); }
  assert.deepEqual(snapshotPassTd({ pos: 'QB' }), { display: 'n/s', note: 'Not saved before kickoff', na: true });
  assert.equal(snapshotPassTd({ pos: 'WR' }).display, '—');
});

test('12. every eligible player from both teams appears; no truncation to stars', () => {
  const prep = makeFixture(); const res = runEngine(prep, { now: EARLY });
  for (const G of res.games) for (const s of ['away', 'home']) {
    const team = G.sides[s].team; const eligible = res.identity.players.filter(p => p.team === team && !availability(p, { historical: G.historical }).excluded);
    assert.equal(G.sides[s].players.length, eligible.length); assert.equal(G.sides[s].players.length, 10);
  }
});

test('13. percentiles/threshold use earlier games only; ties and missing handled', () => {
  assert.equal(midrankPercentile(5, [1, 2, 3, 4]), null, 'needs 5 known peers');
  assert.equal(midrankPercentile(3, [3, 3, 3, 3, 3]), 50, 'tie-safe midrank');
  assert.equal(midrankPercentile(5, [1, 2, null, 3, 4, 5]), 90);
  const games = [{ season: 2030, week: 3, rushYd: 80 }, { season: 2030, week: 4, rushYd: 20 }, { season: 2030, week: 5, rushYd: 150 }, { season: 2029, week: 17, rushYd: 100 }];
  const t = thresholdExplorer(games, 'rushYd', 70, { season: 2030, week: 5 });
  assert.equal(t.games, 3, 'selected-game result excluded'); assert.equal(t.hits, 2); assert.match(t.label, /not a calibrated/);
  const res = runEngine(makeFixture(), { now: EARLY });
  for (const p of allRaw(res)) assert.ok(p.f.logs.every(l => l.week < 5 || l.season < 2030), 'features use only earlier games');
});

test('14. frozen predictions immutable; strictly pregame timestamps; missing results excluded', async () => {
  const a = await Archive.open(tmpDb()); const res = runEngine(makeFixture(), { now: EARLY }); const G = res.games[0];
  const meta = { modelVersion: MODEL_VERSION, weights: DEFAULT_WEIGHTS };
  const kick = Date.parse(G.game.kickoff);
  assert.equal(a.saveSnapshot(snapshotFromGame(G, meta), { now: new Date(kick) }).saved, false, 'at kickoff refused');
  assert.equal(a.saveSnapshot(snapshotFromGame(G, meta), { now: new Date(kick - 3600e3) }).saved, true);
  const frozen = JSON.stringify(a.snapshots(2030, 5)[0].players);
  // later weights / injuries / lessons / new data cannot alter it (post-kickoff writes refused)
  const r2 = runEngine(makeFixture({ mutate: p => { p.players[0].injury = 'Out'; } }), { now: kick + 1, weights: { ...DEFAULT_WEIGHTS, redZone: 1.5 }, lessons: { band: { lt15: 1.1 }, spot: {}, vol: {} } });
  assert.equal(a.saveSnapshot(snapshotFromGame(r2.games[0], meta), { now: new Date(kick + 60e3) }).saved, false);
  assert.equal(JSON.stringify(a.snapshots(2030, 5)[0].players), frozen);
  const first = a.snapshots(2030, 5, 'first')[0]; assert.ok(Date.parse(first.capturedAt) < kick);
  // first kept, latest replaced pre-kickoff
  a.saveSnapshot(snapshotFromGame(r2.games[0], meta), { now: new Date(kick - 60e3) });
  assert.equal(JSON.stringify(a.snapshots(2030, 5, 'first')[0].players), frozen);
  // reopen from disk (durable)
  const b = await Archive.open(a.file); assert.equal(b.snapshots(2030, 5, 'first').length, 1); assert.equal(b.schemaVersion(), 2);
  const g = gradeRows([{ chance: 0.3, actual: { status: 'missing' } }, { chance: 0.3, actual: { status: 'confirmed-zero', td: 0 } }, { chance: 0.3, actual: { status: 'pending' } }]);
  assert.equal(g.rows.length, 1); assert.equal(g.missing.length, 1); assert.equal(g.pending.length, 1);
});

test('15. lessons: last three weeks averaged with missing=1; in-week uses earlier results; no future leakage', () => {
  const L = w => ({ applied: true, vol: { rushYd: 0.8 }, band: { '35to50': 0.6 }, spot: { r1: 1.2 }, week: w });
  const act = activeLessons({ 1: L(1), 3: L(3), 5: L(5) }, 5); // weeks 4,3,2 -> only week 3 present
  assert.ok(Math.abs(act.vol.rushYd - (0.8 + 1 + 1) / 3) < 1e-12); assert.ok(Math.abs(act.band['35to50'] - (0.6 + 2) / 3) < 1e-12);
  const rows = Array.from({ length: 7 }, (_, i) => ({ chance: 0.4, actual: { status: 'confirmed', td: 0, rushYd: 10 }, volume: { rushYd: { mean: 50 } } }));
  assert.equal(weeklyLesson(rows).applied, false, 'needs 8 confirmed');
  const rows8 = [...rows, rows[0]]; const wl = weeklyLesson(rows8); assert.equal(wl.applied, true); assert.ok(wl.vol.rushYd >= 0.72 && wl.vol.rushYd <= 1.1); assert.ok(wl.band['35to50'] >= 0.45);
  const nud = withInWeekNudge({ vol: { rushYd: 1 }, band: { lt15: 1 }, spot: { r1: 1 } }, { applied: true, confirmed: 9, vol: { rushYd: 0.7 }, band: { lt15: 1.15 }, spot: { r1: 1 } });
  assert.ok(Math.abs(nud.vol.rushYd - (0.7 + 2) / 3) < 1e-12);
  const graded = Array.from({ length: 400 }, (_, i) => ({ season: 2030, week: 1 + (i % 6), gameId: `g${i % 30}`, chance: 0.2, lambda: 0.22, components: { r0: 0.1 }, y: i % 5 === 0 ? 1 : 0, pos: 'RB' }));
  const ch = trainChallenger(graded, { season: 2030, week: 4, modelVersion: MODEL_VERSION });
  assert.equal(ch.trainingCount, graded.filter(r => r.week < 4).length, 'only weeks before target');
});

test('16. challenger promotion gates, protected cohorts, version provenance, snapshots carry both variants', async () => {
  // champion miscalibrated at 40% on a 25% base rate; a better challenger is calibrated at 25%
  const mk = (n, games, better) => Array.from({ length: n }, (_, i) => { const y = i % 4 === 0 ? 1 : 0; return { gameId: `g${i % games}`, y, chance: 0.4, challenger: better ? 0.25 : 0.4, prospective: true, modelVersion: MODEL_VERSION, teamCall: i % 10 === 1, tdConf: i % 7 === 0 ? 'High' : 'Med', contributor: true }; });
  let d = promotionDecision(mk(300, 20, true), { modelVersion: MODEL_VERSION }); assert.equal(d.promote, false); assert.ok(d.reasons.some(r => /500/.test(r))); assert.ok(d.reasons.some(r => /40 games/.test(r)));
  d = promotionDecision(mk(800, 50, false), { modelVersion: MODEL_VERSION }); assert.equal(d.promote, false); assert.ok(d.reasons.some(r => /Brier/.test(r)));
  d = promotionDecision(mk(800, 50, true), { modelVersion: MODEL_VERSION }); assert.equal(d.promote, true, JSON.stringify(d.reasons)); assert.ok(d.metrics.protected.teamCalls.n >= 80);
  d = promotionDecision(mk(800, 50, true).map(x => ({ ...x, modelVersion: 'old' })), { modelVersion: MODEL_VERSION }); assert.equal(d.promote, false, 'other versions never count');
  // snapshots save production + challenger probabilities with training cutoff
  const prep = makeFixture(); const a = await Archive.open(tmpDb());
  const r = await refresh(a, { prep, now: () => EARLY });
  assert.equal(r.ok, true, JSON.stringify(r.details));
  const s = a.snapshots(2030, 5)[0]; assert.equal(s.modelVersion, MODEL_VERSION); assert.ok(s.challenger && 'trainingCutoff' in s.challenger); assert.ok(s.players.every(p => 'challenger' in p && 'chance' in p));
});

test('17. Sunday audit flows into Monday forecasts via the same pipeline; Sunday grades frozen; archive matches display', async () => {
  const prep = makeFixture(); const a = await Archive.open(tmpDb());
  const sun = prep.games.find(g => g.week === 5 && g.weekday === 'Sunday'); const mon = prep.games.find(g => g.week === 5 && g.weekday === 'Monday');
  // Saturday: refresh saves pregame frames for both games
  const sat = Date.parse(sun.kickoff) - 86400e3;
  await refresh(a, { prep, now: () => sat });
  const sunFrozen = JSON.stringify(a.snapshots(2030, 5).find(s => s.gameId === sun.id).players);
  // Sunday game finishes with results
  prep._emit(sun, 5);
  const tue = Date.parse(mon.kickoff) - 3600e3;
  const ix = buildIndex(prep);
  const cal = calibrationState(a, prep, ix, 2030, 5);
  assert.equal(cal.inWeek.applied, true, 'Sunday results form an in-week lesson'); assert.ok(cal.inWeek.prospective >= 8, 'graded from frozen Sunday frames');
  const before = runEngine(prep, { ix, now: tue, lessons: cal.active, lessonsUnplayed: cal.active });
  const after = runEngine(prep, { ix, now: tue, lessons: cal.active, lessonsUnplayed: cal.unplayedLessons });
  const mb = before.games.find(G => G.gameId === mon.id), ma = after.games.find(G => G.gameId === mon.id);
  const diffs = mb.sides.home.players.map(p => Math.abs(p.chance - ma.sides.home.players.find(q => q.id === p.id).chance));
  const volDiffs = mb.sides.home.players.map(p => Math.abs((p.volume.recYd.mean || 0) - (ma.sides.home.players.find(q => q.id === p.id).volume.recYd.mean || 0)));
  assert.ok(Math.max(...diffs, ...volDiffs) > 1e-6, 'Monday forecast changed by the Sunday audit');
  // Monday refresh archives the new frame; Sunday frame stays frozen
  await refresh(a, { prep, now: () => tue });
  assert.equal(JSON.stringify(a.snapshots(2030, 5).find(s => s.gameId === sun.id).players), sunFrozen, 'Sunday grade frozen');
  const monSnap = a.snapshots(2030, 5).find(s => s.gameId === mon.id);
  const cal2 = calibrationState(a, prep, buildIndex(prep), 2030, 5);
  const display = runEngine(prep, { now: tue, weights: DEFAULT_WEIGHTS, lessons: cal2.active, lessonsUnplayed: cal2.unplayedLessons, errorModel: cal2.errorModel, coverage: cal2.coverage, challenger: null });
  const dm = display.games.find(G => G.gameId === mon.id);
  for (const p of monSnap.players) { const q = [...dm.sides.away.players, ...dm.sides.home.players].find(x => x.id === p.id); assert.equal(q.chance, p.chance, `${p.name} archived == displayed`); assert.deepEqual(q.volume.recYd.mean, p.volume.recYd.mean); }
  // graded Sunday rows use the frozen frame
  const gr = gradeGame(buildIndex(prep), sun, a.snapshots(2030, 5).find(s => s.gameId === sun.id).players, { prospective: true });
  assert.ok(gr.every(r => r.actual.status !== 'pending'));
  fs.writeFileSync(path.join(os.tmpdir(), 'endzone-before-after.json'), JSON.stringify({ monday: mon.id, players: mb.sides.home.players.map(p => ({ name: p.name, before: p.chance, after: ma.sides.home.players.find(q => q.id === p.id).chance })) }, null, 1));
});

test('18. manual refresh works; no background schedule by default; secrets never reach bundles, files, or logs', async () => {
  const src = ['server/server.js', 'server/jobs.js', 'server/prepare.js', 'server/live-feeds.js', 'server/feed-cache.js'].map(f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
  assert.ok(!/setInterval\s*\(/.test(src), 'no server-side interval schedule');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /enabled: false/); assert.equal((app.match(/setInterval\(/g) || []).length, 1, 'only the opt-in auto-refresh interval'); assert.match(app, /if \(S\.auto\.enabled\) autoTimer = setInterval/);
  const secret = 'tok_' + Math.random().toString(36).slice(2);
  process.env.ENDZONE_TOKEN = secret;
  const logs = [];
  const { createServer } = await import(`../server/server.js?t=${Date.now()}`);
  const { server } = await createServer({ dbFile: tmpDb(), log: m => logs.push(m) });
  await new Promise(r => server.listen(0, r)); const port = server.address().port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/archive`)).status, 401); const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); assert.deepEqual(Object.keys(h).sort(), ["modelVersion", "ok", "schedule", "schemaVersion"], "health is a public liveness probe without data");
    const ok = await fetch(`http://127.0.0.1:${port}/api/health?x=1`, { headers: { authorization: `Bearer ${secret}` } }); assert.equal(ok.status, 200); assert.ok(!(await ok.text()).includes(secret));
    const sites = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'OAI-Sites-Authorization': `Bearer ${secret}` } }); assert.equal(sites.status, 200);
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text(); const js = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
    assert.ok(!page.includes(secret) && !js.includes(secret));
    // manual refresh endpoint (offline mocked feeds)
    prepCache.clear(); setFetch(mockFetch(feedRoutes()));
    const r = await fetch(`http://127.0.0.1:${port}/api/jobs/refresh`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: '{}' });
    const body = await r.json(); assert.ok(['success', 'partial'].includes(body.status), JSON.stringify(body)); assert.ok(!JSON.stringify(body).includes(secret));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/feed?url=${encodeURIComponent('https://evil.example/a.csv')}`, { headers: { authorization: `Bearer ${secret}` } })).status, 403);
  } finally { setFetch(null); server.close(); delete process.env.ENDZONE_TOKEN; }
  assert.ok(logs.length > 0 && logs.every(l => !l.includes(secret)), 'logs never contain the token');
  for (const dir of ['public', 'src', 'server']) for (const f of fs.readdirSync(new URL(`../${dir}`, import.meta.url))) assert.ok(!fs.readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8').includes(secret));
});

test('CSV parser: quoted fields, escaped quotes, multiline, CRLF, chunk boundaries', () => {
  const rows = []; const s = new CsvStream(r => rows.push(r)); const text = 'a,b\r\n"x,1","he said ""hi"""\r\n"multi\nline",2\n';
  for (const ch of text) s.push(ch); s.end();
  assert.deepEqual(rows, [['a', 'b'], ['x,1', 'he said "hi"'], ['multi\nline', '2']]);
  assert.deepEqual(parseCsv('h\n"q"\n'), [{ h: 'q' }]);
});
