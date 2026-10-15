// Quarterback passing-TD expectation: the other side of the team's finalized
// receiving-score intensities, split by projected pass-attempt share.
import { poissonInterval } from './model.js';
export function allocatePassingTd(qbs, teamReceivingLambda) {
  const totAtt = qbs.reduce((s, q) => s + Math.max(0, q.vol.att), 0);
  for (const q of qbs) {
    const share = totAtt > 0 ? Math.max(0, q.vol.att) / totAtt : 0;
    const exp = teamReceivingLambda * share;
    const [lo, hi] = poissonInterval(exp);
    q.passTd = { expected: exp, display: exp.toFixed(1), interval: [lo, hi], attemptShare: share, teamReceivingLambda, ...passTdConfidence(q, share, teamReceivingLambda) };
  }
}
export function passTdConfidence(q, share, teamRec) {
  const recent = q.f.last3.filter(g => g.att > 0).length;
  const seasonAtt = q.f.games.reduce((s, g) => s + g.att, 0);
  const reasons = [];
  const ok = { recent: recent >= 3, att: seasonAtt >= 60, proj: q.vol.att >= 20, verified: q.verified === true, avail: !q.avail.uncertain };
  reasons.push(`${Math.round(share * 100)}% of projected team attempts (${q.vol.att.toFixed(1)}) × team receiving-score total ${teamRec.toFixed(2)}.`);
  if (!ok.recent) reasons.push(`Only ${recent} of the last three games with attempts.`);
  if (!ok.att) reasons.push(`${seasonAtt} attempts this season (needs 60).`);
  if (!ok.proj) reasons.push('Fewer than 20 projected attempts.');
  if (!ok.verified) reasons.push('Roster membership not verified.');
  if (!ok.avail) reasons.push('Availability uncertain.');
  const level = Object.values(ok).every(Boolean) ? 'Med' : 'Low';
  reasons.push('Provisional: passing-TD confidence is capped at Medium until prospectively validated.');
  return { level, provisional: true, reasons };
}
// Snapshots captured before this field existed must not be backfilled.
export function snapshotPassTd(pred) {
  if (!pred || pred.pos !== 'QB') return { display: '—', na: true };
  if (!pred.passTd) return { display: 'n/s', note: 'Not saved before kickoff', na: true };
  return pred.passTd;
}
