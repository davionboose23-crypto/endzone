// Drive-pattern adjustment (endzone app 4.8): turns a player's SURVIVING drive patterns (FDR + shrinkage + walk-forward
// persistence, see src/drive-patterns.js) plus this week's context into a bounded multiplier on his TD intensity.
//   raw   = sum over patterns of  relWeight x log(shrunk share / overall share) x (league share of TDs scored on that kind
//           of drive) x context   (strong 1, moderate 0.5; "worth watching" items never enter)
//   context: red-zone / goal-to-go patterns x the opponent's shrunk red-zone (goal-to-go) TD rate allowed and how often his
//           position scores against it there; opening-script / 1st-2nd drive patterns x opponent's opening-drive TD rate;
//           leading / trailing second-half patterns x P(lead) from the spread; late drive numbers x expected drives.
//   logm  = clamp(weight x raw, +-log 1.10)   ->  lambda x exp(logm)  (at most +-10% of lambda)
// The weight is fitted walk-forward (scripts/drives/adjust-fit.mjs). The ACTIVE model uses weight 0 unless the weekly gate
// promotes the "blend + drives" challenger; the challenger applies the fitted weight to the 3-way blend.
export const DRIVE_CAP = Math.log(1.10);
export const DRIVES_KIND = 'blend3+drives';
export const REL_WEIGHT = { strong: 1, moderate: 0.5 };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
export const pLead = spread => Number.isFinite(spread) ? 0.5 * (1 + erf((-spread / 13.5) / Math.SQRT2)) : 0.5;
const ORD = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const rankTxt = (r, n = 32) => r == null ? null : (r <= n / 2 ? `${r === 1 ? 'the most' : `the ${ORD(r)}-most`}` : `${n - r + 1 === 1 ? 'the fewest' : `the ${ORD(n - r + 1)}-fewest`}`);
const POSN = { RB: 'running backs', WR: 'wide receivers', TE: 'tight ends', QB: 'quarterbacks', FB: 'fullbacks' };
// expected offensive drives for a team this week: average of its own drives per game and the drives its opponent allows
export function expectedDrives(off, def, league) {
  const a = off?.dpg, b = def?.dpg; if (a == null && b == null) return league?.dpg ?? null; return +(((a ?? league?.dpg ?? b) + (b ?? league?.dpg ?? a)) / 2).toFixed(1);
}
// Pattern terms for one player (weight-free). prow = drive file players[gsis]; def = drive file defense[opp]; D = whole file.
export function driveTerms(prow, { D = null, opp = null, team = null, pos = null, spread = null } = {}) {
  const L = D?.league || null, def = opp ? D?.defense?.[opp] || null : null, off = team ? D?.offense?.[team] || null : null;
  const xd = expectedDrives(off, def, L); const pl = pLead(spread); const items = [];
  pos = pos || prow?.pos || null;
  for (const t of prow?.patterns || []) {
    const rw = REL_WEIGHT[t.rel]; if (!rw || !(t.base > 0)) continue;
    const lift = clamp(t.shr / t.base, 0.25, 3), td = L?.tdShare?.[t.sub] ?? 0; let ctx = 1, why = null;
    if (t.sub === 'rz' || t.sub === 'gtg') {
      const di = def?.idx?.[`${t.sub}Td`] ?? 1, pi = def?.posIdx?.[t.sub]?.[pos] ?? 1; ctx = clamp(di * pi, 0.6, 1.6);
      if (def) why = `${opp} allows ${rankTxt(def.rank?.[`${t.sub}Td`])} ${t.sub === 'rz' ? 'red-zone' : 'goal-to-go'} TDs per trip${def.posIdx?.[t.sub]?.[pos] != null ? `; ${POSN[pos] || pos} score ${Math.round((def.posShare?.[t.sub]?.[pos] ?? 0) * 100)}% of them (league ${Math.round((L?.posShare?.[t.sub]?.[pos] ?? 0) * 100)}%)` : ''}`;
    } else if (t.sub === 'open' || t.sub === 'd1' || t.sub === 'd2') {
      ctx = clamp(def?.idx?.openTd ?? 1, 0.6, 1.6); if (def) why = `${opp} allows ${rankTxt(def.rank?.openTd)} opening-script TDs`;
    } else if (t.sub === 'lead2H') { ctx = 2 * pl; why = `P(leading) ${Math.round(pl * 100)}% from the spread`; }
    else if (t.sub === 'trail2H') { ctx = 2 * (1 - pl); why = `P(trailing) ${Math.round((1 - pl) * 100)}% from the spread`; }
    else if (/^d(\d+)$/.test(t.sub) && +t.sub.slice(1) >= 8 && xd != null && L?.dpg) { const n = +t.sub.slice(1); ctx = clamp((xd - n + 1) / Math.max(0.5, L.dpg - n + 1), 0.3, 2); why = `${xd} expected drives`; }
    const raw = rw * Math.log(lift) * td * ctx;
    items.push({ sub: t.sub, metric: t.metric, rel: t.rel, lift: +lift.toFixed(3), tdShare: +td.toFixed(3), ctx: +ctx.toFixed(3), raw, text: t.text, why });
  }
  return { items, raw: items.reduce((a, x) => a + x.raw, 0), expDrives: xd, pLead: pl };
}
export function driveMultiplier(terms, weight) {
  const w = Number.isFinite(weight) ? weight : 0; const want = w * (terms?.raw || 0); const logm = clamp(want, -DRIVE_CAP, DRIVE_CAP) || 0; // never -0
  const items = (terms?.items || []).map(x => ({ ...x, logm: terms.raw ? logm * x.raw / terms.raw : 0 }));
  return { weight: w, raw: terms?.raw || 0, logm, mult: Math.exp(logm), capped: Math.abs(want) > DRIVE_CAP, items };
}
export const applyToChance = (p, logm) => (p > 0 && logm) ? 1 - Math.pow(1 - Math.min(0.999, p), Math.exp(logm)) : p;
export const driveRow = (D, p) => D?.players ? (D.players[p.gsis] || D.players[D.bySleeper?.[p.id]] || null) : null;
// Full adjustment for an engine/app player object. weight: the weight to apply; returns null when the file is missing.
export function driveAdjustFor(D, p, { opp = null, spread = null, weight = 0 } = {}) {
  if (!D) return null; const row = driveRow(D, p); const T = driveTerms(row, { D, opp, team: p.team, pos: p.pos, spread });
  const M = driveMultiplier(T, weight); return { ...M, expDrives: T.expDrives, pLead: T.pLead, opp, hasPatterns: T.items.length > 0 };
}
// Compact (snapshot / UI) form
export function compactDrive(a, before = null) {
  if (!a) return null; const r = x => Math.round(x * 10000) / 10000;
  return { w: r(a.weight), raw: r(a.raw), logm: r(a.logm), pct: r(a.mult - 1), capped: a.capped || undefined, expDrives: a.expDrives, opp: a.opp,
    ...(before != null ? { before: r(before), after: r(applyToChance(before, a.logm)) } : {}),
    items: a.items.map(x => ({ sub: x.sub, rel: x.rel, lift: x.lift, tdShare: x.tdShare, ctx: x.ctx, raw: r(x.raw), logm: r(x.logm), text: x.text, why: x.why })) };
}
