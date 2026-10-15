// Full player detail payload (built on demand in the worker from live objects).
import { BINS, BIN_LABEL, BIN_SUB } from './spots.js';
import { advancedEvidence } from './advanced.js';
import { researchProfile, splits } from './player-research.js';
import { matchupSentence, normalizedShares } from './matchups.js';
import { sleeperLog } from './stats-index.js';
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const FRAME = ['carries', 'rushYd', 'rushTd', 'rzRush', 'targets', 'rec', 'recYd', 'airYd', 'yac', 'recTd', 'rzTgt', 'att', 'cmp', 'passYd', 'passTd', 'rzPass'];
export function frameLine(games) {
  const o = {};
  for (const k of FRAME) { const known = games.filter(g => g[k] != null); o[k] = known.length === games.length || !['rzRush', 'rzTgt', 'rzPass'].includes(k) ? sum(games, g => g[k] || 0) : (known.length ? sum(known, g => g[k]) : null); }
  o.games = games.length; return o;
}
const logRow = g => ({ season: g.season, week: g.week, opp: g.opp, home: g.home, carries: g.carries, rushYd: g.rushYd, targets: g.targets, rec: g.rec, recYd: g.recYd, td: g.td, full: g });

// Actual outcome for a finished game with explicit confirmed / pending / missing / confirmed-zero states.
export function actualOutcome(ix, player, game) {
  if (!game.finished) return { status: 'pending' };
  let row = (player.gsis && (ix.logsByGsis.get(player.gsis) || []).find(r => r.season === game.season && r.week === game.week)) || null;
  if (!row) { const s = ix.weekly[game.week]?.stats?.[player.id]; if (s && game.season === ix.season) row = sleeperLog(s, player, game, game.season, game.week); }
  const snaps = (player.gsis && (ix.snapsByGsis.get(player.gsis) || []).find(r => r.week === game.week)) || null;
  if (!row && !(snaps && snaps.offSnaps > 0)) return { status: 'missing', note: 'No stat or snap record: excluded from grading.' };
  const r = row || { rushTd: 0, recTd: 0, rushYd: 0, rec: 0, recYd: 0, passYd: 0, passTd: 0, carries: 0, targets: 0, att: 0 };
  const td = (r.rushTd || 0) + (r.recTd || 0);
  const zones = ix.zoneGameSet.has(game.id) && player.gsis ? (ix.zonesByGsis.get(player.gsis) || []).filter(z => z.gameId === game.id) : null;
  const spotTd = zones ? Object.fromEntries(['r', 't'].flatMap(p => [0, 1, 2, 3].map(b => [`${p}${b}`, sum(zones.filter(z => z.path === p && z.bin === b), z => z.scores)]))) : null;
  const spotLooks = zones ? Object.fromEntries(['r', 't'].flatMap(p => [0, 1, 2, 3].map(b => [`${p}${b}`, sum(zones.filter(z => z.path === p && z.bin === b), z => z.looks)]))) : null;
  return { status: td > 0 ? 'confirmed' : 'confirmed-zero', td, rushYd: r.rushYd, rec: r.rec, recYd: r.recYd, passYd: r.passYd, passTd: r.passTd, carries: r.carries, targets: r.targets, att: r.att, spotTd, spotLooks, spotKnown: !!zones, source: row?.src || 'snap count only' };
}

export function playerDetail(W, G, side, p, slatePlayers) {
  const S = G.sides[side]; const oppTeam = S.opp; const f = p.f;
  const pies = {};
  for (const path of ['t', 'r']) for (const b of BINS) {
    const k = `${path}${b}`; const sd = p.shareData?.[k];
    pies[k] = { label: BIN_LABEL[b], sub: BIN_SUB[b], path: path === 't' ? 'Targets' : 'Rushes', player: sd?.playerRecent ?? 0, team: sd?.teamRecent ?? 0, seasonPlayer: sd?.playerSeason ?? 0, seasonTeam: sd?.teamSeason ?? 0, window: 'last three weeks (current season only)' };
  }
  const spotTable = [];
  for (const path of ['r', 't']) for (const b of [1, 2, 3, 0]) { const s = p.spots[`${path}${b}`]; spotTable.push({ path: path === 'r' ? 'Rush' : 'Target', bin: b ? BIN_SUB[b] : 'outside 20', looks: s.opps, rate: s.rate, td: p.components[`${path}${b}`] || 0, seasonLooks: s.looks, seasonScores: s.scores }); }
  const h2h = [...f.logs, ...f.prevLogs].filter(g => g.opp === oppTeam && (g.carries + g.targets + g.att) > 0).sort((a, b) => b.season - a.season || b.week - a.week).slice(0, 5).map(logRow);
  const m = p.matchup;
  const shares = normalizedShares();
  const limitations = [];
  const src = W.ix.prep.sources;
  if (!W.ix.prep.zones) limitations.push('Play-by-play unavailable: yard-line spots use labeled priors; actual yard-line results unknown.');
  if (!W.ix.prep.charting) limitations.push('FTN charting unavailable: no catchability/contested/sneak adjustments.');
  if (p.verified !== true) limitations.push(p.verifyReason);
  if (f.n < 3) limitations.push(`Only ${f.n} current-season games: depth priors carry most of the volume.`);
  if (G.historical) limitations.push('Reconstructed after kickoff from earlier-week data with the current closing line; today\'s injury report is not applied. Not a prospective forecast.');
  if (!S.lines.known) limitations.push('Lines unknown: spread 0 / total 44.5 used.');
  for (const [k, s] of Object.entries(src)) if (!s.ok && s.optional) limitations.push(`${s.label}: ${s.error}`);
  return {
    id: p.id, matchupLead: { sentence: matchupSentence(m, oppTeam), softness: m?.softness ?? null, soft: m?.soft, last3: m?.last3 || [], last3Games: m?.last3Games, last3Tds: m?.last3Tds, supportive: m?.supportive, featured: m?.featured, roleRatio: m?.roleRatio, liftBlocked: p.liftBlocked,
      evidence: m ? `${oppTeam} allowed ${m.pos}s ${m.last3Tds} touchdowns in the last three games (${m.last3Games} of 3 games contributed).` : null },
    role: `${p.role}${p.glOwner ? ', goal-line owner' : ''}${p.replacing ? `, replacing ${p.replacing.name}` : ''}`,
    injury: { avail: p.avail, transferOut: S.excluded.find(e => e.id === p.id)?.transfer || null, replacing: p.replacing || null },
    weather: S.weather, script: S.budget.notes,
    frame: { season: frameLine(f.games), last3: frameLine(f.last3) }, snaps: { recent: f.recentSnaps, games: f.snapGames, share: f.snapShare },
    last5: f.games.slice(-5).reverse().map(logRow), allLogs: [...f.logs].reverse().map(g => g), h2h,
    actual: actualOutcome(W.ix, p, G.game), pies, spotTable, profile: researchProfile(p, slatePlayers), splits: splits(p), advanced: advancedEvidence(p, W),
    scenarios: p.scenarios, defenseTable: m ? { pathRates: m.pathRates, eff: m.eff, rz: m.rz, offenseShare: m.roleRatio, leagueShare: shares[m.pos] } : null,
    published: p.published ? { ...p.published, note: 'Sleeper rushing + receiving TD projection is an expected count converted with 1 − exp(−x).' } : { note: 'No published projection: edge unavailable (not zero).' },
    limitations, notes: { safety: p.safetyNotes, lesson: p.lessonNotes, secondOption: p.secondOption, spike: f.spikeNote, conversion: p.conversionNote, riser: p.riser?.reason },
    budget: { teamLambda: S.teamLambda, tdBudget: S.tdBudget, notes: S.teamNotes },
  };
}
