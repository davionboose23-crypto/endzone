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
