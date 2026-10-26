// endzone app 4.8.1: drive-by-drive log and player-by-drive threshold table (pure helpers, shared by the app and tests).
// Team drive tuple (archive/drives/<s>/w<w>.json teams[T].games[].d[]):
//   [n, half, scoreDiff, flags, plays, result, tgt, car, [[playerIdx, tgt, rec, recYd, car, rushYd, rzTouches, td]], qtr, startYardline100]
export const STATS = {
  rec: { label: 'Receptions', unit: 'rec', fam: 'rec', v: x => x[2] },
  recYd: { label: 'Rec yds', unit: 'rec yds', fam: 'rec', v: x => x[3] },
  car: { label: 'Carries', unit: 'car', fam: 'rush', v: x => x[4] },
  rushYd: { label: 'Rush yds', unit: 'rush yds', fam: 'rush', v: x => x[5] },
  tch: { label: 'Touches', unit: 'touches', fam: 'tch', v: x => x[2] + x[4] }
};
export const PRESETS = [['rec', 1], ['rec', 2], ['recYd', 20], ['rushYd', 10], ['rushYd', 20]];
export const thLabel = (st, th) => `${th}+ ${STATS[st]?.unit || st}`;
const SFX = /^(Jr\.?|Sr\.?|II|III|IV|V)$/;
export function shortName(name) {
  const p = String(name || '').trim().split(/\s+/); if (p.length < 2) return p[0] || '';
  let last = p.slice(1); if (last.length > 1 && SFX.test(last[last.length - 1])) last = last.slice(0, -1);
  return last.join(' ');
}
export const personName = (D, T, i) => { const pe = T.people[i] || []; const nm = pe[1]; return nm && !/^\d\d-\d{7}$/.test(nm) ? nm : D?.players?.[pe[0]]?.name || 'Unlisted player'; };
export function ylText(yl, team, opp) {
  if (yl == null || !Number.isFinite(+yl)) return '—';
  return yl > 50 ? `${team} ${100 - yl}` : +yl === 50 ? 'midfield' : `${opp} ${yl}`;
}
// one player's line on one drive, e.g. "2 rec (3 tgt), 24 yds" / "3 car, 18 yds, TD"
export function statLine(x) {
  const rec = x[1] ? `${x[2]} rec (${x[1]} tgt), ${x[3]} yds` : ''; const rush = x[4] ? `${x[4]} car, ${x[5]} yds` : '';
  return `${rec}${rec && rush ? '; ' : ''}${rush}${x[7] ? ', TD' : ''}`;
}
export const driveLineText = (D, T, d) => d[8].slice().sort((a, b) => (b[2] + b[4]) - (a[2] + a[4]) || b[1] - a[1]).map(x => `${shortName(personName(D, T, x[0]))} ${statLine(x)}`).join(' · ');
// the cell text in the player table, by stat family
export function cellText(x, st) {
  if (!x) return '—'; const f = STATS[st].fam;
  if (f === 'rec') return x[1] ? `${x[2]} rec / ${x[3]} yds` : '—';
  if (f === 'rush') return x[4] ? `${x[4]} car / ${x[5]} yds` : '—';
  return x[2] + x[4] ? `${x[2] + x[4]} tch / ${x[3] + x[5]} yds` : (x[1] ? `0 tch (${x[1]} tgt)` : '—');
}
const famYds = (x, st) => { if (!x) return 0; const f = STATS[st].fam; return f === 'rec' ? x[3] : f === 'rush' ? x[5] : x[3] + x[5]; };
// rows = games (newest first) in which the player had at least one target or carry; skipped = team games he had none in
export function playerDriveRows(T, pid, games) {
  const pi = T.people.findIndex(p => p[0] === pid); if (pi < 0) return { pi, rows: [], skipped: games.length, maxN: 0 };
  const rows = []; let skipped = 0;
  for (const g of games.slice().reverse()) {
    const by = new Map(); for (const d of g.d) { const x = d[8].find(y => y[0] === pi); if (x) by.set(d[0], x); }
    if (!by.size) { skipped++; continue; }
    rows.push({ w: g.w, opp: g.opp, nDrives: g.d.length, drives: g.d, by });
  }
  return { pi, rows, skipped, maxN: Math.max(0, ...rows.map(r => r.nDrives)) };
}
export const meets = (x, st, th) => !!x && STATS[st].v(x) >= th;
// per drive number: games with that drive, hits, average family yards, plus the all-drives baseline
export function hitSummary(rows, st, th, maxN = Math.max(0, ...rows.map(r => r.nDrives))) {
  const out = [];
  for (let n = 1; n <= maxN; n++) {
    const G = rows.filter(r => r.nDrives >= n); const xs = G.map(r => r.by.get(n));
    const hits = xs.filter(x => meets(x, st, th)).length; const yds = xs.reduce((s, x) => s + famYds(x, st), 0);
    out.push({ n, games: G.length, hits, rate: G.length ? hits / G.length : null, avgYds: G.length ? yds / G.length : null });
  }
  let drives = 0, hits = 0, yds = 0;
  for (const r of rows) for (const d of r.drives) { drives++; const x = r.by.get(d[0]); if (meets(x, st, th)) hits++; yds += famYds(x, st); }
  return { byDrive: out, all: { drives, hits, rate: drives ? hits / drives : null, avgYds: drives ? yds / drives : null } };
}
// reliability label for drive n from the existing share tests (BH FDR + out-of-sample persistence); never invented here
export function driveLabel(P, n) {
  const sub = `d${n}`; const pat = (P?.patterns || []).find(t => t.sub === sub); if (pat) return { label: 'pattern', rel: pat.rel, text: pat.text, q: pat.q };
  const w = (P?.watch || []).find(t => t.sub === sub);
  return { label: 'small sample / likely chance', rel: 'chance', text: w ? w.text : null, q: w ? w.q : null };
}
