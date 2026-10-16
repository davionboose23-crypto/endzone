// Production forecast pipeline. The same code runs in the browser worker and in
// the server refresh job, so archived unplayed-game predictions match the display.
import { stackX, stackPredict } from './stack.js';
import { fitFor, applyVolCal } from './calibration.js';
import { playerTrendsWithStatus, defenseTrendsWithStatus, teamTrendsWithStatus, trendMultipliers, componentMult, shippedTrendWeights } from './trends.js';
import { MODEL_VERSION, sanitizeWeights, clamp, distribution, anytimeFromLambda, lambdaFromChance, firstTd, publishedProbability, edgePts, scaleComponents, sumComponents, safetyCalibrate, sanitizeCaps, chanceBand, americanFair, pct } from './model.js';
import { lines, weather } from './feeds.js';
import { availability } from './roster.js';
import { BINS, leagueRates, spotRate, outsideRate, qualityFactor, betaPosterior, defenseSpotFactor } from './spots.js';
import { buildMatchupTables, positionMatchup, efficiencyFactor, matchupSentence } from './matchups.js';
import { playerFeatures, depthPrior, playerVolume, transferWork, teamBudget, fitToBudget, teamGameTotals, usageScore } from './opportunity.js';
import { allocatePassingTd } from './passing-touchdowns.js';
import { tdConfidence, volumeConfidence } from './confidence.js';
import { chooseTeamCall } from './ranking.js';
import { allLogsBefore, teamZoneRows } from './stats-index.js';

export const PATHS = ['r', 't'];
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
export function chanceBandKey(p) { return p < 0.15 ? 'lt15' : p < 0.25 ? '15to25' : p < 0.35 ? '25to35' : p < 0.5 ? '35to50' : '50plus'; }

// Week context shared by every game: league rates, matchup tables, team totals (all before cutoff).
export function weekContext(ix, identity, { season, week, weights, lessons = null, now = Date.now(), errorModel = null, coverage = null, pubTdBlend, stackFit, budgetFit, volCal, exp = null, caps, trendWeights, trendHistory = null }) {
  // endzone-4.2: shipped walk-forward fits (trained only on games before this week) unless the caller overrides; pass false to disable.
  const shipped = fitFor(season, week);
  if (budgetFit === undefined) budgetFit = shipped?.budget ? { ...shipped.budget, id: shipped.id } : null;
  if (caps === undefined) caps = shipped?.caps ? { ...shipped.caps, id: shipped.id } : null;
  if (volCal === undefined) volCal = shipped?.volcal ? { ...shipped.volcal, id: shipped.id } : null;
  const rows = allLogsBefore(ix, season, week);
  const zonesAll = season === ix.season ? [...ix.teamZones.values()].flat().filter(z => z.week < week) : [];
  const league = leagueRates(zonesAll, { k: exp?.lgK });
  const T = buildMatchupTables(rows, zonesAll);
  const teamTotals = teamGameTotals(rows);
  const byTeam = new Map();
  for (const p of identity.players) { if (!byTeam.has(p.team)) byTeam.set(p.team, []); byTeam.get(p.team).push(p); }
  // league rz per team-game & defensive rz allowed
  const teamRz = new Map(), defRz = new Map(); let lgRz = 0, lgN = 0;
  const zGames = new Map();
  for (const z of zonesAll) { if (z.bin === 0 || z.path === 'p') continue; const k = `${z.team}|${z.gameId}`; const g = zGames.get(k) || { team: z.team, opp: z.opp, r: 0, t: 0 }; g[z.path] += z.looks; zGames.set(k, g); }
  for (const g of zGames.values()) {
    const a = teamRz.get(g.team) || { rzRush: 0, rzTgt: 0, n: 0 }; a.rzRush += g.r; a.rzTgt += g.t; a.n++; teamRz.set(g.team, a);
    const d = defRz.get(g.opp) || { plays: 0, n: 0 }; d.plays += g.r + g.t; d.n++; defRz.set(g.opp, d); lgRz += g.r + g.t; lgN++;
  }
  for (const a of teamRz.values()) { a.rzRush /= a.n; a.rzTgt /= a.n; }
  const lgRzPg = lgN ? lgRz / lgN : null;
  const qbRows = rows.filter(r => r.pos === 'QB' && r.att > 0); const lgYpa = sum(qbRows, r => r.passYd) / Math.max(1, sum(qbRows, r => r.att)) || 6.6;
  return { ix, identity, season, week, weights: sanitizeWeights(weights), lessons, now, league, T, teamTotals, byTeam, teamRz, defRz, lgRzPg, lgYpa, rows, errorModel, coverage, pubTdBlend: pubTdBlend ?? PUB_TD_BLEND, stackFit: stackFit || null, budgetFit: budgetFit || null, volCal: volCal || null, exp: exp || {}, caps: caps || null, capsEff: sanitizeCaps(caps), trendWeights: trendWeights || (shipped?.trendWeights ? { ...shippedTrendWeights(), ...shipped.trendWeights } : shippedTrendWeights()), trendHistory: trendHistory || [], defTrendCache: new Map() };
}

function sideContext(W, game, side) {
  const L = lines(game); const team = game[side], opp = side === 'away' ? game.home : game.away;
  const spread = side === 'away' ? L.awaySpread : L.homeSpread;
  const implied = side === 'away' ? L.awayImplied : L.homeImplied;
  const d = W.defRz.get(opp); const defRzRatio = d && W.lgRzPg ? clamp(((d.plays / d.n / W.lgRzPg) * d.n + 3) / (d.n + 3), 0.8, 1.25) : 1;
  return { team, opp, side, spread, implied, lines: L, weather: weather(game), teamRz: W.teamRz.get(team) || null, defRz: 1 + W.weights.defenseTrust * (defRzRatio - 1) };
}

// Compute one team's players. override: scenario adjustments {rush, pass, glBoost, spread, limit:{id,factor}}.
export function computeSide(W, game, side, { override = null, historical = false } = {}) {
  const w = W.weights; const sc = sideContext(W, game, side);
  sc.budgetFit = W.budgetFit || null;
  if (override?.spread != null) sc.spread = override.spread;
  sc.override = override;
  const members = (W.byTeam.get(sc.team) || []).map(p0 => {
    const p = { ...p0 };
    p.avail = availability(p, { historical });
    if (override?.limit && override.limit.id === p.id) p.avail = { ...p.avail, status: 'limited', factor: override.limit.factor, label: 'Scenario: limited availability', uncertain: true };
    p.f = playerFeatures(W.ix, p, W.season, W.week, W.teamTotals);
    return p;
  });
  // role ranks within position by recent usage then depth order
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'FB']) {
    const g = members.filter(p => p.pos === pos).sort((a, b) => (usageScore(b, b.f) - usageScore(a, a.f)) || ((a.depth ?? 99) - (b.depth ?? 99)));
    g.forEach((p, i) => { p.roleRank = i + 1; p.role = `${pos}${i + 1}`; });
  }
  const proj = W.ix.weekly[W.week]?.proj || {};
  for (const p of members) {
    const pr = depthPrior(p.pos, p.roleRank);
    const v = playerVolume(p, p.f, pr, w, proj[p.id]);
    p.vol = v.vol; p.volDetail = v.detail; p.roleFactor = v.roleFactor; p.proj = proj[p.id] || null;
  }
  const transfers = transferWork(members);
  const active = members.filter(p => !p.avail.excluded);
  const teamGames = [...W.teamTotals.values()].filter(t => t.team === sc.team);
  const budget = teamBudget(teamGames, sc, w);
  const fits = fitToBudget(active, budget);
  // ---- spot shares
  const L = W.league;
  const tz = teamZoneRows(W.ix, sc.team, W.season, W.week);
  const teamBin = {}, teamBinRecent = {};
  for (const path of PATHS) for (const b of BINS) {
    teamBin[`${path}${b}`] = sum(tz.filter(z => z.path === path && z.bin === b), z => z.looks);
    teamBinRecent[`${path}${b}`] = sum(tz.filter(z => z.path === path && z.bin === b && z.week >= W.week - 3), z => z.looks);
  }
  const binMix = {};
  for (const path of PATHS) { const tot = sum(BINS, b => teamBin[`${path}${b}`]); for (const b of BINS) binMix[`${path}${b}`] = (teamBin[`${path}${b}`] + 20 * L.binMix[path][b]) / (tot + 20); }
  // ---- trends agent: detect (pre-week data only) and convert to bounded multipliers
  if (!W.defTrendCache.has(sc.opp)) W.defTrendCache.set(sc.opp, defenseTrendsWithStatus(W.rows, sc.opp, W.week));
  const defT = W.defTrendCache.get(sc.opp); const sideTrends = [...teamTrendsWithStatus([...W.teamTotals.values()], sc.team, W.week)];
  for (const p of active) {
    p.trends = playerTrendsWithStatus(p, { history: W.trendHistory, week: W.week });
    const dT = defT.filter(t => t.status !== 'faded' && t.entity.pos === (p.pos === 'FB' ? 'RB' : p.pos));
    p.tm = trendMultipliers([...p.trends, ...dT], W.trendWeights); p.defTrends = dT;
    sideTrends.push(...p.trends);
  }
  for (const t of defT) sideTrends.push({ ...t, affects: active.filter(p => (p.pos === 'FB' ? 'RB' : p.pos) === t.entity.pos).map(p => p.id) });
  const rzVolKey = { r: 'rzRush', t: 'rzTgt' };
  for (const path of PATHS) {
    const totVolRz = sum(active, p => p.vol[rzVolKey[path]]) || 1;
    for (const b of BINS) {
      const key = `${path}${b}`; const tS = teamBin[key], tR = teamBinRecent[key];
      for (const p of active) {
        const zs = p.f.zSeason[key], zr = p.f.zRecent[key];
        const sShare = tS ? zs.looks / tS : 0; const rShare = tR ? zr.looks / tR : sShare;
        const rk = path === 'r' && b <= 2 && W.exp.glRecK != null ? W.exp.glRecK : 6; // experiment: goal-line recency
        const dataShare = tS ? (tR * rShare + rk * sShare) / (tR + rk) : 0;
        const wData = tS / (tS + 8);
        let prior = p.vol[rzVolKey[path]] / totVolRz;
        // experiments (off by default): snap-informed goal-line prior, QB rushing paths, TE red-zone target prior
        if (W.exp.glSnap && path === 'r' && b <= 2 && p.pos !== 'WR' && p.pos !== 'TE' && p.f.snapShare != null) prior *= Math.pow(Math.max(0.05, p.f.snapShare) / 0.6, W.exp.glSnap);
        if (W.exp.qbRush && path === 'r' && p.pos === 'QB') prior *= W.exp.qbRush;
        if (W.exp.teRz && path === 't' && p.pos === 'TE') prior *= W.exp.teRz;
        const avail = p.avail.factor * (p.roleFactor || 1);
        p.share = p.share || {}; p.shareData = p.shareData || {};
        p.shareData[key] = { season: sShare, recent: rShare, data: dataShare, wData, prior, teamSeason: tS, teamRecent: tR, playerSeason: zs.looks, playerRecent: zr.looks };
        p.share[key] = (wData * dataShare + (1 - wData) * prior) * avail * componentMult(p.tm.m, path, b);
        if (W.exp.qbRushData && path === 'r' && p.pos === 'QB') p.share[key] *= W.exp.qbRushData;
      }
      // include unavailable players' observed shares for transfer
      for (const p of members.filter(m => m.avail.excluded || m.avail.factor < 1)) {
        if (!p.transfer) continue;
        const zr = p.f.zRecent[key];
        // only recent (last three weeks) observed share is vacated
        const observed = tR ? (zr.looks / tR) * (tR / (tR + 6)) : 0;
        const moved = observed * p.transfer.fraction;
        if (moved <= 0) continue;
        const recipId = path === 'r' && b <= 2 ? p.transfer.glTo : p.transfer.to;
        const rec = active.find(a => a.id === recipId);
        if (rec) { rec.share[key] += moved; rec.inheritedShare = (rec.inheritedShare || 0) + moved; }
      }
      // goal-line concentration on the owner of inside-5 rushes
      if (path === 'r' && b === 1) {
        const before = sum(active, p => p.share[key]);
        const owner = active.filter(p => p.pos !== 'WR' && p.pos !== 'TE').sort((a, c) => c.share[key] - a.share[key])[0];
        if (owner && before > 0) {
          let mult = w.goalLine; if (budget.scriptFav) mult *= 1 + 0.1 * w.script; if (override?.glBoost) mult *= 1 + override.glBoost;
          owner.share[key] *= mult; const after = sum(active, p => p.share[key]);
          if (after > 0) for (const p of active) p.share[key] *= before / after;
          owner.glOwner = true;
        }
      }
      let tot = sum(active, p => p.share[key]);
      if (tot > 1) for (const p of active) p.share[key] /= tot;
      else if (tot > 0 && tot < 0.97) { const f = Math.min(1.5, 0.97 / tot); for (const p of active) p.share[key] *= f; }
    }
  }
  // ---- components per player
  const sideTeamBudgetBins = {};
  for (const path of PATHS) for (const b of BINS) sideTeamBudgetBins[`${path}${b}`] = budget[rzVolKey[path]] * binMix[`${path}${b}`];
  for (const p of active) {
    const comp = {}; const spots = {}; let i10Exp = 0;
    const m = positionMatchup(W.T, sc.opp, sc.team, p.pos, { trust: w.defenseTrust });
    p.matchup = m;
    const recentRzLooks = sum(['r1', 'r2', 'r3', 't1', 't2', 't3'], k => p.f.zRecent[k].looks) || sum(p.f.last3, g => (g.rzRush || 0) + (g.rzTgt || 0));
    p.recentRzLooks = recentRzLooks; p.recentRzTgt = sum(['t1', 't2', 't3'], k => p.f.zRecent[k].looks) || sum(p.f.last3, g => g.rzTgt || 0);
    const realScoringOpp = recentRzLooks >= 2;
    let mf = m ? m.factor : 1; const liftBlocked = mf > 1 && !realScoringOpp;
    if (liftBlocked) mf = 1;
    mf *= p.tm.m.def; let noTrendLam = 0;
    const hotGames = new Set([...p.f.zSeason.r1.scoreGames, ...p.f.zSeason.r2.scoreGames, ...p.f.zSeason.t1.scoreGames, ...p.f.zSeason.t2.scoreGames]);
    const hot = hotGames.size >= 2 && !p.f.spike;
    let coldGoal = false;
    for (const path of PATHS) {
      for (const b of BINS) {
        const key = `${path}${b}`; const zs = p.f.zSeason[key], zr = p.f.zRecent[key];
        const q = qualityFactor(path, b, zs, L, W.ix.prep.charting);
        const sr = spotRate(path, b, { kMult: W.exp.spotK, looks: zs.looks, scores: zs.scores, recentLooks: zr.looks, recentScores: zr.scores, hot, spike: p.f.spike, quality: q.factor }, L);
        if (sr.cold) coldGoal = true;
        let rate = sr.rate * (path === 't' && p.pos === 'TE' ? w.tePremium : 1) * p.tm.m.spot;
        const spotScale = W.lessons?.spot?.[key] ?? 1;
        const opps = sideTeamBudgetBins[key] * p.share[key];
        let dsf = defenseSpotFactor(W.T.dz, W.T.lz, sc.opp, path, b);
        if (dsf.factor > 1 && !realScoringOpp) dsf = { ...dsf, factor: 1, blocked: true };
        const exp = opps * rate * mf * dsf.factor * spotScale;
        comp[key] = exp; if (b <= 2) i10Exp += exp; noTrendLam += exp / (componentMult(p.tm.m, path, b) * p.tm.m.spot * p.tm.m.def);
        spots[key] = { opps, rate, rawRate: sr.rate, posterior: sr.posterior, prior: sr.prior, k: sr.k, cold: sr.cold, notes: sr.notes, quality: q, looks: zs.looks, scores: zs.scores, recentLooks: zr.looks, recentScores: zr.scores, expected: exp, lessonScale: spotScale, defenseSpot: dsf };
      }
      const rzOpps = sum(BINS, b => spots[`${path}${b}`].opps);
      const totalOpp = path === 'r' ? p.vol.carries : p.vol.targets;
      const outOpps = Math.max(0, totalOpp - rzOpps);
      const zo = p.f.zSeason[`${path}0`];
      const orr = outsideRate(path, zo.looks, p.f.spike ? zo.scores * 0.72 : zo.scores, zo.scoreGames.size, L);
      comp[`${path}0`] = outOpps * orr.rate * mf * p.tm.m.share * (path === 'r' ? p.tm.m.rshare : 1); noTrendLam += comp[`${path}0`] / (p.tm.m.share * (path === 'r' ? p.tm.m.rshare : 1) * p.tm.m.def);
      spots[`${path}0`] = { opps: outOpps, rate: orr.rate, looks: zo.looks, scores: zo.scores, recurring: orr.recurring, expected: comp[`${path}0`] };
    }
    if (p.pos === 'QB') { /* passing TDs never enter the QB's own anytime intensity */ }
    { const withT = sumComponents(comp); const before = anytimeFromLambda(noTrendLam), after = anytimeFromLambda(withT); const tot = p.tm.applied.reduce((a, x) => a + x.logm, 0);
      p.trendEffect = p.tm.applied.length ? { before, after, note: 'before safety caps and the team TD budget', items: p.tm.applied.map(x => ({ ...x, weight: W.trendWeights[x.family] || 0, pp: tot ? (after - before) * x.logm / tot : 0 })) } : null; }
    p.spots = spots; p.coldGoal = coldGoal; p.i10Exp = i10Exp; p.liftBlocked = liftBlocked; p.matchupFactor = mf;
    p.glShare = p.share.r1 || 0;
    const rawLambda = sumComponents(comp);
    const noLiftLambda = mf > 1 ? rawLambda / mf : rawLambda;
    // learned chance-band scale (not applied to inside-10 finishers in 35-50%)
    const i10Season = sum(['r1', 'r2', 't1', 't2'], k => p.f.zSeason[k].looks), i10Recent = sum(['r1', 'r2', 't1', 't2'], k => p.f.zRecent[k].looks);
    const i10RecentScores = sum(['r1', 'r2', 't1', 't2'], k => p.f.zRecent[k].scores);
    const teamI10 = sum(['r1', 'r2', 't1', 't2'], k => teamBin[k]);
    const recentFinisher = i10Season > 0 && i10Recent / i10Season >= 0.45 && i10RecentScores >= 2 && i10Recent > 0 && i10RecentScores / i10Recent >= 0.4;
    const insideFinisher = recentFinisher || (i10Season >= 4 && teamI10 > 0 && i10Season / teamI10 >= 0.2);
    let lam = rawLambda; const lessonNotes = [];
    const band0 = chanceBandKey(anytimeFromLambda(lam));
    const bscale = W.lessons?.band?.[band0];
    if (bscale && bscale !== 1 && !(band0 === '35to50' && insideFinisher)) { lam *= bscale; lessonNotes.push(`Learned from finished games: ${band0} chances scaled ×${bscale.toFixed(2)} (from the last three weeks).`); }
    const pubExpTd = p.proj && (p.proj.rush_td != null || p.proj.rec_td != null) ? Math.max(0, (p.proj.rush_td || 0) + (p.proj.rec_td || 0)) : null;
    p.pubBlend = null; p.preStack = anytimeFromLambda(lam); p.stacked = null;
    if (W.stackFit) {
      const pre = anytimeFromLambda(lam);
      const q = stackPredict(W.stackFit, stackX({ pre, pub: pubExpTd != null ? 1 - Math.exp(-pubExpTd) : null, pos: p.pos, glShare: p.share?.r1 || 0, insideFinisher, games: p.f.n || 0, spread: sc.spread, implied: sc.implied }));
      p.stacked = { before: pre, after: q, fit: W.stackFit.id || null };
      lam = lambdaFromChance(Math.min(0.97, q));
      lessonNotes.push(`Calibrated with published projection and role features (walk-forward fit ${W.stackFit.id || ''}): ${(pre * 100).toFixed(0)}% → ${(q * 100).toFixed(0)}% before safety caps.`);
    } else if (pubExpTd != null) {
      const a = pubBlendWeight(W.pubTdBlend, { games: p.f.n || 0, recentRzLooks, unverified: !p.verified });
      if (a > 0) { const before = lam; lam = (1 - a) * lam + a * pubExpTd; p.pubBlend = { weight: a, published: pubExpTd, before }; lessonNotes.push(`Blended ${(a * 100).toFixed(0)}% toward the published projection (${(1 - Math.exp(-pubExpTd)) * 100 | 0}%) because of ${p.f.n < 4 ? 'a thin sample' : 'limited recent red-zone evidence'}; safety caps applied after.`); }
    }
    const preSafety = anytimeFromLambda(lam);
    const safe = W.exp.noCaps ? { chance: Math.min(preSafety, 0.97), notes: [], ceiling: null } : safetyCalibrate(preSafety, { insideFinisher, recentFinisher, coldGoal }, W.caps); // noCaps: harness counterfactual only
    p.preSafety = preSafety;
    let chance = safe.chance; const softNotes = [];
    if (mf > 1 && i10Exp < 0.15) { const capC = Math.max(anytimeFromLambda(noLiftLambda * (lam / rawLambda || 1)), 0.32); if (chance > capC) { chance = capC; softNotes.push('Soft-position lift capped near 32% without credible inside-10 scores.'); } }
    const lamFinal = lambdaFromChance(chance);
    p.components = rawLambda > 0 ? scaleComponents(comp, lamFinal / rawLambda) : comp;
    p.lambdaRaw = rawLambda; p.safetyNotes = [...safe.notes, ...softNotes]; p.lessonNotes = lessonNotes; p.ceiling = safe.ceiling;
    p.insideFinisher = insideFinisher; p.recentFinisher = recentFinisher; p.i10Season = i10Season; p.i10Recent = i10Recent;
    p.lambda = sumComponents(p.components);
  }
  // second genuine red-zone option floor (pre-budget)
  const rzRank = active.filter(p => p.pos !== 'QB').map(p => ({ p, looks: p.recentRzLooks, games: p.f.last3.filter(g => (g.rzRush || 0) + (g.rzTgt || 0) > 0).length })).sort((a, b) => b.looks - a.looks);
  if (rzRank.length >= 2) {
    const s = rzRank[1];
    if (s.looks >= 3 && s.games >= 2 && anytimeFromLambda(s.p.lambda) < W.capsEff.floor && s.p.avail.factor >= 1) {
      const target = lambdaFromChance(W.capsEff.floor); const f = s.p.lambda > 0 ? target / s.p.lambda : 0;
      if (f > 0) { s.p.components = scaleComponents(s.p.components, f); s.p.lambda = target; s.p.secondOption = `Second genuine red-zone option (${s.looks} red-zone looks in ${s.games} of his last three games): floor ${Math.round(W.capsEff.floor * 100)}% before the team limit.`; }
    }
  }
  // team scoring budget: cap the sum of intensities, scaling coherently
  const raw = sum(active, p => p.lambda);
  let budgetFactor = 1; const teamNotes = [...budget.notes];
  if (raw > budget.tdBudget && raw > 0) { budgetFactor = budget.tdBudget / raw; for (const p of active) { p.components = scaleComponents(p.components, budgetFactor); p.lambda *= budgetFactor; } teamNotes.push(`The offense only has so many scores: player intensities summed to ${raw.toFixed(2)}, above the ${budget.tdBudget.toFixed(2)} budget, so each was scaled by ${budgetFactor.toFixed(2)}.`); }
  // passing TDs: the other side of the finalized receiving scores
  const teamRec = sum(active, p => sum(['t0', 't1', 't2', 't3'], k => p.components[k] || 0));
  allocatePassingTd(active.filter(p => p.pos === 'QB'), teamRec);
  for (const p of active) { p.chance = anytimeFromLambda(p.lambda); }
  return { sc, members, active, budget, fits, transfers, teamBin, binMix, raw, budgetFactor, teamNotes, teamRec, teamLambda: sum(active, p => p.lambda), trends: sideTrends };
}

// Volume forecasts with league-average-defense version and ranges.
function volumeForecasts(W, p, side) {
  const out = {}; const f = p.f; const lg = W.T.league[p.pos === 'FB' ? 'RB' : p.pos] || W.T.league.RB;
  const tot = k => sum(f.games, g => g[k] || 0);
  const vs = W.lessons?.vol || {};
  const cvDefault = { rushYd: 0.6, rec: 0.55, recYd: 0.75, passYd: 0.32 };
  const cvObs = (arr) => { if (arr.length < 3) return null; const m = arr.reduce((a, b) => a + b, 0) / arr.length; if (m <= 0) return null; return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1)) / m; };
  const seg = p.segment;
  const range = (metric, mean, prodArr) => {
    const em = W.errorModel?.[metric]?.[seg];
    let sd;
    if (em && em.n >= 30) sd = Math.max(em.sd, 1) * (mean > 0 ? Math.sqrt(mean / Math.max(1, em.meanPred)) : 0);
    else {
      const c = cvObs(prodArr); const n = prodArr.length; const cvS = c == null ? cvDefault[metric] : (n * c + 4 * cvDefault[metric]) / (n + 4);
      // count-like floor so small projections keep zero inside the range
      sd = Math.max(mean * cvS, Math.sqrt(mean * FLOOR_K[metric]));
    }
    return { lo: Math.max(0, mean - 1.2816 * sd), hi: mean + 1.2816 * sd, sd, source: em && em.n >= 30 ? `held-out errors, ${seg} (n=${em.n})` : 'player variability shrunk to position defaults (provisional)' };
  };
  const oppName = p.matchup?.defense || '';
  // rush yards
  { const c = tot('carries'), y = tot('rushYd'); const lgY = lg.carries ? lg.rushYd / lg.carries : 4.3; const ypc = (y + 40 * lgY) / (c + 40);
    const ef = efficiencyFactor(p.matchup, 'ypc', 60, { trust: W.weights.defenseTrust }); const sc = vs.rushYd ?? 1;
    const base = p.vol.carries * ypc * sc, mean = base * ef.factor;
    out.rushYd = { mean, leagueDefense: base, ypc, ...range('rushYd', mean, f.last5.map(g => g.rushYd)), defense: ef,
      text: ef.allowed != null ? `${base.toFixed(0)} without this defense. ${oppName} allows ${p.pos}s ${ef.allowed.toFixed(1)} yards a carry versus ${ef.league.toFixed(1)} league.` : `${base.toFixed(0)} without this defense; no positional defense sample.` }; }
  { const t = tot('targets'), r = tot('rec'); const lgC = lg.targets ? lg.rec / lg.targets : 0.65; const cr = (r + 25 * lgC) / (t + 25);
    const ef = efficiencyFactor(p.matchup, 'catchRate', 80, { trust: W.weights.defenseTrust }); const sc = vs.rec ?? 1;
    const base = p.vol.targets * cr * sc, mean = base * ef.factor;
    out.rec = { mean, leagueDefense: base, catchRate: cr, ...range('rec', mean, f.last5.map(g => g.rec)), defense: ef,
      text: ef.allowed != null ? `${base.toFixed(1)} without this defense. ${oppName} allows ${p.pos}s a ${(ef.allowed * 100).toFixed(0)}% catch rate versus ${(ef.league * 100).toFixed(0)}% league.` : `${base.toFixed(1)} without this defense.` }; }
  { const t = tot('targets'), y = tot('recYd'); const lgT = lg.targets ? lg.recYd / lg.targets : 7.2; const ypt = (y + 30 * lgT) / (t + 30);
    const ef = efficiencyFactor(p.matchup, 'ypt', 80, { trust: W.weights.defenseTrust }); const sc = vs.recYd ?? 1;
    const base = p.vol.targets * ypt * sc, mean = base * ef.factor;
    out.recYd = { mean, leagueDefense: base, ypt, ...range('recYd', mean, f.last5.map(g => g.recYd)), defense: ef,
      text: ef.allowed != null ? `${base.toFixed(0)} without this defense. ${oppName} allows ${p.pos}s ${ef.allowed.toFixed(1)} yards a target versus ${ef.league.toFixed(1)} league.` : `${base.toFixed(0)} without this defense.` }; }
  if (p.pos === 'QB') {
    const a = tot('att'), y = tot('passYd'); const ypa = (y + 80 * W.lgYpa) / (a + 80);
    // opponent factor blended by this offense's use of WR/TE/RB targets
    const O = W.T.off.get(p.team); let wsum = 0, fsum = 0; const parts = [];
    for (const pos of ['WR', 'TE', 'RB']) { const t = O?.[pos]?.targets || 0; const m = positionMatchup(W.T, p.matchup?.defense, p.team, pos, { trust: W.weights.defenseTrust }); const ef = efficiencyFactor(m, 'ypt', 80, { trust: W.weights.defenseTrust }); wsum += t; fsum += t * ef.factor; parts.push({ pos, targets: t, factor: ef.factor }); }
    const of = wsum ? fsum / wsum : 1; const sc = vs.passYd ?? 1;
    const base = p.vol.att * ypa * sc * (p.passEff || 1), mean = base * of;
    out.passYd = { mean, leagueDefense: base, ypa, ...range('passYd', mean, f.last5.map(g => g.passYd)), defense: { factor: of, parts, allowed: null, league: null },
      text: `${base.toFixed(0)} without this defense; opponent factor ${of.toFixed(2)} from how this offense uses WRs, TEs, and backs.` };
  }
  return out;
}
const FLOOR_K = { rushYd: 14, rec: 1.2, recYd: 16, passYd: 70 };
const segmentOf = p => `${p.pos === 'FB' ? 'RB' : p.pos}|${p.roleRank === 1 ? 'primary' : p.roleRank === 2 ? 'support' : 'reserve'}|${p.avail.uncertain ? 'uncertain' : 'available'}`;

function sigmaLog(p) {
  // conversion uncertainty from Beta posteriors + opportunity volatility
  let v = 0; const lam = Math.max(1e-6, p.lambdaRaw || p.lambda);
  for (const [k, s] of Object.entries(p.spots)) {
    if (!s.posterior) continue; const share = (s.expected || 0) / lam; const rel = s.posterior.mean > 0 ? s.posterior.sd / s.posterior.mean : 0; v += (share * rel) ** 2;
  }
  const tc = p.f.last5.map(g => g.carries + g.targets + (p.pos === 'QB' ? 0 : 0));
  let oppCv = 0.5; if (tc.length >= 2) { const m = tc.reduce((a, b) => a + b, 0) / tc.length; if (m > 0) oppCv = Math.sqrt(tc.reduce((a, b) => a + (b - m) ** 2, 0) / (tc.length - 1)) / m; }
  const n = Math.max(1, p.f.n);
  v += (oppCv ** 2) / n + 0.35 / (n + 1); // thin samples widen the band
  if (p.avail.uncertain) v += 0.04;
  return Math.sqrt(v + 0.01);
}

export function forecastGame(W, game, { historical = false } = {}) {
  const base = { away: computeSide(W, game, 'away', { historical }), home: computeSide(W, game, 'home', { historical }) };
  const gameLambda = base.away.teamLambda + base.home.teamLambda;
  const started = new Date(game.kickoff).getTime() <= W.now;
  const out = { gameId: game.id, game, gameLambda, started, historical, sides: {} };
  for (const side of ['away', 'home']) {
    const S = base[side];
    // scenarios: refit caps & budget under each script
    const scen = {
      close: computeSide(W, game, side, { historical, override: { spread: 0 } }),
      lead: computeSide(W, game, side, { historical, override: { rush: 1 + 0.12 * W.weights.script, pass: 1 - 0.12 * W.weights.script, glBoost: 0.15 * W.weights.script } }),
      behind: computeSide(W, game, side, { historical, override: { rush: 1 - 0.15 * W.weights.script, pass: 1 + 0.12 * W.weights.script } }),
    };
    const star = S.active.filter(p => p.avail.uncertain && p.avail.factor > 0).sort((a, b) => b.lambda - a.lambda)[0];
    if (star) scen.limited = computeSide(W, game, side, { historical, override: { limit: { id: star.id, factor: 0.5 } } });
    const players = [];
    for (const p of S.active) {
      p.segment = segmentOf(p);
      const sv = {};
      for (const [k, R] of Object.entries(scen)) { const q = R.active.find(x => x.id === p.id); if (q) sv[k] = { chance: q.chance, carries: q.vol.carries, targets: q.vol.targets, att: q.vol.att }; }
      const sc = ['close', 'lead', 'behind'].map(k => sv[k]?.chance).filter(x => x != null);
      p.scenarios = sv; p.scenarioSpread = sc.length ? Math.max(...sc) - Math.min(...sc) : 0; p.scriptSensitive = p.scenarioSpread > 0.10;
      p.dist = distribution(p.lambda);
      p.firstTd = firstTd(p.lambda, gameLambda);
      p.sigma = sigmaLog(p); p.band = chanceBand(p.lambda, p.sigma);
      const pubExp = p.proj ? (p.proj.rush_td || 0) + (p.proj.rec_td || 0) : null;
      p.published = p.proj && (p.proj.rush_td != null || p.proj.rec_td != null) ? { expected: pubExp, probability: publishedProbability(pubExp), source: `Sleeper projections week ${W.week}` } : null;
      p.edge = edgePts(p.chance, p.published?.probability ?? null);
      p.fair = americanFair(p.chance);
      p.passEff = S.budget.passEff;
      p.volume = volumeForecasts(W, p, side);
      // held-out band recalibration applies to the default-variability path only (the in-app error model is already held-out)
      if (W.volCal) for (const [m, v] of Object.entries(p.volume)) if (v && v.mean != null && !/^held-out/.test(v.source || '')) { const c = applyVolCal(W.volCal, m, v); if (c !== v) p.volume[m] = { ...v, ...c, rawMean: v.mean, source: `${v.source}; recalibrated on held-out 2024–26 errors (fit ${W.volCal.id})` }; }
      p.tdConf = tdConfidence(p);
      p.volConf = {};
      for (const m of ['rushYd', 'rec', 'recYd'].concat(p.pos === 'QB' ? ['passYd'] : [])) p.volConf[m] = volumeConfidence(m, p, p.volume[m], { coverage: W.coverage?.[m]?.[p.segment] ?? W.coverage?.[m]?.overall ?? null });
      p.started = started;
      players.push(p);
    }
    // risers: non-usage-star with rising touches and real evidence
    const starIds = new Set(S.active.slice().sort((a, b) => usageScore(b, b.f) - usageScore(a, a.f)).slice(0, 2).map(p => p.id));
    for (const p of players) {
      if (starIds.has(p.id) || p.pos === 'QB') continue;
      const rising = p.f.trend.direction === 'rising' || p.replacing;
      const ev = [];
      if (p.matchup?.soft && p.matchup.supportive) ev.push(`${p.matchup.defense} is soft to ${p.matchup.pos}s`);
      if (p.recentRzLooks >= 2) ev.push(`${p.recentRzLooks} red-zone looks in the last three weeks`);
      const lastG = p.f.games[p.f.games.length - 1]; if (lastG?.td > 0) ev.push(`scored in week ${lastG.week}`);
      if (p.replacing) ev.push(`next man up for ${p.replacing.name}`);
      const convT = p.spots.t1.scores + p.spots.t2.scores + p.spots.t3.scores; if (convT >= 2) ev.push(`${convT} red-zone targets converted`);
      if (rising && (ev.length >= 2 || (p.replacing && p.recentRzLooks >= 2)) && p.chance >= 0.12) p.riser = { reason: `Rising, not the star: touch share ${(p.f.trend.earlyShare * 100).toFixed(0)}% → ${(p.f.trend.lateShare * 100).toFixed(0)}%; ${ev.join('; ')}.`, trend: p.f.trend };
    }
    // role tags
    for (const p of players) {
      p.tags = [];
      if (p.glOwner && p.glShare >= 0.3) p.tags.push('Goal-line role');
      if (p.f.trend.direction === 'rising') p.tags.push('Rising role');
      if (p.replacing) p.tags.push('Next man up');
      if (p.f.scoringLast5 >= 2) p.tags.push('Recurring scorer');
      if (p.scriptSensitive) p.tags.push('Script sensitive');
      if (p.avail.uncertain) p.tags.push('Availability risk');
      p.conversionNote = convNote(p);
    }
    const call = chooseTeamCall(players, { spread: S.sc.spread });
    out.sides[side] = { trends: S.trends, team: S.sc.team, opp: S.sc.opp, spread: S.sc.spread, implied: S.sc.implied, lines: S.sc.lines, weather: S.sc.weather, budget: S.budget, fits: S.fits, transfers: S.transfers,
      teamLambda: S.teamLambda, tdBudget: S.budget.tdBudget, teamNotes: S.teamNotes, teamRec: S.teamRec, players, excluded: S.members.filter(p => p.avail.excluded).map(p => ({ id: p.id, name: p.name, pos: p.pos, reason: p.avail.label, transfer: p.transfer || null })), call };
  }
  return out;
}
function convNote(p) {
  const parts = [];
  for (const path of PATHS) {
    const looks = sum(BINS, b => p.spots[`${path}${b}`].looks), scores = sum(BINS, b => p.spots[`${path}${b}`].scores);
    if (path === 't' && looks >= 2 && scores >= 1) parts.push(`${scores} of ${looks} red-zone targets converted: those targets are the score.`);
    if (path === 'r' && looks >= 3) parts.push(`${scores} of ${looks} red-zone carries scored.`);
  }
  return parts.join(' ');
}

// Compact, serializable prediction used for display and archive snapshots.
export function compactPrediction(p, side) {
  const r = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);
  return {
    id: p.id, gsis: p.gsis || null, espn: p.espn || null, name: p.name, pos: p.pos, team: p.team, role: p.role, photo: p.photo, injury: p.injury || null, practice: p.practice || null,
    avail: p.avail, verified: p.verified, verifyReason: p.verifyReason,
    trendTags: (p.trends || []).concat(p.defTrends || []).filter(t => t.status !== 'faded').map(t => ({ id: t.id, family: t.family, type: t.type, direction: t.direction, strength: t.strength, status: t.status, firstDetectedWeek: t.firstDetectedWeek })),
    trendEffect: p.trendEffect ? { before: r(p.trendEffect.before), after: r(p.trendEffect.after), note: p.trendEffect.note, items: p.trendEffect.items.map(x => ({ id: x.id, family: x.family, weight: x.weight, mult: r(x.mult), pp: r(x.pp), text: [...(p.trends || []), ...(p.defTrends || [])].find(t => t.id === x.id)?.text || '' })) } : null,
    chance: r(p.chance), lambda: r(p.lambda), dist: Object.fromEntries(Object.entries(p.dist).map(([k, v]) => [k, r(v)])), firstTd: r(p.firstTd), band: p.band.map(r),
    components: Object.fromEntries(Object.entries(p.components).map(([k, v]) => [k, r(v)])), published: p.published, edge: r(p.edge), fair: p.fair,
    tdConf: p.tdConf, volConf: p.volConf, volume: Object.fromEntries(Object.entries(p.volume).map(([k, v]) => [k, { mean: r(v.mean), lo: r(v.lo), hi: r(v.hi), leagueDefense: r(v.leagueDefense), text: v.text, source: v.source, defense: v.defense ? { allowed: r(v.defense.allowed), league: r(v.defense.league), factor: r(v.defense.factor) } : null }])),
    passTd: p.pos === 'QB' && p.passTd ? { expected: r(p.passTd.expected), display: p.passTd.display, interval: p.passTd.interval, level: p.passTd.level, provisional: true, reasons: p.passTd.reasons, attemptShare: r(p.passTd.attemptShare), teamReceivingLambda: r(p.passTd.teamReceivingLambda) } : null,
    vol: Object.fromEntries(Object.entries(p.vol).map(([k, v]) => [k, r(v)])), tags: p.tags, riser: p.riser || null, replacing: p.replacing || null, secondOption: p.secondOption || null,
    glShare: r(p.glShare), insideFinisher: p.insideFinisher, recentFinisher: p.recentFinisher, coldGoal: p.coldGoal, scriptSensitive: p.scriptSensitive,
    scenarios: p.scenarios, safetyNotes: p.safetyNotes, lessonNotes: p.lessonNotes, conversionNote: p.conversionNote, segment: p.segment,
    spots: Object.fromEntries(Object.entries(p.spots).map(([k, s]) => [k, { opps: r(s.opps), rate: r(s.rate), expected: r(s.expected), looks: s.looks, scores: s.scores }])),
    matchupFactor: r(p.matchupFactor), challenger: p.challenger ?? null,
    ceiling: p.ceiling ?? null, preSafety: r(p.preSafety), preStack: r(p.preStack), stacked: p.stacked ? { before: r(p.stacked.before), after: r(p.stacked.after), fit: p.stacked.fit } : null, glShareRaw: r(p.share?.r1 || 0), pubBlend: p.pubBlend ? { weight: r(p.pubBlend.weight), before: r(p.pubBlend.before) } : null, recentRzLooks: p.recentRzLooks ?? null, gamesPlayed: p.f?.n ?? null, i10Exp: r(p.i10Exp), lambdaRaw: r(p.lambdaRaw),
  };
}

// Adaptive published-projection blend for the touchdown intensity (user-approved change).
// Weight toward Sleeper's published rush+rec TD expectation grows with thin samples and weak
// red-zone evidence: a = max * clamp(3/(3+games) + (recent red-zone looks < 2 ? .25 : 0) + (unverified ? .15 : 0), 0, 1).
// Applied before safety calibration, so every safety cap and the team budget still apply afterward.
// PUB_TD_BLEND was chosen on held-out earlier-week folds (scripts/blend-folds.mjs; results in data/blend-folds.json).
export const PUB_TD_BLEND = 1; // chosen by the last fold (trained on weeks 1-4); 3 of 4 folds chose 1
export function pubBlendWeight(max, { games = 0, recentRzLooks = 0, unverified = false } = {}) {
  if (!(max > 0)) return 0;
  return max * clamp(3 / (3 + Math.max(0, games)) + (recentRzLooks < 2 ? 0.25 : 0) + (unverified ? 0.15 : 0), 0, 1);
}
// Full week forecast for the selected week.
export function forecastWeek(ix, identity, opts) {
  const W = weekContext(ix, identity, opts);
  const games = ix.prep.games.filter(g => g.season === opts.season && g.week === opts.week).sort((a, b) => (a.kickoff || '').localeCompare(b.kickoff || ''));
  const out = [];
  for (const g of games) {
    const historical = new Date(g.kickoff).getTime() <= W.now; // started: today's injuries were not known pregame
    // unplayed games may take the damped in-week nudge; started games never see same-week results
    W.lessons = historical ? (opts.lessons || null) : (opts.lessonsUnplayed || opts.lessons || null);
    out.push(forecastGame(W, g, { historical }));
  }
  return { W, games: out, modelVersion: MODEL_VERSION, weights: W.weights };
}
