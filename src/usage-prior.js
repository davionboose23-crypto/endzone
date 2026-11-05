// app 4.15.0 usage-prior-1: each player's LAST-SEASON usage from real play-by-play (nflverse), per game he played.
// Used by the model-free sims for (a) the depth order / star-vs-role tag (a star who missed this season's games so far, or who is
// new to the team's drive file, keeps his prior-season standing) and (b) the carried-in line of a player with no drive-file history.
// Built from tallies of season S-1 only (src/td-share.js tallyGames), so it is always pre-game. No market or model numbers.
// shape: { version, season (the season it is FOR), from (S-1), cols, players: { gsis: [team, pos, g, tgt, car, rz, td] } } (per-game means)
export const USAGE_PRIOR_VERSION = 'usage-prior-1';
export const UP_COLS = ['team', 'pos', 'g', 'tgt', 'car', 'rz', 'td'];
export function buildUsagePrior(tallies, season, { priorW } = {}) {
  // research priorW: {year: weight} for seasons before `season`. Default = last season only (weight 1).
  const years = priorW || { [season - 1]: 1 };
  const acc = new Map();
  for (const G of tallies) { const yw = years[G.season]; if (!(yw > 0)) continue;
    for (const x of G.pl.values()) { const a = acc.get(x.id) || { pos: x.pos, team: G.off, ord: -1, g: 0, tgt: 0, car: 0, rz: 0, td: 0 };
      a.g += yw; a.tgt += yw * x.v[6]; a.car += yw * x.v[3]; a.rz += yw * (x.v[2] + x.v[5]); a.td += yw * x.v[7];
      const ord = G.season * 100 + G.week; if (ord >= a.ord) { a.ord = ord; a.team = G.off; a.pos = x.pos; } acc.set(x.id, a); } }
  const r2 = v => +v.toFixed(2); const players = {};
  for (const [id, a] of acc) if (a.g >= 1 && a.tgt + a.car > 0) players[id] = [a.team, a.pos, r2(a.g), r2(a.tgt / a.g), r2(a.car / a.g), r2(a.rz / a.g), r2(a.td / a.g)];
  const from = Object.keys(years).map(Number).filter(y => years[y] > 0).sort();
  return { version: USAGE_PRIOR_VERSION, season, from: from.length === 1 ? from[0] : from, cols: UP_COLS, players };
}
export function priorOf(UP, gsis) { const r = UP?.players?.[gsis]; return r ? { team: r[0], pos: r[1], g: r[2], tgt: r[3], car: r[4], rz: r[5], td: r[6] } : null; }
