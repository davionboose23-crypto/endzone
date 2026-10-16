// Trends agent (endzone-4.4): detects data-backed weekly trends from information available before the forecast
// week only, and converts them into bounded, shrunk multipliers on model components (opportunity shares, spot
// conversion, defense factor). Applied before safety caps and the team TD budget, so those invariants still hold.
// Family weights are fit walk-forward (2024/2025) and validated on held-out 2026 weeks (scripts/hist/trends-fit.mjs);
// families that do not pass stay at weight 0 (still shown, labeled "display only").
import TW from './trend-weights.json' with { type: 'json' };

export const FAMILIES = {
  snap: { label: 'Snap share', effect: 'share', desc: 'offensive snap share, last 2 games vs earlier' },
  usage: { label: 'Touch share', effect: 'share', desc: 'carry + target share of team, last 2 vs earlier' },
  redzone: { label: 'Red-zone role', effect: 'rzshare', desc: 'red-zone looks per game, last 2 vs earlier' },
  qbRush: { label: 'QB rushing', effect: 'rshare', desc: 'QB carries per game, last 2 vs earlier' },
  streak: { label: 'Scoring streak', effect: 'spot', desc: 'touchdowns in separate recent games' },
  defense: { label: 'Defense trend', effect: 'def', desc: 'TDs allowed to the position, last 3 games vs earlier' },
  miss: { label: 'Model miss pattern', effect: 'spot', desc: 'graded results vs the model\'s own earlier predictions' },
  pace: { label: 'Team volume', effect: 'none', desc: 'team carries + targets per game, last 2 vs earlier (display only)' },
  vacuum: { label: 'Role vacuum', effect: 'none', desc: 'work inherited from an unavailable teammate (already in the volume model)' },
};
export const PER_TREND = [0.85, 1.15]; export const PER_PLAYER = [0.80, 1.25];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const avg = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : 0);
const r2 = x => Math.round(x * 100) / 100;
export const shippedTrendWeights = () => ({ ...Object.fromEntries(Object.keys(FAMILIES).map(k => [k, 0])), ...(TW.weights || {}) });
export const trendValidation = () => TW;

function split(games, n = 2, minEarly = 2) {
  const late = games.slice(-n), early = games.slice(Math.max(0, games.length - n - 3), -n);
  return late.length >= n && early.length >= minEarly ? { late, early } : null;
}
// Player trends from p.f (logs strictly before the forecast week).
export function playerTrends(p, ctx) {
  const out = []; const g = p.f?.games || []; const name = p.name;
  const add = (family, strength, evidence, text) => { const s = clamp(strength, -1, 1); if (Math.abs(s) < 0.15) return; out.push({ id: `${family}:${p.id}`, family, type: FAMILIES[family].label, entity: { kind: 'player', id: p.id, name, team: p.team, pos: p.pos }, strength: r2(s), direction: s > 0 ? 'up' : 'down', evidence, text }); };
  // snap share
  const sg = g.filter(x => x.offPct != null); const ss = split(sg);
  if (ss) { const a = avg(ss.late, x => x.offPct), b = avg(ss.early, x => x.offPct); const d = a - b; if (Math.abs(d) >= 0.08) add('snap', (d / 0.2) * (ss.early.length / (ss.early.length + 2)), { late: r2(a), earlier: r2(b), nLate: ss.late.length, nEarlier: ss.early.length }, `${name}'s snap share ${d > 0 ? 'rose' : 'fell'} to ${Math.round(a * 100)}% over his last 2 games from ${Math.round(b * 100)}% (${ss.early.length} earlier games).`); }
  // touch share (QB: excluded; QBs use qbRush)
  const shareOf = x => { const den = (x.teamCarries || 0) + (x.teamTargets || 0); return den > 0 ? ((x.carries || 0) + (x.targets || 0)) / den : null; };
  const ug = g.filter(x => shareOf(x) != null); const us = split(ug);
  if (p.pos !== 'QB' && us) { const a = avg(us.late, shareOf), b = avg(us.early, shareOf); const d = a - b; if (Math.abs(d) >= 0.04) add('usage', (d / 0.12) * (us.early.length / (us.early.length + 2)), { late: r2(a), earlier: r2(b), nLate: us.late.length, nEarlier: us.early.length }, `${name}'s share of team carries + targets ${d > 0 ? 'rose' : 'fell'} to ${Math.round(a * 100)}% (last 2) from ${Math.round(b * 100)}% (${us.early.length} earlier games).`); }
  // red-zone looks per game
  const rg = g.filter(x => x.rzRush != null); const rs = split(rg);
  if (rs && p.pos !== 'QB') { const lz = x => (x.rzRush || 0) + (x.rzTgt || 0); const a = avg(rs.late, lz), b = avg(rs.early, lz); const d = a - b; if (Math.abs(d) >= 1 && (a + b) >= 1.5) add('redzone', (d / Math.max(2, b + 1)) * (rs.early.length / (rs.early.length + 2)), { lateLooksPerGame: r2(a), earlierLooksPerGame: r2(b), nLate: rs.late.length, nEarlier: rs.early.length }, `${name} is averaging ${a.toFixed(1)} red-zone looks over his last 2 games vs ${b.toFixed(1)} before (${rs.early.length} earlier games).`); }
  // QB rushing usage
  if (p.pos === 'QB') { const qs = split(g); if (qs) { const a = avg(qs.late, x => x.carries || 0), b = avg(qs.early, x => x.carries || 0); const d = a - b; if (Math.abs(d) >= 1.5) add('qbRush', (d / Math.max(3, b + 1)) * (qs.early.length / (qs.early.length + 2)), { lateCarries: r2(a), earlierCarries: r2(b), nLate: qs.late.length, nEarlier: qs.early.length }, `QB ${name} ran ${a.toFixed(1)} times a game over his last 2 vs ${b.toFixed(1)} before.`); } }
  // scoring streak across separate games (last 4)
  const l4 = g.slice(-4); const scored = l4.filter(x => (x.td || 0) > 0).length;
  if (l4.length >= 3 && scored >= 3) add('streak', 0.25 + 0.25 * (scored - 3) + (scored === l4.length ? 0.1 : 0), { scoringGames: scored, games: l4.length, weeks: l4.filter(x => x.td > 0).map(x => x.week) }, `${name} has scored in ${scored} of his last ${l4.length} games (weeks ${l4.filter(x => x.td > 0).map(x => x.week).join(', ')}).`);
  // model miss pattern from graded history (the model's own earlier predictions vs results)
  const h = (ctx.history || []).filter(r => r.id === p.id && r.week < ctx.week).sort((a, b) => a.week - b.week).slice(-5);
  if (h.length >= 3) { const exp = h.reduce((s, r) => s + r.chance, 0), act = h.reduce((s, r) => s + r.y, 0); const d = act - exp;
    if (Math.abs(d) >= 1) add('miss', (d / h.length / 0.3) * (h.length / (h.length + 3)), { games: h.length, expectedScoringGames: r2(exp), actualScoringGames: act }, `${d > 0 ? 'Under' : 'Over'}-predicted: the model expected ${exp.toFixed(1)} scoring games over his last ${h.length} graded games; he had ${act}.`); }
  // role vacuum (display; effect already in the volume model)
  if (p.inheritedShare > 0.05 || p.replacing) out.push({ id: `vacuum:${p.id}`, family: 'vacuum', type: FAMILIES.vacuum.label, entity: { kind: 'player', id: p.id, name, team: p.team, pos: p.pos }, strength: r2(clamp((p.inheritedShare || 0.1) * 3, 0, 1)), direction: 'up', evidence: { inheritedShare: r2(p.inheritedShare || 0), replacing: p.replacing?.name || null }, text: (p.inheritedShare || 0) > 0.005 ? `${name} inherits work${p.replacing ? ` from ${p.replacing.name}` : ''}: ${Math.round(p.inheritedShare * 100)}% of team red-zone share moved to him.` : `${name} steps into ${p.replacing ? `${p.replacing.name}'s` : 'an unavailable teammate\'s'} role (no measurable red-zone share transferred yet).` });
  return out;
}
// Defense vs position: TDs allowed per game to the position, last 3 games vs earlier (≥2 earlier).
export function defenseTrends(rows, defense, week) {
  const out = [];
  for (const pos of ['RB', 'WR', 'TE']) {
    const gm = new Map(); for (const r of rows) if (r.opp === defense && r.week < week) { const o = gm.get(r.gameId) || { week: r.week, td: 0 }; if (r.pos === pos) o.td += r.td || 0; gm.set(r.gameId, o); }
    const gs = [...gm.values()].sort((a, b) => a.week - b.week); const late = gs.slice(-3), early = gs.slice(0, -3);
    if (late.length < 3 || early.length < 2) continue;
    const a = avg(late, x => x.td), b = avg(early, x => x.td); const d = a - b; if (Math.abs(d) < 0.5) continue;
    const s = clamp((d / 1.2) * (early.length / (early.length + 2)), -1, 1); if (Math.abs(s) < 0.15) continue;
    out.push({ id: `defense:${defense}:${pos}`, family: 'defense', type: FAMILIES.defense.label, entity: { kind: 'defense', team: defense, pos }, strength: r2(s), direction: s > 0 ? 'up' : 'down', evidence: { lateTdPerGame: r2(a), earlierTdPerGame: r2(b), nLate: late.length, nEarlier: early.length }, text: `${defense} has allowed ${a.toFixed(1)} ${pos} touchdowns a game over its last 3 vs ${b.toFixed(1)} before (${early.length} earlier games): trending ${s > 0 ? 'soft' : 'tight'}.` });
  }
  return out;
}
export function teamTrends(teamGames, team, week = Infinity) {
  const gs = teamGames.filter(t => t.team === team && (t.week == null || t.week < week)).sort((a, b) => a.week - b.week); const sp = split(gs);
  if (!sp) return []; const v = x => x.carries + x.targets; const a = avg(sp.late, v), b = avg(sp.early, v); const d = (a - b) / Math.max(1, b);
  if (Math.abs(d) < 0.1) return [];
  return [{ id: `pace:${team}`, family: 'pace', type: FAMILIES.pace.label, entity: { kind: 'team', team }, strength: r2(clamp(d / 0.25, -1, 1)), direction: d > 0 ? 'up' : 'down', evidence: { lateTouchesPerGame: r2(a), earlierTouchesPerGame: r2(b), nLate: sp.late.length, nEarlier: sp.early.length }, text: `${team} ran ${Math.round(a)} carries + targets a game over its last 2 vs ${Math.round(b)} before.` }];
}
// Convert a player's trends (+ the opponent's defense trend for his position) into bounded multipliers.
export function trendMultipliers(trends, weights) {
  const m = { share: 1, rzshare: 1, rshare: 1, spot: 1, def: 1 }; const applied = [];
  for (const t of trends) { const eff = FAMILIES[t.family]?.effect; const w = weights?.[t.family] || 0; if (!eff || eff === 'none' || t.status === 'faded') continue;
    const k = clamp(Math.exp(w * t.strength), ...PER_TREND); m[eff] *= k; applied.push({ id: t.id, family: t.family, mult: k, logm: Math.log(k) }); }
  for (const k of Object.keys(m)) m[k] = clamp(m[k], ...PER_PLAYER);
  return { m, applied };
}
// per-component multiplier for path/bin
export function componentMult(m, path, bin) {
  let x = m.share; if (bin >= 1 && bin <= 3) x *= m.rzshare; if (path === 'r') x *= m.rshare; return clamp(x, ...PER_PLAYER);
}

// ---- status tracking (new / continuing / faded) and first-detected week.
// Re-runs the same detector on strictly earlier information (the player's logs minus his last k games, i.e. what the
// agent would have seen before each of those games), so status is reproducible from data, not from stored state.
const sameDir = (a, b) => a && b && a.direction === b.direction;
function annotate(cur, prevLists, prevWeeks, week) {
  // prevLists[k-1] = trends detected k detections ago (at week prevWeeks[k-1])
  const out = [];
  for (const t of cur) {
    let first = week, k = 0;
    while (k < prevLists.length && sameDir(prevLists[k].find(x => x.id === t.id), t)) { first = prevWeeks[k]; k++; }
    out.push({ ...t, status: k === 0 ? 'new' : 'continuing', firstDetectedWeek: first, detectedWeek: week });
  }
  const p1 = prevLists[0] || [];
  for (const t of p1) if (!cur.some(x => x.id === t.id) && t.family !== 'vacuum') {
    let first = prevWeeks[0], k = 1; while (k < prevLists.length && sameDir(prevLists[k].find(x => x.id === t.id), t)) { first = prevWeeks[k]; k++; }
    out.push({ ...t, status: 'faded', firstDetectedWeek: first, detectedWeek: week, fadedSinceWeek: prevWeeks[0], strength: 0, text: `Faded: ${t.text.replace(/\.$/, '')} (detected through week ${prevWeeks[0]}; no longer meets the threshold).` });
  }
  return out;
}
export function playerTrendsWithStatus(p, ctx, depth = 6) {
  const g = p.f?.games || []; const cur = playerTrends(p, ctx); const lists = [], weeks = [];
  for (let k = 1; k <= depth && g.length - k >= 3; k++) { const wk = g[g.length - k].week; lists.push(playerTrends({ ...p, inheritedShare: 0, replacing: null, f: { ...p.f, games: g.slice(0, -k) } }, { history: ctx.history, week: wk })); weeks.push(wk); }
  return annotate(cur, lists, weeks, ctx.week);
}
export function defenseTrendsWithStatus(rows, defense, week, depth = 6) {
  const wks = [...new Set(rows.filter(r => r.opp === defense && r.week < week).map(r => r.week))].sort((a, b) => b - a).slice(0, depth);
  return annotate(defenseTrends(rows, defense, week), wks.map(w => defenseTrends(rows, defense, w)), wks, week);
}
export function teamTrendsWithStatus(teamGames, team, week, depth = 6) {
  const wks = [...new Set(teamGames.filter(t => t.team === team && t.week < week).map(t => t.week))].sort((a, b) => b - a).slice(0, depth);
  return annotate(teamTrends(teamGames, team, week), wks.map(w => teamTrends(teamGames, team, w)), wks, week);
}
