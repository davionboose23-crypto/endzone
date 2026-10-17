// Independent confidence ratings per area. Confidence describes evidence
// stability and forecast uncertainty, never a guarantee.
const cv = arr => { if (arr.length < 2) return null; const m = arr.reduce((a, b) => a + b, 0) / arr.length; if (m <= 0) return null; const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1); return Math.sqrt(v) / m; };
export const CONF_ORDER = { High: 0, Med: 1, Low: 2 };

export function tdConfidence(p, ctx = {}) {
  const f = p.f, reasons = [], blocks = [];
  const last3 = f.last3;
  const rzKnown = last3.filter(g => g.rzRush != null);
  const recentRz = rzKnown.reduce((s, g) => s + (g.rzRush || 0) + (g.rzTgt || 0), 0);
  const recentTouches = last3.map(g => g.carries + g.targets);
  const avgTouches = recentTouches.length ? recentTouches.reduce((a, b) => a + b, 0) / recentTouches.length : 0;
  const latest = recentTouches[recentTouches.length - 1] ?? 0;
  const width = p.band[1] - p.band[0];
  const narrow = width <= 0.30 && width / Math.max(p.chance, 0.08) <= 1.25;
  const baseline = recentRz >= 6 && f.recentWorkGames >= 3;
  const repeat = f.scoringLast5 >= 3 && f.last5Count > 0 && f.scoringLast5 / f.last5Count >= 0.6 && last3.filter(g => g.td > 0).length >= 2;
  const roleOk = avgTouches >= 6 && latest >= 0.6 * avgTouches;
  if (baseline) reasons.push(`${recentRz} red-zone touches in his last ${rzKnown.length} games with stable work.`);
  else reasons.push(`${rzKnown.length ? recentRz : 'unknown'} red-zone touches in his last three games${rzKnown.length ? '' : ' (no red-zone data)'}.`);
  if (repeat) reasons.push(`Scored in ${f.scoringLast5} of his last ${f.last5Count} games, including ${last3.filter(g => g.td > 0).length} of the last three.`);
  if (narrow) reasons.push(`80% band ${(p.band[0] * 100).toFixed(0)}–${(p.band[1] * 100).toFixed(0)}% is narrow enough.`); else blocks.push(`80% band ${(p.band[0] * 100).toFixed(0)}–${(p.band[1] * 100).toFixed(0)}% is too wide.`);
  if (f.trend.direction === 'falling') blocks.push('Workload share is falling.');
  if (p.scriptSensitive) blocks.push('Chance swings more than 10 points across game scripts.');
  if (p.coldGoal) blocks.push('Cold goal line.');
  if (p.verified !== true) blocks.push('Roster membership not verified.');
  if (repeat && !roleOk) blocks.push('Repeat scoring without sustained touches.');
  let level;
  if ((baseline || (repeat && roleOk)) && !blocks.length) level = 'High';
  else if (recentRz >= 2 || f.scoringLast5 >= 2 || (f.n >= 3 && avgTouches >= 6) || (p.pos === 'QB' && f.n >= 3)) level = 'Med';
  else level = 'Low';
  return applyAvailability({ level, reasons, blocks, evidence: { recentRz, avgTouches, latest, width, narrow, baseline, repeat, roleOk } }, p);
}
export function applyAvailability(c, p) {
  if (p.avail?.doubtfulOrDnp) { c.level = 'Low'; c.blocks.push(`${p.avail.label}: every area is Low.`); }
  else if ((p.avail?.uncertain || p.replacing) && c.level === 'High') { c.level = 'Med'; c.blocks.push(p.replacing ? `Replacement role for ${p.replacing.name} reduces High to Medium.` : `${p.avail.label} reduces High to Medium.`); }
  return c;
}

const VOL = {
  rushYd: { opp: 'carries', high: 20, med: 8, minProj: 6, effCv: 0.75, prodCv: 0.85, prod: g => g.rushYd, eff: g => (g.carries ? g.rushYd / g.carries : null), defKey: 'ypc', label: 'Rush yards' },
  rec: { opp: 'targets', high: 12, med: 5, minProj: 3, effCv: 0.45, prodCv: 0.6, prod: g => g.rec, eff: g => (g.targets ? g.rec / g.targets : null), defKey: 'catchRate', label: 'Receptions' },
  recYd: { opp: 'targets', high: 18, med: 8, minProj: 3, effCv: 0.8, prodCv: 0.85, prod: g => g.recYd, eff: g => (g.targets ? g.recYd / g.targets : null), defKey: 'ypt', label: 'Receiving yards' },
  passYd: { opp: 'att', high: 50, med: 20, minProj: 20, effCv: 0.8, prodCv: 0.85, prod: g => g.passYd, eff: g => (g.att ? g.passYd / g.att : null), defKey: 'passYpa', label: 'Pass yards' },
};
export function volumeConfidence(metric, p, fc, ctx = {}) {
  const spec = VOL[metric]; const f = p.f; const reasons = [], blocks = [];
  const sample = f.games.reduce((s, g) => s + (g[spec.opp] || 0), 0);
  const proj = p.vol[spec.opp];
  const recent = f.last5.filter(g => (g[spec.opp] || 0) >= Math.max(1, spec.minProj / 3));
  const recentAvg = f.last3.length ? f.last3.reduce((s, g) => s + (g[spec.opp] || 0), 0) / f.last3.length : 0;
  const nearZero = proj < Math.max(1, spec.minProj / 4);
  if (nearZero) return { level: 'Low', reasons: [`Near-zero projected ${spec.opp} (${proj.toFixed(1)}).`], blocks: [], provisional: true };
  let level = sample >= spec.high ? 'High' : sample >= spec.med ? 'Med' : 'Low';
  reasons.push(`${sample} ${spec.opp} this season (High needs ${spec.high}, Medium ${spec.med}).`);
  if (level === 'High') {
    if (recent.length < 3) blocks.push(`Meaningful ${spec.opp} in only ${recent.length} recent games.`);
    if (recentAvg > 0 && proj < 0.6 * recentAvg) blocks.push(`Projected ${spec.opp} below 60% of recent average.`);
    if (proj < spec.minProj) blocks.push(`Fewer than ${spec.minProj} projected ${spec.opp}.`);
    const oppCv = cv(f.last5.map(g => g[spec.opp] || 0));
    const effCv = cv(f.last5.map(spec.eff).filter(x => x != null));
    const prodCv = cv(f.last5.map(spec.prod));
    if (oppCv != null && oppCv > 1) blocks.push(`Unstable ${spec.opp} (CV ${oppCv.toFixed(2)}).`);
    if (effCv != null && effCv > spec.effCv) blocks.push(`Unstable efficiency (CV ${effCv.toFixed(2)} > ${spec.effCv}).`);
    if (prodCv != null && prodCv > spec.prodCv) blocks.push(`Unstable production (CV ${prodCv.toFixed(2)} > ${spec.prodCv}).`);
    if (f.trend.direction === 'falling') blocks.push('Falling shrunk usage share.');
    if (fc && fc.mean > 0 && (fc.hi - fc.lo) / fc.mean > 1.8) blocks.push('Very wide range.');
    if (p.avail?.uncertain) blocks.push('Availability uncertain.');
    if (p.verified !== true) blocks.push('Roster membership not verified.');
    if (ctx.coverage != null && ctx.coverage < 0.72) blocks.push(`Held-out 80% ranges covered only ${(ctx.coverage * 100).toFixed(0)}% of comparable results.`);
    if (blocks.length) level = 'Med';
  }
  // A defense that permits less than league drops High to Med; a favorable one never upgrades.
  if (level === 'High' && fc?.defense && fc.defense.allowed != null && fc.defense.league != null && fc.defense.allowed < fc.defense.league) { level = 'Med'; blocks.push(`Defense allows ${fc.defense.allowed.toFixed(2)} vs league ${fc.defense.league.toFixed(2)}.`); }
  if (ctx.coverage == null) reasons.push('Role-specific held-out coverage not yet available: provisional.');
  const c = applyAvailability({ level, reasons, blocks, provisional: ctx.coverage == null }, p);
  return c;
}
