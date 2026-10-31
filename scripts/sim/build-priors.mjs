// app 4.15.0: pre-season priors for the live (model-free) drive sim, from REAL past games only (no betting-market columns,
// no model numbers). Writes archive/sim/sim-priors-<season>.json:
//   (4.18.0: the usage and ts blocks, built from last season, were removed: the sims read this season's data only)
//   ctx      ctx-1 Poisson fit of team points on home / rest difference / wind over this season's completed games (scores only)
//   games    this season's schedule context per game ("<week>:<away>@<home>": neutral site, roof, days of rest; wind when known)
// Usage: node scripts/sim/build-priors.mjs [--season 2026]
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { fitContext, contextRows, CTX_VERSION } from '../../src/game-context.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const S = +arg('--season', 2026);
const splitCsv = l => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
const csv = txt => { const L = txt.trim().split('\n'); const H = splitCsv(L[0]); return L.slice(1).map(l => { const a = splitCsv(l); return Object.fromEntries(H.map((h, i) => [h, a[i]])); }); };
const f = '/tmp/nflverse-games.csv';
if (!fs.existsSync(f)) { const r = await fetch('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'); if (!r.ok) throw new Error('games.csv ' + r.status); fs.writeFileSync(f, await r.text()); }
// only these columns are read from the schedule (the file also has spread / total / moneyline columns, which are never touched)
const KEEP = ['season', 'game_type', 'week', 'away_team', 'home_team', 'away_score', 'home_score', 'location', 'away_rest', 'home_rest', 'roof', 'wind'];
const rows = csv(fs.readFileSync(f, 'utf8')).map(o => Object.fromEntries(KEEP.map(k => [k, o[k]])));
// 4.18.0: this season only. No last-season usage or team-strength prior; ctx fit on this season's completed games (fitted once >= 100 games)
const through = rows.filter(o => +o.season === S && o.game_type === 'REG' && o.home_score !== '').reduce((m, o) => Math.max(m, +o.week), 0);
const ctx = { ...fitContext(contextRows(rows, [S], { before: through + 1 })), seasons: [S], through };
const games = {}; for (const o of rows) { if (+o.season !== S || o.game_type !== 'REG') continue; const num = v => v === '' || v === 'NA' || v == null ? null : +v;
  games[`${+o.week}:${o.away_team}@${o.home_team}`] = { neutral: o.location === 'Neutral', roof: o.roof || null, wind: num(o.wind), away: { rest: num(o.away_rest) }, home: { rest: num(o.home_rest) } }; }
const out = { version: 'sim-priors-2', season: S, built: new Date().toISOString().slice(0, 10), sources: 'nflverse schedule of ' + S + ' only (scores, site, rest, roof, wind)', ctx: { ...ctx, version: CTX_VERSION }, games };
const file = path.join(ROOT, 'archive', 'sim', `sim-priors-${S}.json`); fs.writeFileSync(file, JSON.stringify(out) + '\n');
console.log(file, (fs.statSync(file).size / 1024).toFixed(1) + ' KB', 'games', Object.keys(games).length, 'ctx', JSON.stringify(ctx.coef));
