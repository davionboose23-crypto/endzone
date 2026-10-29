// app 4.10.0 — situation buckets shared by the play-level fit (scripts, Node) and the play-by-play engine (worker).
export const PBP_VERSION = 'pbp-1';
export const zoneOf = yl => yl >= 81 ? 0 : yl >= 41 ? 1 : yl >= 21 ? 2 : yl >= 11 ? 3 : yl >= 6 ? 4 : 5;
export const distB = t => t <= 2 ? 0 : t <= 6 ? 1 : t <= 10 ? 2 : 3;
export const uzOf = yl => yl > 20 ? 0 : yl > 10 ? 1 : yl > 5 ? 2 : 3; // player-usage zones
export const ucell = (yl, down) => uzOf(yl) * 2 + (down >= 3 ? 1 : 0); // 8 usage cells: zone x (downs 1-2 | 3-4)
// game script: 0 neutral, 1 protecting a lead late, 2 chasing late, 3 two-minute (end of 1st half, or trailing / tied at the end of the game)
export function scriptOf(qtr, hs, sd) {
  if (qtr <= 4 && hs <= 120 && (qtr <= 2 || sd <= 0)) return 3;
  if (qtr >= 4) { if (sd <= -9 || (hs <= 300 && sd < 0)) return 2; if (sd >= 9 || (hs <= 300 && sd > 0)) return 1; }
  return 0;
}
export const passCell = (down, togo, yl) => ((Math.min(4, Math.max(1, down)) - 1) * 4 + distB(togo)) * 6 + zoneOf(yl); // 96 cells
export const ylB10 = yl => Math.min(9, Math.max(0, Math.floor((yl - 1) / 10)));
export const togoB4 = t => t <= 1 ? 0 : t <= 3 ? 1 : t <= 6 ? 2 : 3;
export const NQ = 101; // quantiles per yards pool
