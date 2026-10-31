// 4.16.0 paired walk-forward comparison: per-game top-4 hit diff and per-player log-loss diff with SEs (common random numbers: same seed, same games)
import fs from 'node:fs';
const [file, a = 'driveNew', b = 'driveV'] = process.argv.slice(2); const D = JSON.parse(fs.readFileSync(file, 'utf8'));
const ll = (p, y) => { p = Math.min(1 - 1e-4, Math.max(1e-4, p)); return -(y ? Math.log(p) : Math.log(1 - p)); };
const ms = x => { const n = x.length, m = x.reduce((s, v) => s + v, 0) / n; const v = x.reduce((s, q) => s + (q - m) ** 2, 0) / (n - 1); return [m, Math.sqrt(v / n)]; };
const f = ([m, s], d = 3) => `${m >= 0 ? '+' : ''}${m.toFixed(d)} ± ${s.toFixed(d)}`;
const out = {};
for (const S of ['B26', 'B25']) { const B = D[S]; if (!B) continue; const hits = k => g => (g.picks[k] || []).reduce((s, p) => s + p.hit, 0);
  const gh = B.games.filter(g => g.picks[a] && g.picks[b]).map(g => hits(b)(g) - hits(a)(g));
  // game-level clustered log-loss diff (players in a game are correlated)
  const byG = new Map(); for (const r of B.players) if (r.legacy && r[a] != null && r[b] != null) { const v = byG.get(r.gid) || { d: 0, n: 0, pos: {} }; const dd = ll(r[b], r.y) - ll(r[a], r.y); v.d += dd; v.n++; (v.pos[r.pos] ||= []).push(dd); byG.set(r.gid, v); }
  const G = [...byG.values()], N = G.reduce((s, v) => s + v.n, 0) / G.length; const llg = G.map(v => v.d / N);
  const pos = {}; for (const P of ['RB', 'WR', 'TE', 'QB']) { const x = G.map(v => (v.pos[P] || []).reduce((s, q) => s + q, 0)); const np = G.reduce((s, v) => s + (v.pos[P]?.length || 0), 0) / G.length; pos[P] = f(ms(x.map(q => q / np)), 4); }
  out[S] = { games: gh.length, top4HitsDiff: f(ms(gh)), logLossDiff: f(ms(llg), 4), byPos: pos }; }
console.log(JSON.stringify({ a, b, ...out }, null, 1));
