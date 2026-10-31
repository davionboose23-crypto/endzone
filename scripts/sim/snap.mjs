// helpers to turn an archived pre-game snapshot (archive/<s>/w<w>/<gameId>.json) into simulator inputs
import fs from 'node:fs';
import { buildSimInputs } from '../../src/sim.js';
export function snapInputs(file, D) {
  const P = JSON.parse(fs.readFileSync(file, 'utf8')).latest?.payload; if (!P?.teams?.away) return null;
  const A = P.teams.away.team, H = P.teams.home.team;
  const side = t => { const k = t === A ? 'away' : 'home'; return { players: P.players.filter(p => p.team === t), opp: t === A ? H : A, teamLambda: P.teams[k].teamLambda, tdBudget: P.teams[k].tdBudget }; };
  return { P, I: buildSimInputs(D, { away: A, home: H, sideFor: side, gameId: P.gameId }), lines: P.lines || null };
}
