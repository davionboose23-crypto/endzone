// ENDZONE simulator worker (app 4.9.0; 4.9.1 adds the drive-N / TD-pattern arrays; 4.9.2 free team-style mode via inputs.mode;
// 4.10.0 play-by-play mode: inputs.mode === 'pbp' runs src/sim-pbp.js in chunks, posting {progress} messages with a live partial
// read-out, then the summary; {replay: g} re-plays one game of the last pbp run with every play logged).
import { runSim, summarize } from './sim.js';
import { calibratePbp, pbpRunner, finish, summarizePbp, pbpPartial, replayGame } from './sim-pbp.js';
let last = null; // { id, E, seed } of the last play-by-play run (for "Open a sample game")
const rawOf = S => ({ n: S.n, seed: S.seed, NP: S.NP, base: S.base, P: S.P, G: S.G, H: S.H, slotN: S.slotN, slotR: S.slotR, score: S.score, half: S.half, drives: S.drives, tds: S.tds, firstTd: S.firstTd, ot: S.ot, q4trail: S.q4trail, firstScore: S.firstScore, kick: S.kick, gRes: S.gRes, ftdTeam: S.ftdTeam, slotPlays: S.slotPlays, slotYds: S.slotYds, tdAgg: S.tdAgg, logs: [] });
const CHUNK = 250, PART_EVERY = 1000;
self.onmessage = e => {
  const { id, inputs, n = 10000, seed = 1, replay = null } = e.data || {};
  try {
    if (replay != null) { if (!last) throw new Error('no play-by-play run to replay'); self.postMessage({ id, ok: true, replay: { g: replay, seed: last.seed, log: replayGame(last.E, last.seed, replay) } }); return; }
    const t0 = Date.now();
    if (inputs?.mode === 'pbp') {
      self.postMessage({ id, progress: { done: 0, n, phase: 'pilot' } });
      const { E, pilots } = calibratePbp(inputs, { pilots: 2, n: 800, seed: seed + 9 }); const tp = Date.now();
      const R = pbpRunner(inputs, { n, seed, E }); let nextPart = PART_EVERY;
      while (!R.run(CHUNK)) { const done = R.W.done; const msg = { id, progress: { done, n, phase: 'run' } }; if (done >= nextPart) { msg.partial = pbpPartial(R.W, inputs); nextPart += PART_EVERY; } self.postMessage(msg); }
      const S = finish(R.W, R.E); S.pilot = pilots; S.ms = { pilot: tp - t0, sim: Date.now() - tp }; const sum = summarizePbp(S, inputs); last = { id, E: R.E, seed };
      const raw = rawOf(S); const tr = [...Object.values(S.G).map(a => a.buffer), S.H.buffer, S.gRes.buffer];
      self.postMessage({ id, ok: true, ms: Date.now() - t0, msPilot: tp - t0, sum, raw }, tr); return;
    }
    const S = runSim(inputs, { n, seed }); const sum = summarize(S, inputs); const ms = Date.now() - t0;
    const raw = rawOf(S); const tr = [...Object.values(S.G).map(a => a.buffer), S.H.buffer, S.gRes.buffer];
    self.postMessage({ id, ok: true, ms, sum, raw }, tr);
  } catch (err) { self.postMessage({ id, ok: false, error: String(err && err.stack || err) }); }
};
