// Identity, de-duplication, roster verification, availability, and photos.
const NORM = { LAR: 'LA', JAC: 'JAX', WSH: 'WAS', OAK: 'LV', SD: 'LAC', STL: 'LA', ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU', SL: 'LA' };
export function normTeam(t) { if (!t) return null; const u = String(t).trim().toUpperCase(); return NORM[u] || u; }
export function normName(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z0-9]/g, ''); }
export const SKILL = ['QB', 'RB', 'WR', 'TE', 'FB'];
const PLACEHOLDER = /^(player|test|placeholder|duplicate|tbd|unknown|dummy)\b|\btest\b|\bdo not use\b/i;
export const UNAVAILABLE = { Out: 'Out', IR: 'Injured reserve', PUP: 'PUP list', DNR: 'Did not report', Sus: 'Suspended', Suspended: 'Suspended', NA: 'Inactive', COV: 'Unavailable (illness list)', 'Inactive': 'Inactive', NFI: 'Non-football injury list' };

export function photoUrls(p) {
  return { sleeper: p.id && /^\d+$/.test(p.id) ? `https://sleepercdn.com/content/nfl/players/thumb/${p.id}.jpg` : null, espn: p.espn ? `https://a.espncdn.com/i/headshots/nfl/players/full/${p.espn}.png` : null, initials: initials(p.name) };
}
export function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join(''); }
export function teamLogo(team) { return team ? `https://sleepercdn.com/images/team_logos/nfl/${team.toLowerCase()}.png` : null; }

// Availability from injury + practice. historical=true ignores today's status (not known pregame).
export function availability(p, { historical = false } = {}) {
  if (historical) return { status: 'unknown', factor: 1, label: 'Pregame availability not archived', uncertain: true, excluded: false };
  const inj = p.injury || null, prac = String(p.practice || '').toLowerCase();
  if (inj && UNAVAILABLE[inj]) return { status: 'unavailable', factor: 0, label: UNAVAILABLE[inj], excluded: true };
  if (p.status && /injured reserve|inactive|suspend|physically unable/i.test(p.status)) return { status: 'unavailable', factor: 0, label: p.status, excluded: true };
  const dnp = /dnp|did not|^out$/.test(prac), limited = /limit/.test(prac), full = /full/.test(prac);
  if (inj === 'Doubtful') return { status: 'doubtful', factor: 1 / 3, label: 'Doubtful: about one-third of usual work', uncertain: true, doubtfulOrDnp: true };
  if (inj === 'Questionable') {
    if (dnp) return { status: 'questionable', factor: 1 / 3, label: 'Questionable, did not practice: about one-third of usual work', uncertain: true, doubtfulOrDnp: true };
    if (limited) return { status: 'questionable', factor: 2 / 3, label: 'Questionable, limited practice: about two-thirds of usual work', uncertain: true };
    if (full) return { status: 'questionable', factor: 1, label: 'Questionable, full practice: expected to play', uncertain: true };
    return { status: 'questionable', factor: 2 / 3, label: 'Questionable, practice report unavailable: about two-thirds of usual work', uncertain: true };
  }
  if (dnp && inj) return { status: 'questionable', factor: 1 / 3, label: `${inj}, did not practice`, uncertain: true, doubtfulOrDnp: true };
  return { status: 'available', factor: 1, label: inj ? String(inj) : 'Available', uncertain: false };
}

/**
 * Build the verified, de-duplicated skill-player identity set.
 * recentTeamWeeks: Map gsis -> [{week, team}] participation from current-season logs.
 */
export function buildIdentity({ players = [], roster = null, idmap = null, recentByGsis = new Map(), recentBySleeper = new Map(), currentWeek = 18 }) {
  const rejected = [], excluded = [], unverified = [];
  const rosterBySleeper = new Map(), rosterByGsis = new Map(), rosterByName = new Map();
  for (const r of roster || []) {
    if (r.sleeper) rosterBySleeper.set(String(r.sleeper), r);
    if (r.gsis) rosterByGsis.set(r.gsis, r);
    rosterByName.set(`${normName(r.name)}|${r.pos}|${r.team}`, r);
  }
  const idByGsis = new Map((idmap || []).map(r => [r.gsis, r]));
  const cands = [];
  for (const raw of players) {
    const p = { ...raw, team: normTeam(raw.team) };
    if (!p.id || !/^\d+$/.test(String(p.id)) || !p.name || PLACEHOLDER.test(p.name)) { rejected.push({ id: p.id, name: p.name || '(blank)', reason: 'Placeholder or test identity' }); continue; }
    if (!SKILL.includes(p.pos)) continue;
    if (!p.team) continue; // free agents are not on a team this week
    let rr = rosterBySleeper.get(String(p.id)) || (p.gsis && rosterByGsis.get(p.gsis)) || null;
    if (!rr) { // name match only when the entry is not attributed to a different identity
      const c = rosterByName.get(`${normName(p.name)}|${p.pos}|${p.team}`);
      if (c && (!c.sleeper || c.sleeper === String(p.id)) && (!c.gsis || !p.gsis || c.gsis === p.gsis)) rr = c;
    }
    if (!p.gsis && rr?.gsis) p.gsis = rr.gsis;
    if (!p.espn && rr?.espn) p.espn = String(rr.espn);
    const im = p.gsis ? idByGsis.get(p.gsis) : null;
    if (!p.espn && im?.espn) p.espn = String(im.espn);
    p.pfr = rr?.pfr || im?.pfr || null;
    p._roster = rr;
    cands.push(p);
  }
  // De-duplicate: GSIS, then ESPN, then normalized name + position.
  const score = p => (p.active ? 4 : 0) + (p.depth != null ? 2 : 0) + (p._roster ? 2 : 0) + (p.gsis ? 1 : 0);
  const kept = new Map(); const keyOf = new Map();
  const keys = p => [p.gsis && `g:${p.gsis}`, p.espn && `e:${p.espn}`, `n:${normName(p.name)}|${p.pos}`].filter(Boolean);
  for (const p of cands) {
    let dupOf = null;
    for (const k of keys(p)) if (keyOf.has(k)) { dupOf = keyOf.get(k); break; }
    if (dupOf) {
      const other = kept.get(dupOf);
      // name-only matches on different teams with different known GSIS are different people
      if (other.gsis && p.gsis && other.gsis !== p.gsis) { kept.set(p.id, p); keys(p).forEach(k => { if (!keyOf.has(k)) keyOf.set(k, p.id); }); continue; }
      const [win, lose] = score(p) > score(other) ? [p, other] : [other, p];
      rejected.push({ id: lose.id, name: lose.name, reason: `Duplicate feed entry of ${win.name} (${win.id})` });
      kept.delete(lose.id); kept.set(win.id, win);
      for (const k of [...keys(win), ...keys(lose)]) keyOf.set(k, win.id);
      continue;
    }
    kept.set(p.id, p); keys(p).forEach(k => keyOf.set(k, p.id));
  }
  const out = [];
  for (const p of kept.values()) {
    const rr = p._roster; delete p._roster;
    const recent = (p.gsis && recentByGsis.get(p.gsis)) || recentBySleeper.get(p.id) || [];
    const recentOnTeam = recent.filter(x => x.team === p.team && x.week >= currentWeek - 3);
    let verified = null, verifyReason = '';
    if (!roster) { verified = null; verifyReason = 'Roster verification feed unavailable: membership pending'; }
    else if (rr) {
      const st = rr.status || '';
      if (st === 'DEV') { rejected.push({ id: p.id, name: p.name, reason: `Practice squad on current nflverse roster (${rr.team})` }); continue; }
      if (['CUT', 'RET', 'UFA', 'TRD', 'TRC', 'E01', 'W03'].includes(st) || /retir|releas/i.test(rr.statusAbbr || '')) { rejected.push({ id: p.id, name: p.name, reason: `nflverse roster status ${st}${rr.statusAbbr ? ' / ' + rr.statusAbbr : ''}` }); continue; }
      if (st === 'RES') { p.rosterReserve = true; }
      if (rr.team === p.team) { verified = true; verifyReason = `On ${p.team} nflverse roster (week ${rr.week}, ${st || 'status n/a'})`; }
      else if (recentOnTeam.length) { verified = true; verifyReason = `Recent ${p.team} participation (week ${recentOnTeam[recentOnTeam.length - 1].week}); nflverse roster lists ${rr.team}`; }
      else if (rr.week < currentWeek - 1) { verified = false; verifyReason = `nflverse roster (week ${rr.week}) lists ${rr.team}; Sleeper lists ${p.team}. Membership pending.`; }
      else { verified = false; verifyReason = `Team conflict: nflverse ${rr.team} vs Sleeper ${p.team}`; }
    } else if (recentOnTeam.length) { verified = true; verifyReason = `Not matched on nflverse roster; recent ${p.team} participation confirms membership`; }
    else { verified = false; verifyReason = 'Not found on current nflverse roster and no recent participation: membership pending'; }
    if (verified !== true) unverified.push({ id: p.id, name: p.name, team: p.team, pos: p.pos, reason: verifyReason });
    p.verified = verified; p.verifyReason = verifyReason; p.photo = photoUrls(p);
    out.push(p);
  }
  return { players: out, rejected, excluded, unverified };
}
