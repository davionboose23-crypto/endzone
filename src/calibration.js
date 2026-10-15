// Held-out calibration (endzone-4.2): team TD budget from implied points and volume band recalibration.
// Fits are produced walk-forward by scripts/hist/ship-fits.mjs; each entry uses only games before (season, week).
import FITS from './calibration-fits.json' with { type: 'json' };
// team TD budget: least squares of actual skill-player rush+rec TDs per team-game on implied points
export function fitBudget(rows) {
  const m = new Map(); for (const r of rows) { const k = r.gameId + r.side; const o = m.get(k) || { td: 0, imp: r.implied }; o.td += r.td; m.set(k, o); }
  const v = [...m.values()].filter(o => o.imp > 0); if (v.length < 100) return null;
  const mx = v.reduce((a, o) => a + o.imp, 0) / v.length, my = v.reduce((a, o) => a + o.td, 0) / v.length;
  const b = v.reduce((a, o) => a + (o.imp - mx) * (o.td - my), 0) / v.reduce((a, o) => a + (o.imp - mx) ** 2, 0);
  return { a: my - b * mx, b, n: v.length };
}
export const THR = { rushYd: 25, rec: 2, recYd: 25, passYd: 150 };
const tierOf = (m, mean) => (mean >= THR[m] ? 'hi' : 'lo');
const ks = []; for (let k = 0.5; k <= 3.001; k += 0.05) ks.push(+k.toFixed(2));
const cs = []; for (let c = 0.85; c <= 1.201; c += 0.01) cs.push(+c.toFixed(2));
export function fitVolCal(rows) {
  const out = {};
  for (const m of Object.keys(THR)) for (const t of ['lo', 'hi']) {
    const rs = rows.filter(x => x.volume[m] && x.actualVol[m] != null && (m !== 'passYd' || x.pos === 'QB') && tierOf(m, x.volume[m].mean) === t);
    if (rs.length < 150) continue;
    let best = 1, bm = Infinity;
    for (const c of cs) { const e = rs.reduce((a, x) => a + Math.abs(c * x.volume[m].mean - x.actualVol[m]), 0); if (e < bm - 1e-9) { bm = e; best = c; } }
    // the (1-cov) target: 10% below, 10% above
    const pick = side => { let bk = 1, bd = Infinity; for (const k of ks) { const miss = rs.filter(x => { const mu = best * x.volume[m].mean; return side === 'lo' ? x.actualVol[m] < Math.max(0, mu - k * best * (x.volume[m].mean - x.volume[m].lo)) : x.actualVol[m] > mu + k * best * (x.volume[m].hi - x.volume[m].mean); }).length / rs.length; const d = Math.abs(miss - 0.10); if (d < bd) { bd = d; bk = k; } } return bk; };
    out[`${m}.${t}`] = { c: best, kLo: pick('lo'), kHi: pick('hi'), n: rs.length };
  }
  return out;
}
export function applyVolCal(cal, m, v) {
  const f = cal && cal[`${m}.${tierOf(m, v.mean)}`]; if (!f) return v;
  const mu = f.c * v.mean;
  return { mean: mu, lo: Math.max(0, mu - f.kLo * f.c * (v.mean - v.lo)), hi: mu + f.kHi * f.c * (v.hi - v.mean) };
}

// Latest shipped fit usable for (season, week): trained only on games before it.
export function fitFor(season, week) {
  const ok = (FITS.fits || []).filter(f => f.season < season || (f.season === season && f.week <= week));
  if (!ok.length) return null; const f = ok.sort((a, b) => a.season - b.season || a.week - b.week).at(-1);
  return { ...f, id: `${f.season}-w${f.week}` };
}

// ---- endzone-4.3 data-fit safety caps (user-approved override of spec §11 fixed values) ----
// rows: graded rows produced under the FIXED caps, with preSafety, chance, finisher flags, secondOption, y.
// The team-budget scale each row received is held fixed (r = λ(final)/λ(post-cap)), then each cap value is
// chosen by coordinate descent on log loss of the re-mapped chance, shrunk toward the fixed value by n/(n+K).
import { FIXED_CAPS, CAP_LIMITS, sanitizeCaps, safetyCalibrate } from './model.js';
const lam = p => -Math.log(1 - Math.min(0.999, Math.max(0, p)));
export function capRemap(rows, caps) {
  return rows.map(r => {
    const ctx = { insideFinisher: r.insideFinisher, recentFinisher: r.recentFinisher, coldGoal: r.coldGoal };
    const post0 = Math.max(safetyCalibrate(r.preSafety, ctx).chance, r.secondOption ? FIXED_CAPS.floor : 0);
    const k = lam(post0) > 0 ? lam(r.chance) / lam(post0) : 1;
    const post1 = Math.max(safetyCalibrate(r.preSafety, ctx, caps).chance, r.secondOption ? caps.floor : 0);
    return 1 - Math.exp(-k * lam(post1));
  });
}
const LL = (rows, q) => { let s = 0; for (let i = 0; i < rows.length; i++) { const p = Math.min(1 - 1e-6, Math.max(1e-6, q[i])); s -= rows[i].y ? Math.log(p) : Math.log(1 - p); } return s; };
export function capGroups(rows) {
  const g = { pullT: 0, pullS: 0, ceil: 0, cold: 0, fin: 0, floor: 0 };
  for (const r of rows) { const q = r.preSafety; if (q == null) continue;
    if (!r.insideFinisher && q >= 0.35 && q <= 0.5) { g.pullT++; g.pullS++; }
    if (q > 0.45 && !r.recentFinisher && !r.coldGoal) g.ceil++; if (q > 0.4 && r.coldGoal && !r.recentFinisher) g.cold++; if (q > 0.55 && r.recentFinisher) g.fin++; if (r.secondOption) g.floor++; }
  return g;
}
export function fitCaps(rowsAll, { K = 200, sweeps = 3 } = {}) {
  const rows = rowsAll.filter(r => r.preSafety != null && r.chance != null);
  if (rows.length < 1000) return null;
  let c = { ...FIXED_CAPS };
  const grid = k => { const [lo, hi] = CAP_LIMITS[k]; const st = k === 'pullS' ? 0.05 : 0.01; const a = []; for (let v = lo; v <= hi + 1e-9; v += st) a.push(+v.toFixed(3)); return a; };
  for (let s = 0; s < sweeps; s++) for (const k of Object.keys(FIXED_CAPS)) {
    let best = c[k], bv = LL(rows, capRemap(rows, sanitizeCaps(c)));
    for (const v of grid(k)) { const t = sanitizeCaps({ ...c, [k]: v }); const l = LL(rows, capRemap(rows, t)); if (l < bv - 1e-9) { bv = l; best = v; } }
    c[k] = best;
  }
  const n = capGroups(rows); const out = {};
  for (const k of Object.keys(FIXED_CAPS)) out[k] = +(FIXED_CAPS[k] + (n[k] / (n[k] + K)) * (c[k] - FIXED_CAPS[k])).toFixed(4);
  return { ...sanitizeCaps(out), raw: c, n, rows: rows.length };
}
