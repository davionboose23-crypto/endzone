// Simulator calibration report: re-plays every archived pre-game snapshot (archive/<s>/w<w>/*.json) 10,000 times with that
// week's drive file and compares the sim to (a) the model it re-plays (per-player anytime TD, team TD budget λ, volume) and
// (b) history (nflverse 2025+2026 drives, points, spread of totals and margins). Writes archive/sim/calibration-<season>.json.
// Usage: node scripts/sim/calibrate.mjs [season] [n]
import fs from 'node:fs'; import path from 'node:path';
import { runSim, summarize, vsMarket, SIM_VERSION } from '../../src/sim.js'; import { snapInputs } from './snap.mjs';
const ROOT = new URL('../../', import.meta.url).pathname; const season = process.argv[2] || '2026'; const N = Number(process.argv[3] || 10000);
// history baselines (nflverse 2025+2026 regular season, 379 games; real 2026 drive file)
const HIST = { ptsPerTeam: 23.0, ptsSD: 9.8, totalSD: 13.9, homeMarginSD: 13.8, totalResidSDvsLine: 13.1, marginResidSDvsLine: 12.2, drivesPerTeam: 10.78, drivesSD: 1.73, tdPerTeam: 2.48, tdSD: 1.40 };
const sd = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
const avg = a => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const games = []; const gaps = []; const vol = { rec: [], recYd: [], car: [], rushYd: [] }; let ms = 0;
for (const w of fs.readdirSync(path.join(ROOT, 'archive', season)).filter(d => /^w\d+$/.test(d)).sort((a, b) => +a.slice(1) - +b.slice(1))) {
  const df = path.join(ROOT, 'archive', 'drives', season, `${w}.json`); if (!fs.existsSync(df)) continue; const D = JSON.parse(fs.readFileSync(df, 'utf8'));
  for (const f of fs.readdirSync(path.join(ROOT, 'archive', season, w)).filter(f => f.endsWith('.json')).sort()) {
    const r = snapInputs(path.join(ROOT, 'archive', season, w, f), D); if (!r) continue; const { I } = r;
    const t0 = Date.now(); const S = runSim(I, { n: N, seed: 1 }); ms += Date.now() - t0; const s = Object.assign(summarize(S, I), vsMarket(S, r.lines)); // display-only comparison after the run
    const sc = [], dr = [], td = [], tot = [], mar = []; for (let g = 0; g < S.n; g++) { sc.push(S.score[g * 2], S.score[g * 2 + 1]); dr.push(S.drives[g * 2], S.drives[g * 2 + 1]); td.push(S.tds[g * 2], S.tds[g * 2 + 1]); tot.push(S.score[g * 2] + S.score[g * 2 + 1]); mar.push(S.score[g * 2 + 1] - S.score[g * 2]); }
    for (const p of s.players) { if (p.model.chance >= 0.05) gaps.push({ g: f.replace('.json', ''), name: p.name, sim: p.anytime, model: p.model.chance, d: p.anytime - p.model.chance });
      for (const k of Object.keys(vol)) { const big = k === 'rec' ? 1.5 : k === 'car' ? 3 : 15; if (p.model[k] >= big) vol[k].push(p[k].mean / p.model[k] - 1); } }
    games.push({ game: f.replace('.json', ''), week: +w.slice(1), away: I.away, home: I.home, line: s.line,
      teams: [0, 1].map(k => ({ team: I.teams[k].team, lambda: +I.teams[k].teamLambda.toFixed(3), simTd: +s.team[k].mean.td.toFixed(3), drives: +s.team[k].mean.drives.toFixed(2), targetDrives: +I.targetDrives.toFixed(2), pts: +s.team[k].mean.pts.toFixed(2) })),
      winHome: +s.win.home.toFixed(4), total: { mean: +avg(tot).toFixed(2), sd: +sd(tot).toFixed(2) }, marginSD: +sd(mar).toFixed(2), ptsSD: +sd(sc).toFixed(2), drivesSD: +sd(dr).toFixed(2), tdSD: +sd(td).toFixed(2), ot: +(avg(Array.from(S.ot)) || 0).toFixed(4) });
  }
}
const T = games.flatMap(g => g.teams); const ad = gaps.map(x => Math.abs(x.d)); const worst = gaps.slice().sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5);
const lineTot = games.filter(g => g.line?.total != null);
const out = { simVersion: SIM_VERSION, season, sims: N, games: games.length, msPerGameNode: Math.round(ms / Math.max(1, games.length)), history: HIST,
  vsModel: { anytimePlayers: gaps.length, anytimeMeanAbsGap: +avg(ad).toFixed(4), anytimeMaxAbsGap: +Math.max(...ad).toFixed(4), anytimeMeanBias: +avg(gaps.map(x => x.d)).toFixed(4), worstAnytime: worst,
    teamTdOverLambda: { mean: +avg(T.map(t => t.simTd / t.lambda)).toFixed(4), min: +Math.min(...T.map(t => t.simTd / t.lambda)).toFixed(4), max: +Math.max(...T.map(t => t.simTd / t.lambda)).toFixed(4) },
    volumeRelGap: Object.fromEntries(Object.entries(vol).map(([k, a]) => [k, { n: a.length, meanAbs: +avg(a.map(Math.abs)).toFixed(4), bias: +avg(a).toFixed(4) }])),
    totalVsLine: lineTot.length ? { games: lineTot.length, meanSimMinusLine: +avg(lineTot.map(g => g.total.mean - g.line.total)).toFixed(2) } : null },
  vsHistory: { drivesPerTeam: +avg(T.map(t => t.drives)).toFixed(2), targetDrives: +avg(T.map(t => t.targetDrives)).toFixed(2), ptsPerTeam: +avg(T.map(t => t.pts)).toFixed(2), ptsSD: +avg(games.map(g => g.ptsSD)).toFixed(2), drivesSD: +avg(games.map(g => g.drivesSD)).toFixed(2), tdPerTeam: +avg(T.map(t => t.simTd)).toFixed(2), tdSD: +avg(games.map(g => g.tdSD)).toFixed(2), totalSD: +avg(games.map(g => g.total.sd)).toFixed(2), marginSD: +avg(games.map(g => g.marginSD)).toFixed(2), otRate: +avg(games.map(g => g.ot)).toFixed(4) },
  note: 'The sim is calibrated to the model (per-player λ and team TD budgets), so the vs-model rows test the plumbing, not the model. vs-history SDs are within-game sim spread; history SDs are across real games (the vs-line residual SDs are the fair comparison for a sim centred on the line).', games: games };
fs.mkdirSync(path.join(ROOT, 'archive', 'sim'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'archive', 'sim', `calibration-${season}.json`), JSON.stringify(out, null, 1));
const { games: _g, ...head } = out; console.log(JSON.stringify(head, null, 1));
