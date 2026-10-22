// Ranking and recommendation consistency: High TD confidence first, then chance.
import { CONF_ORDER } from './confidence.js';
export function compareDefault(a, b) {
  const ha = a.tdConf?.level === 'High' ? 0 : 1, hb = b.tdConf?.level === 'High' ? 0 : 1;
  return ha - hb || (b.chance - a.chance) || String(a.id).localeCompare(String(b.id));
}
const confRank = lvl => CONF_ORDER[lvl] ?? 3; // High 0, Med 1, Low 2, missing last
// Model TD confidence High > Med > Low, ties by chance (then id for stability).
export function compareConfidence(a, b) {
  return confRank(a.tdConf?.level) - confRank(b.tdConf?.level) || (b.chance - a.chance) || String(a.id).localeCompare(String(b.id));
}
// Other-stat confidence: the model's own confidence for that stat projection (volConf[m]), High > Med > Low,
// ties by the projected mean, then chance. Players without that projection (e.g. non-QBs for pass yards) sort last.
const statConf = (m, qbOnly = false) => (a, b) => {
  const ha = !!a.volConf?.[m] && (!qbOnly || a.pos === 'QB'), hb = !!b.volConf?.[m] && (!qbOnly || b.pos === 'QB');
  if (ha !== hb) return ha ? -1 : 1; if (!ha) return compareDefault(a, b);
  return confRank(a.volConf[m].level) - confRank(b.volConf[m].level) || ((b.volume?.[m]?.mean ?? -Infinity) - (a.volume?.[m]?.mean ?? -Infinity)) || compareDefault(a, b);
};
export const SORT_GROUPS = [
  ['Touchdown', ['default', 'conf', 'chance', 'edge']],
  ['Other stats', ['rushYd', 'recYd', 'rec', 'passYd', 'passTd']],
  ['Other stats by model confidence', ['rushYdConf', 'recYdConf', 'recConf', 'passYdConf']],
];
export const SORTS = {
  default: { label: 'High TD confidence first', cmp: compareDefault },
  conf: { label: 'Model confidence (High › Med › Low)', cmp: compareConfidence, conf: true },
  rushYdConf: { label: 'Rush yards — confidence', cmp: statConf('rushYd'), conf: true },
  recYdConf: { label: 'Receiving yards — confidence', cmp: statConf('recYd'), conf: true },
  recConf: { label: 'Receptions — confidence', cmp: statConf('rec'), conf: true },
  passYdConf: { label: 'QB pass yards — confidence', cmp: statConf('passYd', true), conf: true },
  chance: { label: 'Chance', key: p => p.chance },
  edge: { label: 'Edge', key: p => p.edge },
  rushYd: { label: 'Rush yards', key: p => p.volume?.rushYd?.mean },
  recYd: { label: 'Receiving yards', key: p => p.volume?.recYd?.mean },
  rec: { label: 'Receptions', key: p => p.volume?.rec?.mean },
  passYd: { label: 'QB pass yards', key: p => (p.pos === 'QB' ? p.volume?.passYd?.mean : null) },
  passTd: { label: 'QB passing TDs', key: p => (p.pos === 'QB' ? p.passTd?.expected : null) },
};
// Explicit stat sort; missing values sort last.
export function sortPlayers(list, sortKey = 'default') {
  const s = SORTS[sortKey] || SORTS.default;
  if (s.cmp) return list.slice().sort(s.cmp);
  return list.slice().sort((a, b) => {
    const va = s.key(a), vb = s.key(b); const ma = va == null || !Number.isFinite(va), mb = vb == null || !Number.isFinite(vb);
    if (ma && mb) return compareDefault(a, b); if (ma) return 1; if (mb) return -1; return vb - va || compareDefault(a, b);
  });
}
// One chosen scorer per team; the same player object supplies id, name, photo, chance, explanation.
export function chooseTeamCall(players, ctx) {
  const pool = players.filter(p => !p.avail.excluded && p.chance > 0);
  if (!pool.length) return null;
  const ranked = pool.slice().sort(compareDefault);
  const leader = pool.slice().sort((a, b) => b.chance - a.chance)[0];
  let pick = ranked[0]; let lean = null;
  if (ctx.spread <= -6) {
    const gl = pool.filter(p => p.pos === 'RB' || p.pos === 'FB').sort((a, b) => (b.glShare || 0) - (a.glShare || 0))[0];
    if (gl && gl !== pick && gl.glShare > 0.3 && gl.chance >= pick.chance - 0.04 && CONF_ORDER[gl.tdConf.level] <= CONF_ORDER[pick.tdConf.level]) { pick = gl; lean = `Favored by ${Math.abs(ctx.spread)}: leaning to the goal-line back.`; }
  } else if (ctx.spread >= 6) {
    const rec = pool.filter(p => (p.pos === 'WR' || p.pos === 'TE') && p.recentRzTgt >= 2).sort((a, b) => b.chance - a.chance)[0];
    const qb = pool.filter(p => p.pos === 'QB' && (p.components.rush || 0) > 0.12)[0];
    const alt = [rec, qb].filter(Boolean).sort((a, b) => b.chance - a.chance)[0];
    if (alt && alt !== pick && alt.chance >= pick.chance - 0.04 && CONF_ORDER[alt.tdConf.level] <= CONF_ORDER[pick.tdConf.level]) { pick = alt; lean = `Underdog by ${ctx.spread}: leaning to the supported ${alt.pos === 'QB' ? "quarterback's own scoring path" : 'red-zone receiver'}.`; }
  }
  const why = [];
  if (pick === leader) why.push(`${pick.name} has the highest chance on the team (${(pick.chance * 100).toFixed(0)}%).`);
  else why.push(`${pick.name} (${(pick.chance * 100).toFixed(0)}%) is the call; the numerical leader is ${leader.name} at ${(leader.chance * 100).toFixed(0)}%.${pick.tdConf.level === 'High' && leader.tdConf.level !== 'High' ? ' High touchdown confidence ranks first.' : ''}`);
  if (lean) why.push(lean);
  return { id: pick.id, leaderId: leader.id, isLeader: pick === leader, why, lean };
}
export function weeklyPick(allPlayers) {
  const pool = allPlayers.filter(p => !p.avail.excluded && !p.started);
  return pool.slice().sort(compareDefault)[0] || null;
}
export function bestRiser(allPlayers) {
  return allPlayers.filter(p => p.riser && !p.avail.excluded && !p.started).sort((a, b) => b.chance - a.chance)[0] || null;
}
