// Opportunity volume: per-player features, depth priors, shrinkage, published
// projection blend, stable role changes, injury transfers, and team budgets.
import { clamp } from './model.js';
import { playerLogs, zoneRows, played } from './stats-index.js';

export const DEPTH_PRIORS = { // per game; spec values plus labeled extensions for deeper roles
  QB1: { att: 33, carries: 3.4, rzRush: 0.55, targets: 0, rzTgt: 0 },
  QB2: { att: 1.5, carries: 0.3, rzRush: 0.03, targets: 0, rzTgt: 0 },
  RB1: { att: 0, carries: 16, rzRush: 3.1, targets: 3.4, rzTgt: 0.55 },
  RB2: { att: 0, carries: 8, rzRush: 1.15, targets: 1.8, rzTgt: 0.3 },
  RB3: { att: 0, carries: 2, rzRush: 0.25, targets: 0.6, rzTgt: 0.08 },
  WR1: { att: 0, carries: 0.3, rzRush: 0.02, targets: 8.2, rzTgt: 1.2 },
  WR2: { att: 0, carries: 0.2, rzRush: 0.01, targets: 6.3, rzTgt: 0.85 },
  WR3: { att: 0, carries: 0.1, rzRush: 0.01, targets: 4.6, rzTgt: 0.55 },
  WR4: { att: 0, carries: 0, rzRush: 0, targets: 1.5, rzTgt: 0.15 },
  TE1: { att: 0, carries: 0, rzRush: 0, targets: 5.4, rzTgt: 1.15 },
  TE2: { att: 0, carries: 0, rzRush: 0, targets: 2.0, rzTgt: 0.4 },
  TE3: { att: 0, carries: 0, rzRush: 0, targets: 0.5, rzTgt: 0.1 },
};
export function depthPrior(pos, rank) {
  if (pos === 'FB') { const b = DEPTH_PRIORS.RB2; return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v * 0.45])); }
  const max = { QB: 2, RB: 3, WR: 4, TE: 3 }[pos] || 1;
  return DEPTH_PRIORS[`${pos}${Math.min(rank, max)}`] || DEPTH_PRIORS[`${pos}${max}`];
}
const METRICS = ['carries', 'targets', 'att', 'rzRush', 'rzTgt'];
const avg = (arr, f) => (arr.length ? arr.reduce((s, x) => s + f(x), 0) / arr.length : 0);
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

// Team per-game totals (for shares) from all logs before cutoff.
export function teamGameTotals(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.team}|${r.gameId}`; let t = m.get(k);
    if (!t) { t = { team: r.team, gameId: r.gameId, week: r.week, carries: 0, targets: 0, att: 0, rushTd: 0, recTd: 0, passYd: 0 }; m.set(k, t); }
    t.carries += r.carries; t.targets += r.targets; t.att += r.att; t.rushTd += r.rushTd; t.recTd += r.recTd; t.passYd += r.passYd;
  }
  return m;
}

export function playerFeatures(ix, player, season, week, teamTotals) {
  const all = playerLogs(ix, player, season, week);
  const cur = all.filter(r => r.season === season);
  const prev = all.filter(r => r.season === season - 1);
  const games = cur.filter(played);
  const z = zoneRows(ix, player, season, week);
  const zoneGames = new Set(z.map(r => r.gameId));
  // per-game red-zone counts: zone feed when the game is covered, else Sleeper rz stats
  for (const g of games) {
    const covered = ix.zoneGameSet.has(g.gameId);
    if (covered) {
      const zr = z.filter(r => r.gameId === g.gameId && r.bin > 0);
      g.rzRush = sum(zr.filter(r => r.path === 'r'), r => r.looks); g.rzTgt = sum(zr.filter(r => r.path === 't'), r => r.looks); g.rzPass = sum(zr.filter(r => r.path === 'p'), r => r.looks);
      g.i10 = sum(zr.filter(r => (r.path === 'r' || r.path === 't') && r.bin <= 2), r => r.looks);
      g.i10Scores = sum(zr.filter(r => (r.path === 'r' || r.path === 't') && r.bin <= 2), r => r.scores);
      g.zoneKnown = true;
    } else if (g.slRzRush != null) { g.rzRush = g.slRzRush; g.rzTgt = g.slRzTgt; g.rzPass = g.slRzPass; g.zoneKnown = false; g.rzKnown = true; }
    else { g.rzRush = null; g.rzTgt = null; g.zoneKnown = false; }
    const tt = teamTotals.get(`${g.team}|${g.gameId}`);
    g.teamCarries = tt?.carries || 0; g.teamTargets = tt?.targets || 0; g.teamAtt = tt?.att || 0;
  }
  const last3 = games.slice(-3), last5 = games.slice(-5);
  const rzKnownGames = games.filter(g => g.rzRush != null);
  const mean = (arr, k) => avg(arr, g => g[k] || 0);
  const seasonAvg = { carries: mean(games, 'carries'), targets: mean(games, 'targets'), att: mean(games, 'att'), rzRush: rzKnownGames.length ? mean(rzKnownGames, 'rzRush') : null, rzTgt: rzKnownGames.length ? mean(rzKnownGames, 'rzTgt') : null };
  const l3rz = last3.filter(g => g.rzRush != null);
  const last3Avg = { carries: mean(last3, 'carries'), targets: mean(last3, 'targets'), att: mean(last3, 'att'), rzRush: l3rz.length ? mean(l3rz, 'rzRush') : null, rzTgt: l3rz.length ? mean(l3rz, 'rzTgt') : null };
  // zone aggregation season / last three weeks
  const zagg = (rows) => {
    const o = {}; for (const p of ['r', 't', 'p']) for (const b of [0, 1, 2, 3]) o[`${p}${b}`] = { looks: 0, scores: 0, sumYl: 0, sumYtg: 0, endzone: 0, catchable: 0, contested: 0, sneaks: 0, charted: 0, games: new Set(), scoreGames: new Set() };
    for (const r of rows) { const a = o[`${r.path}${r.bin}`]; a.looks += r.looks; a.scores += r.scores; a.sumYl += r.sumYl; a.sumYtg += r.sumYtg; a.endzone += r.endzone; a.catchable += r.catchable; a.contested += r.contested; a.sneaks += r.sneaks; a.charted += r.charted; a.games.add(r.gameId); if (r.scores) a.scoreGames.add(r.gameId); }
    return o;
  };
  const zSeason = zagg(z), zRecent = zagg(z.filter(r => r.week >= week - 3));
  // usage share trend in a five-game window (last two vs earlier)
  const shareOf = g => { const den = player.pos === 'QB' ? g.teamAtt : (g.teamCarries + g.teamTargets); const num = player.pos === 'QB' ? g.att : (g.carries + g.targets); return den > 0 ? num / den : 0; };
  const win = last5; const late = win.slice(-2), early = win.slice(0, -2);
  const lateShare = avg(late, shareOf), earlyShare = avg(early, shareOf);
  const stable = late.length >= 2 && early.length >= 2;
  const k = 3; const rawDelta = lateShare - earlyShare; const shrunkDelta = stable ? rawDelta * (late.length / (late.length + k)) * 2 : 0;
  const trend = { lateShare, earlyShare, rawDelta, shrunkDelta, stable, nLate: late.length, nEarly: early.length,
    direction: !stable ? 'insufficient' : shrunkDelta >= 0.03 ? 'rising' : shrunkDelta <= -0.03 ? 'falling' : 'flat', seasonShare: avg(games, shareOf) };
  // scoring games (separate games), spike detection
  const scoringLast5 = last5.filter(g => g.td > 0);
  const totalTd = sum(games, g => g.td);
  let spike = false, spikeNote = null;
  if (totalTd >= 3) {
    const maxG = games.reduce((m, g) => (g.td > (m?.td || 0) ? g : m), null);
    const after = games.filter(g => g.week > maxG.week);
    if (maxG.td / totalTd >= 0.8 && after.length >= 1 && after.every(g => g.td === 0)) { spike = true; spikeNote = `${maxG.td} of his ${totalTd} touchdowns came in one game (week ${maxG.week}) and the games since are blank, so that signal is shrunk (×0.72).`; }
  }
  const recentWindow = games.filter(g => g.week >= week - 3);
  const recentWorkGames = last5.filter(g => (g.carries + g.targets) >= 3).length;
  const snaps = last3.map(g => g.offSnaps).filter(x => x != null);
  const outsideScoreGames = zSeason.r0.scoreGames.size + zSeason.t0.scoreGames.size;
  return { logs: cur, prevLogs: prev, games, n: games.length, last3, last5, seasonAvg, last3Avg, zSeason, zRecent, zoneGames: zoneGames.size, zoneKnownGames: games.filter(g => g.zoneKnown).length,
    recentWindow, trend, scoringLast5: scoringLast5.length, last5Count: last5.length, scoredRecent2: last5.slice(-2).filter(g => g.td > 0).length, totalTd, spike, spikeNote,
    recentSnaps: sum(snaps, x => x), snapGames: snaps.length, snapShare: last3.length ? avg(last3.filter(g => g.offPct != null), g => g.offPct) : null, recentWorkGames, outsideScoreGames };
}

export function usageScore(p, f) {
  const l = f.last3Avg; const s = f.seasonAvg;
  const v = p.pos === 'QB' ? (l.att || s.att) : p.pos === 'RB' || p.pos === 'FB' ? (l.carries + l.targets) : l.targets;
  return v + (f.recentSnaps || 0) / 1000;
}

// Shrunk, blended per-game volume for one player.
export function playerVolume(p, f, prior, w, proj) {
  const k = w.shrinkGames; const n = f.n, m = Math.min(3, n);
  const vol = {}, detail = {};
  for (const key of METRICS) {
    const sAvg = f.seasonAvg[key], lAvg = f.last3Avg[key];
    const ns = (key === 'rzRush' || key === 'rzTgt') ? f.games.filter(g => g.rzRush != null).length : n;
    const nl = (key === 'rzRush' || key === 'rzTgt') ? f.last3.filter(g => g.rzRush != null).length : m;
    const sh = ns ? (ns * (sAvg ?? 0) + k * prior[key]) / (ns + k) : prior[key];
    const rh = nl ? (nl * (lAvg ?? 0) + k * prior[key]) / (nl + k) : prior[key];
    let v = (1 - w.recentBlend) * sh + w.recentBlend * rh;
    let pub = null;
    const pk = { carries: 'rush_att', targets: 'rec_tgt', att: 'pass_att' }[key];
    if (pk && proj && proj[pk] != null) { pub = proj[pk]; v = (1 - w.publishedBlend) * v + w.publishedBlend * pub; }
    vol[key] = Math.max(0, v); detail[key] = { season: sAvg, last3: lAvg, shrunkSeason: sh, shrunkRecent: rh, published: pub, prior: prior[key], n: ns };
  }
  // stable role change moves opportunity share before transfers and caps
  let roleFactor = 1;
  if (f.trend.stable && f.trend.seasonShare > 0.02) roleFactor = clamp(1 + f.trend.shrunkDelta / Math.max(0.08, f.trend.seasonShare), 0.75, 1.3);
  for (const key of ['carries', 'targets', 'rzRush', 'rzTgt']) vol[key] *= roleFactor;
  return { vol, detail, roleFactor };
}

// Transfer vacated observed work from limited/unavailable players to the
// available same-position teammate with the most offensive snaps.
// Goal-line (inside-5) share goes to the teammate with real inside-10 rushing work when one exists.
export function transferWork(team) {
  const notes = [];
  for (const p of team) {
    const f = p.avail.factor; if (f >= 1) continue;
    // only observed work from the last three weeks can be vacated (no stale or prior-only touches)
    const win = p.f.recentWindow || [];
    const per = k => (win.length ? win.reduce((s, g) => s + (g[k] || 0), 0) / win.length : 0);
    const observed = { carries: per('carries'), targets: per('targets'), att: per('att'), rzRush: per('rzRush'), rzTgt: per('rzTgt') };
    const vacated = {}; let any = false;
    for (const k of Object.keys(observed)) { vacated[k] = Math.min(p.vol[k], observed[k]) * (1 - f); if (vacated[k] > 0.05) any = true; }
    for (const k of Object.keys(p.vol)) p.vol[k] *= f;
    p.binScale = f;
    if (!any || !win.length) continue;
    const mates = team.filter(t => t !== p && t.pos === (p.pos === 'FB' ? 'RB' : p.pos) && t.avail.factor >= 1 && !t.avail.excluded)
      .sort((a, b) => (b.f.recentSnaps - a.f.recentSnaps) || (usageScoreSimple(b) - usageScoreSimple(a)));
    if (!mates.length) { notes.push({ from: p.id, to: null, text: `${p.name}'s work has no available same-position teammate.` }); continue; }
    const snapLeader = mates[0];
    // snap leader takes the work up to a bounded role ceiling; any overflow goes to the next snap leader
    const ceil = depthPrior(snapLeader.pos, 1);
    const spill = [];
    for (const k of Object.keys(vacated)) {
      let left = vacated[k];
      for (const m of mates) {
        if (left <= 0) break;
        const cap = Math.max(0, (ceil[k] || 0) * 1.3 - m.vol[k]);
        const give = m === mates[mates.length - 1] ? left : Math.min(left, cap);
        if (give > 0) { m.vol[k] += give; left -= give; if (m !== snapLeader && give > 0.05) spill.push(m); }
      }
    }
    snapLeader.replacing = { id: p.id, name: p.name, share: 1 - f };
    const glMates = mates.map(t => ({ t, i5: t.f.zSeason.r1.looks, i10: t.f.zSeason.r1.looks + t.f.zSeason.r2.looks })).filter(x => x.i10 > 0).sort((a, b) => b.i5 - a.i5 || b.i10 - a.i10);
    const glRecipient = glMates.length ? glMates[0].t : snapLeader;
    p.transfer = { to: snapLeader.id, toName: snapLeader.name, glTo: glRecipient.id, glToName: glRecipient.name, fraction: 1 - f, vacated, weeks: win.map(g => g.week) };
    glRecipient.glInherit = (glRecipient.glInherit || 0) + (1 - f);
    glRecipient.glFrom = p.id;
    const sp = [...new Set(spill)].map(m => m.name);
    notes.push({ from: p.id, to: snapLeader.id, gl: glRecipient.id, text: `${snapLeader.name} (most offensive snaps among available ${snapLeader.pos}s) takes ${Math.round((1 - f) * 100)}% of ${p.name}'s observed work from weeks ${win.map(g => g.week).join(', ')}${sp.length ? ` up to a role ceiling; overflow to ${sp.join(', ')}` : ''}${glRecipient !== snapLeader ? `; ${glRecipient.name} inherits the goal-line spots (more inside-10 carries)` : ''}.` });
  }
  return notes;
}
const usageScoreSimple = t => t.f.last3Avg.carries + t.f.last3Avg.targets + t.f.last3Avg.att;

export const TEAM_PRIORS = { carries: 26, targets: 33, att: 34, rzRush: 3.6, rzTgt: 3.6 };
// Team per-game budget for each metric, shrunk to league priors.
export function teamBudget(teamGames, ctx, w) {
  const n = teamGames.length; const k = 3; const b = {};
  for (const key of ['carries', 'targets', 'att']) { const a = avg(teamGames, g => g[key]); b[key] = n ? (n * a + k * TEAM_PRIORS[key]) / (n + k) : TEAM_PRIORS[key]; }
  b.rzRush = ctx.teamRz?.rzRush != null ? (ctx.teamRz.n * ctx.teamRz.rzRush + k * TEAM_PRIORS.rzRush) / (ctx.teamRz.n + k) : TEAM_PRIORS.rzRush;
  b.rzTgt = ctx.teamRz?.rzTgt != null ? (ctx.teamRz.n * ctx.teamRz.rzTgt + k * TEAM_PRIORS.rzTgt) / (ctx.teamRz.n + k) : TEAM_PRIORS.rzTgt;
  const pace = clamp(ctx.implied / 22.5, 0.84, 1.22);
  const notes = [];
  const sp = ctx.spread; // team-perspective spread (negative = favorite)
  const sw = w.script;
  let rushMul = 1, passMul = 1, rzMul = pace * w.redZone * (ctx.defRz || 1), passEff = 1;
  b.volPace = Math.sqrt(pace);
  if (sp <= -8.5) { rushMul *= 1 + 0.08 * sw; passMul *= 1 - 0.06 * sw; notes.push(`Two-score favorite: extra rushing work, passing cut.`); }
  else if (sp >= 8.5) { rushMul *= 1 - 0.08 * sw; passMul *= 1 + 0.05 * sw; passEff = 1 - 0.05 * sw; notes.push('Large underdog: chasing adds attempts but efficiency and scoring chances fall.'); }
  if (ctx.weather?.rushTilt) { rushMul *= 1.06; passMul *= 0.94; notes.push(ctx.weather.note); }
  if (ctx.override) { rushMul *= ctx.override.rush; passMul *= ctx.override.pass; }
  b.carries *= rushMul * b.volPace; b.rzRush *= rushMul * rzMul; b.targets *= passMul * b.volPace; b.att *= passMul * b.volPace; b.rzTgt *= passMul * rzMul * passEff;
  b.pace = pace; b.passEff = passEff; b.tdBudget = ctx.budgetFit ? Math.max(0.4, ctx.budgetFit.a + ctx.budgetFit.b * ctx.implied) : ctx.implied * 0.7 / 6.9; b.budgetSource = ctx.budgetFit ? `calibrated on ${ctx.budgetFit.n} earlier team-games` : 'implied × .7 / 6.9'; b.notes = notes; b.scriptFav = sp <= -8.5; b.scriptDog = sp >= 8.5;
  return b;
}
// Fit player volumes to shared budgets: scale down when over; modest scale-up when under.
export function fitToBudget(players, budget) {
  const fits = {};
  for (const key of ['carries', 'targets', 'att']) {
    const s = players.reduce((a, p) => a + p.vol[key], 0);
    let f = 1; if (s > budget[key]) f = budget[key] / s; else if (s > 0) f = Math.min(1.15, budget[key] / s);
    for (const p of players) p.vol[key] *= f;
    fits[key] = { sum: s, budget: budget[key], factor: f };
  }
  return fits;
}
