// endzone app 4.10.1: "a team can't score a TD on every drive". Both simulators (drive sim = default, play-by-play beta) are run on
// every week-8 2026 matchup and checked against real 2025-26 drives: league TD per drive, how often a team scores on 80%+ / 60%+
// of its drives in a game, 5+ / 6+ TD games, and a per-matchup ceiling. Also locks the drive-card wording (outcome mix first).
// Research / UI only: never feeds the board, the model or the challenger gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTable, tableToD } from '../scripts/sim/table.mjs';
import { buildSimInputs, runSim, summarize, driveCard } from '../src/sim.js';
import { buildPbpInputs, runPbp } from '../src/sim-pbp.js';
import { MODEL_VERSION } from '../src/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 8, SEASON = 2026, SLOTS = 16;
const snapDir = path.join(ROOT, 'archive', String(SEASON), `w${W}`);
const have = fs.existsSync(snapDir) && fs.existsSync(path.join(ROOT, 'archive', 'pbp', String(SEASON), `w${W}.json`));

// real drives: every 2025 team-game + 2026 before week 8 (fixed_drive order; kickoffs / PATs are never drive rows)
function realStats() {
  const rows = [];
  for (const [s, before] of [[2025, Infinity], [2026, W]]) {
    const T = loadTable(ROOT, s); const C = Object.fromEntries(T.cols.drives.map((c, i) => [c, i])); const tg = new Map();
    for (const d of T.drives) { if (!(d[C.week] < before)) continue; const k = `${d[C.game]}|${d[C.team]}`; (tg.get(k) || tg.set(k, []).get(k)).push(d); }
    for (const ds of tg.values()) { const td = ds.filter(d => d[C.result] === 'Touchdown').length; rows.push({ td, n: ds.length }); } }
  return summarizeRows(rows);
}
function summarizeRows(rows) {
  const N = rows.length, f = p => rows.filter(p).length / N; const td = rows.reduce((s, r) => s + r.td, 0), n = rows.reduce((s, r) => s + r.n, 0);
  return { N, tdPerDrive: td / n, r80: f(r => r.n && r.td / r.n >= 0.8), r60: f(r => r.n && r.td / r.n >= 0.6), g5: f(r => r.td >= 5), g6: f(r => r.td >= 6) };
}
const REAL = realStats();

const sims = [];
if (have) {
  const T = loadTable(ROOT, SEASON); const D = tableToD(T, { before: W }); const PP = JSON.parse(fs.readFileSync(path.join(ROOT, 'archive', 'pbp', String(SEASON), `w${W}.json`), 'utf8'));
  for (const f of fs.readdirSync(snapDir).filter(x => /^\d{4}_\d{2}_\w+_\w+\.json$/.test(x)).sort()) {
    const P = JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8')).latest?.payload; if (!P?.teams?.away) continue; const away = P.teams.away.team, home = P.teams.home.team;
    const side = t => { const k = t === away ? 'away' : 'home'; return { players: P.players.filter(p => p.team === t), opp: k === 'away' ? home : away, teamLambda: P.teams[k].teamLambda, tdBudget: P.teams[k].tdBudget }; };
    const In = buildSimInputs(D, { away, home, sideFor: side, gameId: f }); const Ip = buildPbpInputs(In, PP);
    sims.push({ game: `${away}@${home}`, teams: [away, home], In, drive: runSim(In, { n: 1500, seed: 41, mode: 'free' }), pbp: Ip ? runPbp(Ip, { n: 600, seed: 43 }) : null });
  }
}
function teamGames(S, k) { const out = []; for (let g = 0; g < S.n; g++) { const nd = S.drives[g * 2 + k]; let td = 0; for (let i = 0; i < Math.min(nd, SLOTS); i++) if (S.gRes[(g * 2 + k) * SLOTS + i] === 0) td++; out.push({ td, n: nd }); } return out; }

test('real 2025-26 drives: the yardstick the app quotes (23% TD per drive, no 80%+ TD-drive games)', () => {
  assert.ok(REAL.N > 700, `team-games ${REAL.N}`);
  assert.ok(Math.abs(REAL.tdPerDrive - 0.23) < 0.01, `real TD/drive ${REAL.tdPerDrive}`);
  assert.equal(REAL.r80, 0); assert.ok(REAL.r60 < 0.02);
  assert.equal(MODEL_VERSION, 'endzone-4.6.0');
});

for (const eng of ['drive', 'pbp']) {
  test(`${eng} sim: league TD per drive within 3 pts of real, 80%+ TD-drive games as rare as real, no matchup above the ceiling`, { skip: !have && 'no week-8 archive' }, () => {
    const all = []; const per = [];
    for (const s of sims) { const S = s[eng]; if (!S) continue; for (const k of [0, 1]) { const tg = teamGames(S, k); all.push(...tg); const r = summarizeRows(tg); per.push({ team: s.teams[k], game: s.game, ...r }); } }
    assert.ok(per.length >= 20, `team sides ${per.length}`);
    const L = summarizeRows(all);
    if (process.env.SIM_REALISM_LOG) console.log(JSON.stringify({ eng, games: sims.length, real: REAL, sim: L, maxTeam: per.reduce((m, p) => p.tdPerDrive > m.tdPerDrive ? p : m) }));
    assert.ok(Math.abs(L.tdPerDrive - REAL.tdPerDrive) <= 0.03, `${eng} TD/drive ${L.tdPerDrive.toFixed(4)} vs real ${REAL.tdPerDrive.toFixed(4)}`);
    assert.ok(L.r80 <= REAL.r80 + 0.002, `${eng} share of team-games with 80%+ TD drives ${L.r80} vs real ${REAL.r80}`);
    assert.ok(L.r60 <= Math.max(2 * REAL.r60, REAL.r60 + 0.01), `${eng} 60%+ ${L.r60} vs real ${REAL.r60}`);
    assert.ok(Math.abs(L.g5 - REAL.g5) <= 0.04 && L.g6 <= REAL.g6 + 0.02, `${eng} 5+ TDs ${L.g5} / 6+ ${L.g6} vs real ${REAL.g5} / ${REAL.g6}`);
    for (const p of per) {
      assert.ok(p.tdPerDrive <= 0.35, `${eng} ${p.team} in ${p.game}: ${p.tdPerDrive.toFixed(3)} TD per drive is above the 0.35 ceiling`);
      assert.ok(p.r80 <= 0.005, `${eng} ${p.team} in ${p.game}: TD on 80%+ of drives in ${p.r80} of games`);
    }
  });
}

test('drive cards lead with the outcome mix, not "scores a TD": every drive slot, most likely outcome first', { skip: !have && 'no week-8 archive' }, () => {
  const s = sims.find(x => x.game === 'CAR@GB') || sims[0]; const sum = summarize(s.drive, s.In);
  for (const k of [0, 1]) for (let slot = 0; slot < 12; slot++) {
    const c = driveCard(s.drive, sum, k, slot); if (!c.res) continue;
    assert.doesNotMatch(c.headline[0], /scores a TD on its/, c.headline[0]);
    assert.match(c.headline[0], / — most likely result: .+ \(\d+%\)\. All outcomes: /);
    const tot = c.mix.reduce((a, x) => a + x.p, 0); assert.ok(Math.abs(tot - 1) < 0.01, `mix sums to ${tot}`);
    assert.ok(c.mix.every((x, i) => !i || x.p <= c.mix[i - 1].p), 'mix sorted most likely first');
    assert.ok(c.res.TD < 0.4, `${c.team} ${c.dname} TD ${c.res.TD}`);
    assert.notEqual(c.mix[0].r, 'TD', `${c.team} ${c.dname}: a TD should never be the most likely result for a typical offense`);
    assert.match(c.headline[1], /^A TD on this drive: \d+% — about 1 in \d/);
  }
});
