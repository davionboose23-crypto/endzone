// ENDZONE simulator worker (app 4.9.0): runs the pilot + N simulated games off the main thread and posts back the
// summary plus the raw per-game / per-drive arrays the UI needs for custom thresholds and per-drive tables.
import { runSim, summarize } from './sim.js';
self.onmessage = e => {
  const { id, inputs, n = 10000, seed = 1 } = e.data || {};
  try {
    const t0 = Date.now(); const S = runSim(inputs, { n, seed }); const sum = summarize(S, inputs); const ms = Date.now() - t0;
    const raw = { n: S.n, seed: S.seed, NP: S.NP, base: S.base, P: S.P, G: S.G, H: S.H, slotN: S.slotN, slotR: S.slotR, score: S.score, half: S.half, drives: S.drives, tds: S.tds, firstTd: S.firstTd, ot: S.ot, q4trail: S.q4trail, logs: [] };
    const tr = [...Object.values(S.G).map(a => a.buffer), S.H.buffer];
    self.postMessage({ id, ok: true, ms, sum, raw }, tr);
  } catch (err) { self.postMessage({ id, ok: false, error: String(err && err.stack || err) }); }
};
