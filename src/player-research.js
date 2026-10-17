// Research tools: same-position slate percentiles (tie-safe midrank), earlier-game
// context splits, and a historical threshold explorer. All use games before the matchup.
export function midrankPercentile(value, peers) {
  const vals = peers.filter(v => v != null && Number.isFinite(v));
  if (value == null || !Number.isFinite(value) || vals.length < 5) return null;
  let below = 0, equal = 0; for (const v of vals) { if (v < value) below++; else if (v === value) equal++; }
  return Math.round(100 * (below + 0.5 * equal) / vals.length);
}
const tot = (games, k) => games.reduce((s, g) => s + (g[k] || 0), 0);
export function profileMetrics(p) {
  const g = p.f.games; const c = tot(g, 'carries'), t = tot(g, 'targets');
  return {
    projCarries: p.vol.carries, projTargets: p.vol.targets, projRz: (p.vol.rzRush || 0) + (p.vol.rzTgt || 0) + 0,
    ypc: g.length >= 3 && c >= 20 ? tot(g, 'rushYd') / c : null,
    catchRate: g.length >= 3 && t >= 12 ? tot(g, 'rec') / t : null,
    ypt: g.length >= 3 && t >= 18 ? tot(g, 'recYd') / t : null,
  };
}
export function researchProfile(p, slatePlayers) {
  const peers = slatePlayers.filter(q => q.pos === p.pos);
  const mine = profileMetrics(p); const pm = peers.map(profileMetrics); const out = {};
  for (const k of Object.keys(mine)) out[k] = { value: mine[k], percentile: midrankPercentile(mine[k], pm.map(m => m[k])), peers: pm.filter(m => m[k] != null).length };
  out.note = 'Percentile is a rank among same-position players on this slate, not a probability or confidence. Needs at least 5 known peers; efficiency needs 3 earlier games and 20 carries / 12 targets / 18 targets.';
  return out;
}
export function splits(p) {
  const all = p.f.games; // current-season earlier games only
  const mk = (label, games) => ({ label, n: games.length, thin: games.length < 5, scoringGames: games.filter(g => g.td > 0).length,
    avg: Object.fromEntries(['carries', 'rushYd', 'targets', 'rec', 'recYd', 'att', 'passYd', 'td'].map(k => [k, games.length ? tot(games, k) / games.length : null])) });
  return [mk('All earlier games', all), mk('Home', all.filter(g => g.home === true)), mk('Away', all.filter(g => g.home === false)), mk(`With ${p.team}`, all.filter(g => g.team === p.team))]
    .map(s => ({ ...s, note: 'Descriptive only; not applied again to the forecast.' }));
}
// Historical frequency only from games strictly before the selected matchup.
export function thresholdExplorer(games, metric, threshold, cutoff) {
  const pool = games.filter(g => g.season < cutoff.season || (g.season === cutoff.season && g.week < cutoff.week));
  const hits = pool.filter(g => (g[metric] || 0) >= threshold).length;
  return { metric, threshold, hits, games: pool.length, frequency: pool.length ? hits / pool.length : null, label: 'Historical frequency, not a calibrated forecast probability' };
}
