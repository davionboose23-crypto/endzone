// ENDZONE UI (browser module). Heavy computation runs in the Web Worker.
import { fmtAmerican, DEFAULT_WEIGHTS, WEIGHT_RANGES, sanitizeWeights } from '/src/model.js';
import { STAGES, etDisplay, requestGate } from '/src/feeds.js';
import { sortPlayers, SORTS, compareDefault } from '/src/ranking.js';
import { teamLogo } from '/src/roster.js';
import { snapshotPassTd } from '/src/passing-touchdowns.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = (x, d = 0) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const n1 = x => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(1));
const n0 = x => (x == null || !Number.isFinite(x) ? '—' : Math.round(x).toString());
const LS = { weights: 'endzone.weights.v2', lessons: 'endzone.lessons.v2', watch: 'endzone.watchlist.v1', board: 'endzone.board.v1', auto: 'endzone.autorefresh.v1', view: 'endzone.view.v1' };
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } };

const S = { slate: null, tab: 'slate', week: null, season: null, gameId: null, panel: null, detail: null, reqId: 0, loading: false, token: null, backtest: null,
  weights: sanitizeWeights(load(LS.weights, DEFAULT_WEIGHTS)), watch: new Set(load(LS.watch, [])),
  board: Object.assign({ pos: 'ALL', q: '', game: '', hideLow: false, hideStarted: false, watchOnly: false, sort: 'default' }, load(LS.board, {})), auto: load(LS.auto, { enabled: false, minutes: 15 }),
  focus: load(LS.view, null) ?? window.matchMedia('(max-width:1023px)').matches };
const worker = new Worker('/src/worker.js', { type: 'module' });
let timers = [];

function send(type, extra = {}) { const reqId = ++S.reqId; worker.postMessage({ type, reqId, ...extra }); return reqId; }
const gate = requestGate(); let loadReq = 0;
function startLoad(force = false) {
  clearTimers(); S.loading = true;
  loadReq = gate.next(); S.reqId = loadReq - 1; send('load', { season: S.season, week: S.week, force, weights: S.weights, token: S.token });
  renderLoading({ stage: 0 }); status(force ? 'Refreshing…' : 'Loading…');
  timers.push(setTimeout(() => renderLoading({ tryAgain: true }), 20000));
  timers.push(setTimeout(() => { worker.postMessage({ type: 'cancel', reqId: loadReq }); S.loading = false; renderLoading({ timeout: true }); }, 50000));
}
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
let stageState = { current: 0 };
function renderLoading(o) {
  const el = $('#loading');
  if (o.stage != null) stageState.current = o.stage;
  if (!S.loading && !o.timeout) { el.hidden = true; return; }
  el.hidden = false;
  const cur = stageState.current;
  el.innerHTML = `<h2>${o.timeout ? 'This is taking too long' : S.slate ? 'Refreshing — your last slate stays usable' : 'Building this week’s slate'}</h2>
   ${o.timeout ? `<p>The data service did not finish within 50 seconds. The request was cancelled.${S.slate ? ' The last usable slate is still shown.' : ''}</p>` : '<p class="muted small">First open can take about a minute.</p>'}
   <ol class="stages">${STAGES.map((s, i) => `<li class="stage ${i + 1 < cur ? 'done' : i + 1 === cur ? 'active' : ''}">${i + 1 < cur ? '✓' : i + 1 === cur ? '●' : '○'} ${s}</li>`).join('')}</ol>
   ${o.tryAgain || o.timeout ? `<div class="row"><button class="btn gold" data-act="retry">Try again</button>${o.timeout ? '<button class="btn" data-act="dismiss">Dismiss</button>' : ''}</div>` : ''}`;
}
worker.onmessage = ev => {
  const m = ev.data;
  if (m.type === 'stage') { if (m.reqId !== loadReq) return; if (!m.done) renderLoading({ stage: m.stage }); return; }
  if (m.type === 'slate') {
    if (!gate.isCurrent(m.reqId) && !m.recalculated) return; // stale worker response cannot replace newer request
    if (m.recalculated && m.reqId !== recalcReq) return;
    clearTimers(); S.loading = false; $('#loading').hidden = true;
    const y = window.scrollY; S.slate = m; S.season = m.season; S.week = m.week;
    if (m.lessons) save(LS.lessons, m.lessons);
    renderAll(); window.scrollTo(0, y);
    status(`${m.stale ? `<span class="warn">Showing last successful data (${esc(m.staleSince)}): ${esc(m.error)}</span>` : 'Updated'} · data ${new Date(m.generatedAt).toLocaleString()} · ${partialNote(m.sources)}`);
    if (S.panel) openPlayer(S.panel.gameId, S.panel.playerId, true);
    return;
  }
  if (m.type === 'detail') { if (!S.panel || m.playerId !== S.panel.playerId) return; S.detail = m.detail; renderPanel(); return; }
  if (m.type === 'threshold') { const el = $('#thrOut'); if (el) el.innerHTML = m.result.games ? `${m.result.hits} of ${m.result.games} earlier games (${pc(m.result.frequency)}) reached ${m.result.threshold}. <em>${esc(m.result.label)}.</em>` : 'No earlier games.'; return; }
  if (m.type === 'backtest') { S.backtest = m; if (S.tab === 'lab') renderLab(); return; }
  if (m.type === 'auth') { clearTimers(); S.loading = false; const t = prompt('This private service needs an access token (kept in memory only):'); if (t) { S.token = t; startLoad(); } return; }
  if (m.type === 'cancelled') return;
  if (m.type === 'error') { if (m.reqId !== loadReq && S.slate) return; clearTimers(); S.loading = false; $('#loading').hidden = false; $('#loading').innerHTML = `<h2>Could not load the slate</h2><p class="err">${esc(m.error)}</p><button class="btn gold" data-act="retry">Try again</button>`; status(`<span class="err">Load failed</span>`); }
};
const partialNote = src => { const bad = Object.values(src || {}).filter(s => !s.ok); const stale = Object.values(src || {}).filter(s => s.stale); return `${bad.length ? `<span class="warn">${bad.length} feed(s) unavailable</span>` : 'all feeds ok'}${stale.length ? ` · ${stale.length} stale` : ''}`; };
function status(html) { $('#status').innerHTML = html; }

// ---------- shared render helpers
function photo(p) {
  const ph = p.photo || {};
  const src = ph.sleeper || ph.espn;
  return src ? `<img class="photo" alt="" src="${esc(src)}" data-espn="${esc(ph.espn || '')}" data-initials="${esc(ph.initials || '')}" loading="lazy">` : `<span class="photo" aria-hidden="true">${esc(ph.initials || '?')}</span>`;
}
document.addEventListener('error', e => {
  const t = e.target; if (t.tagName !== 'IMG') return;
  if (t.classList.contains('photo')) { if (t.dataset.espn && t.src !== t.dataset.espn) { t.src = t.dataset.espn; t.dataset.espn = ''; } else { const s = document.createElement('span'); s.className = 'photo'; s.textContent = t.dataset.initials || '?'; s.setAttribute('aria-hidden', 'true'); t.replaceWith(s); } }
  else if (t.classList.contains('logo')) { const s = document.createElement('span'); s.className = 'chip'; s.textContent = t.alt; t.replaceWith(s); }
}, true);
const logo = t => `<img class="logo" alt="${esc(t)}" src="${esc(teamLogo(t))}">`;
const chip = (lvl, label) => `<span class="chip ${esc(lvl)}">${label ? esc(label) + ' ' : ''}${lvl === 'High' ? 'High' : lvl === 'Med' ? 'Med' : 'Low'}</span>`;
const highBadge = p => (p.tdConf?.level === 'High' ? '<span class="badge-high">HIGH TD</span>' : '');
const allPlayers = () => (S.slate?.games || []).flatMap(g => ['away', 'home'].flatMap(s => g.sides[s].players.map(p => ({ ...p, gameId: g.id, started: g.started, frozen: g.frozen, opp: g.sides[s].opp }))));
const findPlayer = (gid, pid) => { const g = S.slate.games.find(x => x.id === gid); for (const s of ['away', 'home']) { const p = g?.sides[s].players.find(x => x.id === pid); if (p) return { g, s, p }; } return null; };
// User-requested (overrides spec §12/§15): passing stats appear only on QB rows, not as all-dash columns.
const qbLine = p => p.pos === 'QB' ? `<div class="qbline small"><span><strong>Pass TD</strong> ${passTdCell(p)}</span> <span><strong>Pass yds</strong> ${volCell(p, 'passYd')}</span></div>` : '';
function passTdCell(p) { if (p.pos !== 'QB') return '—'; const t = snapshotPassTd(p); if (t.na) return esc(t.note || t.display); return `${t.display} <span class="muted small">(${t.interval[0]}–${t.interval[1]})</span> ${chip(t.level)}`; }
function volCell(p, m) { const v = p.volume?.[m]; if (!v) return '—'; return `${m === 'rec' ? n1(v.mean) : n0(v.mean)} <span class="muted small">${m === 'rec' ? n1(v.lo) : n0(v.lo)}–${m === 'rec' ? n1(v.hi) : n0(v.hi)}</span> ${chip(p.volConf?.[m]?.level)}`; }
const playerBtn = (p, gid) => `<button class="plink" data-act="player" data-game="${esc(gid)}" data-player="${esc(p.id)}">${photo(p)}<span>${esc(p.name)} <span class="muted small">${esc(p.pos)} · ${esc(p.team)}${p.injury ? ` · <span class="warn">${esc(p.injury)}</span>` : ''}</span> ${highBadge(p)}</span></button>`;

function renderAll() {
  renderControls();
  if (S.tab === 'slate') renderSlate(); else if (S.tab === 'board') renderBoard(); else renderLab();
}
function renderControls() {
  $('#seasonLabel').textContent = S.slate ? `${S.slate.season} season` : '';
  $('#weekSelect').innerHTML = Array.from({ length: 18 }, (_, i) => `<option value="${i + 1}" ${S.week === i + 1 ? 'selected' : ''}>Week ${i + 1}${S.slate?.currentWeek === i + 1 ? ' (current)' : ''}</option>`).join('');
  $('#prevWeek').disabled = S.week <= 1; $('#nextWeek').disabled = S.week >= 18;
}

// ---------- Results vs predicted (finished games)
const VOLLBL = { rushYd: 'Rush yds', recYd: 'Rec yds', rec: 'Catches', passYd: 'Pass yds' };
const resLabel = R => `<span class="chip ${R.prospective ? 'high' : ''}">${R.prospective ? 'Prospective' : 'Reconstructed'}</span>`;
function resultsSummaryLine(g) {
  const R = g.results; if (!R) return ''; const m = R.summary;
  return `<div class="small results-line">${resLabel(R)} Results: ${m.actualTd} TDs vs ${n1(m.expectedTd)} expected · team calls ${m.teamCalls.hits}/${m.teamCalls.total} · Brier ${m.brier == null ? '—' : m.brier.toFixed(3)} · yardage in 80% range ${m.rangeHits}/${m.rangeTotal}</div>`;
}
function resultsTable(g) {
  const R = g.results; if (!R) return '';
  const rows = R.rows.filter(r => r.chance != null).sort((a, b) => b.chance - a.chance);
  const vcell = v => (v ? `<span class="${v.inRange ? '' : 'warn'}">${Math.round(v.actual)} <span class="muted">vs ${n1(v.pred)} (${n1(v.lo)}–${n1(v.hi)})</span> ${v.inRange ? '✓' : '✗'}</span>` : '—');
  return `<div class="card" id="results"><h2>Results vs predicted</h2><p class="small">${esc(R.label)}. ${R.prospective ? 'These are the frozen pregame numbers; they never change after kickoff.' : 'No pregame snapshot was captured for this game, so these numbers were rebuilt from earlier weeks and are not evidence of prospective accuracy.'}</p>
   ${resultsSummaryLine(g)}
   <p class="small">${['away', 'home'].map(s => `${esc(R.summary.teams[s].team)}: ${R.summary.teams[s].actualTd} TDs vs ${n1(R.summary.teams[s].expectedTd)} expected`).join(' · ')}${R.summary.missing ? ` · ${R.summary.missing} players without a stat or snap record excluded` : ''}</p>
   <div class="reswrap" tabindex="0" role="region" aria-label="Results vs predicted"><table class="restable"><thead><tr><th scope="col">Player</th><th scope="col">Anytime (pregame)</th><th scope="col">TD</th><th scope="col">Rush yds</th><th scope="col">Rec yds</th><th scope="col">Catches</th></tr></thead><tbody>
   ${rows.map(r => `<tr class="${r.scored ? 'high' : ''}"><td>${esc(r.name)} <span class="muted small">${esc(r.pos)}</span>${r.teamCall ? ' <span class="chip">team call</span>' : ''}${r.pos === 'QB' ? `<div class="small">Passing: ${vcell(r.vol.passYd)} yds · TDs ${r.passTd?.actual ?? '—'} vs ${r.passTd?.pred == null ? '—' : r.passTd.pred.toFixed(1)}</div>` : ''}</td><td class="mid">${pc(r.chance)}</td><td>${r.scored ? `<strong>Yes${r.td > 1 ? ` ×${r.td}` : ''}</strong>` : 'No'}</td><td>${vcell(r.vol.rushYd)}</td><td>${vcell(r.vol.recYd)}</td><td>${vcell(r.vol.rec)}</td></tr>`).join('')}</tbody></table></div></div>`;
}
function resultsWeekHtml() {
  const W = S.slate.weekResults; const done = S.slate.games.filter(g => g.results);
  const grp = (k, x) => x.n ? `<p class="small"><strong>${k}</strong>: ${x.n} players · ${x.actualTd} TDs vs ${n1(x.expectedTd)} expected · team calls ${x.calls.hits}/${x.calls.total} · Brier ${x.brier.toFixed(3)}</p>` : `<p class="small muted">${k}: none</p>`;
  return `<div class="card"><h2>Results — week ${S.slate.week}</h2>${done.length ? `${grp('Prospective (frozen pregame snapshots)', W.prospective)}${grp('Reconstructed (no pregame snapshot; not prospective evidence)', W.reconstructed)}` : '<p class="small muted">No finished games this week yet.</p>'}</div>
   ${done.map(g => `<button class="game" data-act="game" data-game="${esc(g.id)}"><div class="row between"><strong>${esc(g.sides.away.team)} ${g.game.awayScore} @ ${esc(g.sides.home.team)} ${g.game.homeScore}</strong><span class="small muted">Final</span></div>${resultsSummaryLine(g)}</button>`).join('')}`;
}
// ---------- Slate
function gameCard(g) {
  const k = etDisplay(g.game.kickoff); const a = g.sides.away, h = g.sides.home; const L = a.lines;
  const call = side => { const s = g.sides[side]; const p = s.players.find(x => x.id === s.call?.id); return p ? `<div class="row small">${photo(p)}<span><strong>${esc(p.name)}</strong> ${pc(p.chance)} ${chip(p.tdConf.level, 'TD')}</span></div>` : '<span class="muted small">No eligible call</span>'; };
  return `<button class="game ${[a, h].some(s => s.players.find(p => p.id === s.call?.id)?.tdConf.level === 'High') ? 'high' : ''}" data-act="game" data-game="${esc(g.id)}" aria-current="${S.gameId === g.id}">
    <div class="row between small muted"><span>${esc(k.day)} ${esc(k.date || '')} · ${esc(k.time)}</span><span>${esc(g.game.stadium || '')}</span></div>
    <div class="row between"><span class="row">${logo(a.team)}<strong class="mid">${esc(a.team)}</strong> ${g.game.finished ? `<span class="mid">${g.game.awayScore}</span>` : ''}</span><span class="muted">@</span><span class="row">${g.game.finished ? `<span class="mid">${g.game.homeScore}</span>` : ''}<strong class="mid">${esc(h.team)}</strong>${logo(h.team)}</span></div>
    <div class="small muted">${L.known ? `${esc(a.team)} ${L.awaySpread > 0 ? '+' : ''}${L.awaySpread} · total ${L.total}` : '<span class="warn">Lines unknown (spread 0, total 44.5 used)</span>'} · implied ${n1(a.implied)}–${n1(h.implied)}</div>
    <div class="small">Model TDs ${n1(a.teamLambda)} vs budget ${n1(a.tdBudget)} · ${n1(h.teamLambda)} vs ${n1(h.tdBudget)}</div>
    <div class="grid" style="grid-template-columns:1fr 1fr">${call('away')}${call('home')}</div>
    <div class="small muted">${g.frozen === 'snapshot' ? 'Frozen pregame forecast' : g.frozen === 'reconstructed' ? 'Reconstructed (no pregame snapshot)' : ''}${g.game.finished ? ' · Final' : g.started ? ' · Started' : ''}</div>${resultsSummaryLine(g)}</button>`;
}
function renderSlate() {
  const v = $('#view-slate'); if (!S.slate) { v.innerHTML = ''; return; }
  const all = allPlayers(); const pick = all.find(p => p.id === S.slate.weeklyPickId); const riser = all.find(p => p.id === S.slate.riserId);
  const phoneOpen = S.gameId && window.matchMedia('(max-width:1023px)').matches;
  const list = `<div ${phoneOpen ? 'hidden' : ''}>
    ${pick ? `<div class="card ${pick.tdConf.level === 'High' ? 'high' : ''}"><div class="eyebrow">WEEKLY RECOMMENDED SCORER</div>${playerBtn(pick, pick.gameId)}<div class="row"><span class="big">${pc(pick.chance)}</span>${chip(pick.tdConf.level, 'TD confidence')}</div></div>` : ''}
    ${riser ? `<div class="card"><div class="eyebrow">RISING, NOT THE STAR</div>${playerBtn(riser, riser.gameId)}<div><span class="mid">${pc(riser.chance)}</span> <span class="small muted">${esc(riser.riser.reason)}</span></div></div>` : ''}
    <div class="row" role="group" aria-label="Slate view"><button class="btn ${S.resultsView ? '' : 'gold'}" data-act="slateview" data-view="games" aria-pressed="${!S.resultsView}">Games</button><button class="btn ${S.resultsView ? 'gold' : ''}" data-act="slateview" data-view="results" aria-pressed="${!!S.resultsView}">Results</button></div>
    ${S.resultsView ? resultsWeekHtml() : `<h2>Games</h2>${S.slate.games.length ? S.slate.games.map(gameCard).join('') : '<p class="muted">No regular-season games found for this week.</p>'}`}
    ${auditBlock()}</div>`;
  v.innerHTML = `<div class="slate-layout ${S.gameId ? 'open' : ''}">${list}${S.gameId ? `<div id="matchup">${matchupHtml(S.slate.games.find(g => g.id === S.gameId))}</div>` : ''}</div>`;
}
function auditBlock() {
  const a = S.slate.audit;
  return `<details><summary>Roster audit (${a.rejected.length} rejected · ${a.excluded.length} unavailable · ${a.unverified.length} unverified)</summary>
  <h4>Unavailable (excluded from recommendations)</h4><ul class="small">${a.excluded.map(e => `<li>${esc(e.name)} (${esc(e.pos)}) — ${esc(e.reason)}${e.transfer ? `; work to ${esc(e.transfer.toName)}${e.transfer.glToName !== e.transfer.toName ? `, goal line to ${esc(e.transfer.glToName)}` : ''}` : ''}</li>`).join('') || '<li>None</li>'}</ul>
  <h4>Unverified membership (High confidence blocked)</h4><ul class="small">${a.unverified.map(e => `<li>${esc(e.name)} ${esc(e.team)} ${esc(e.pos)} — ${esc(e.reason)}</li>`).join('') || '<li>None</li>'}</ul>
  <h4>Rejected identities</h4><ul class="small">${a.rejected.slice(0, 400).map(e => `<li>${esc(e.name)} — ${esc(e.reason)}</li>`).join('')}</ul></details>`;
}
function matchupHtml(g) {
  if (!g) return '';
  const side = s => {
    const T = g.sides[s]; const players = T.players.slice().sort(compareDefault); const call = players.find(p => p.id === T.call?.id);
    return `<div class="card"><div class="row between"><h3 class="row">${logo(T.team)} ${esc(T.team)}</h3><span class="small">Implied ${n1(T.implied)} · model TDs ${n1(T.teamLambda)} / budget ${n1(T.tdBudget)}</span></div>
      ${call ? `<div class="card ${call.tdConf.level === 'High' ? 'high' : ''}"><div class="eyebrow">TEAM CALL</div>${playerBtn(call, g.id)}<div class="row"><span class="big">${pc(call.chance)}</span>${chip(call.tdConf.level, 'TD')}<span class="small">edge ${call.edge == null ? 'unavailable' : (call.edge > 0 ? '+' : '') + call.edge.toFixed(1) + ' pts'}</span></div>
      <details><summary>Why this call</summary><ul class="small">${(T.call.why || []).map(w => `<li>${esc(w)}</li>`).join('')}
        <li>Matchup: ${esc(call.matchupFactor ? `position factor ×${call.matchupFactor.toFixed(2)}` : '')}</li><li>Spread ${T.spread > 0 ? '+' : ''}${T.spread}; published ${call.published ? pc(call.published.probability) : 'unavailable'}</li>
        <li>Confidence — TD ${call.tdConf.level}: ${esc(call.tdConf.reasons.concat(call.tdConf.blocks).join(' '))}</li>
        ${Object.entries(call.volConf || {}).map(([k, c]) => `<li>${esc(k)} ${c.level}: ${esc(c.reasons.concat(c.blocks).join(' '))}</li>`).join('')}
        ${call.riser ? `<li>${esc(call.riser.reason)}</li>` : ''}${call.conversionNote ? `<li>${esc(call.conversionNote)}</li>` : ''}
        ${T.excluded.length ? `<li>Injuries: ${esc(T.excluded.map(e => `${e.name} (${e.reason})`).join(', '))}</li>` : ''}${(T.teamNotes || []).map(n => `<li>${esc(n)}</li>`).join('')}</ul></details></div>` : ''}
      ${S.focus ? focusList(players, () => g.id, `${T.team} players`) : `      <p class="scrollhint" aria-hidden="true">Scroll sideways for every column →</p>
      <div class="tablewrap desk-only" tabindex="0" role="region" aria-label="${esc(T.team)} players"><table><caption class="sr-only">${esc(T.team)} eligible players</caption><thead><tr><th scope="col">Player</th><th scope="col">Anytime</th><th scope="col">80% band</th><th scope="col">TD conf</th><th scope="col">Rush yds</th><th scope="col">Rec yds</th><th scope="col">Receptions</th></tr></thead>
      <tbody>${players.map(p => `<tr class="${p.tdConf.level === 'High' ? 'high' : ''}"><td>${playerBtn(p, g.id)}${qbLine(p)}</td><td class="mid">${pc(p.chance)}</td><td>${pc(p.band[0])}–${pc(p.band[1])}</td><td>${chip(p.tdConf.level)}</td><td>${volCell(p, 'rushYd')}</td><td>${volCell(p, 'recYd')}</td><td>${volCell(p, 'rec')}</td></tr>`).join('')}</tbody></table></div>
      <div class="cards-mobile">${players.map(p => mobileCard(p, g.id)).join('')}</div>`}
      <details><summary>Excluded players (${T.excluded.length})</summary><ul class="small">${T.excluded.map(e => `<li>${esc(e.name)} ${esc(e.pos)} — ${esc(e.reason)}</li>`).join('') || '<li>None</li>'}</ul></details></div>`;
  };
  const k = etDisplay(g.game.kickoff); const W = g.sides.away.weather;
  return `<button class="btn" data-act="back">← Back to slate</button>
   <h2>${esc(g.sides.away.team)} @ ${esc(g.sides.home.team)}</h2><p class="small muted">${esc(k.day)} ${esc(k.time)} · ${esc(g.game.stadium || '')} · roof ${esc(g.game.roof || 'unknown')} · ${esc(W.note)} ${g.game.finished ? `· Final ${g.game.awayScore}–${g.game.homeScore}` : ''}
   ${g.frozen === 'snapshot' ? `· Frozen pregame snapshot captured ${new Date(g.capturedAt).toLocaleString()}` : g.frozen === 'reconstructed' ? '· Reconstructed from earlier weeks (not a prospective forecast)' : ''}</p>
   <p class="small muted">First-touchdown estimates share the offensive intensity; defensive and return touchdowns are not modeled.</p>
   ${resultsTable(g)}${side('away')}${side('home')}`;
}
// Focus view (user request): anytime %, TD confidence, and the single primary yardage line.
const PRIMARY = { QB: ['passYd', 'Pass yds'], RB: ['rushYd', 'Rush yds'], FB: ['rushYd', 'Rush yds'], WR: ['recYd', 'Rec yds'], TE: ['recYd', 'Rec yds'] };
const primaryCell = p => { const [m, l] = PRIMARY[p.pos] || PRIMARY.WR; return `<span class="muted small">${l}</span> ${volCell(p, m)}`; };
function focusList(players, gidOf, label, withStar = false) {
  return `<div class="focuslist" role="table" aria-label="${esc(label)} (focus view)"><div role="row" class="frow fhead small muted"><span role="columnheader">Player</span><span role="columnheader">Anytime</span><span role="columnheader">TD conf</span><span role="columnheader">Primary yards</span></div>
   ${players.map(p => `<div role="row" class="frow ${p.tdConf.level === 'High' ? 'high' : ''}"><span role="cell" class="fplayer">${withStar ? star(p) : ''}${playerBtn(p, gidOf(p))}</span><span role="cell" class="mid">${pc(p.chance)}</span><span role="cell" aria-label="TD confidence ${p.tdConf.level}">${chip(p.tdConf.level)}</span><span role="cell">${primaryCell(p)}</span></div>`).join('')}</div>`;
}
function mobileCard(p, gid) {
  return `<div class="card ${p.tdConf.level === 'High' ? 'high' : ''}"><div class="pcard">${photo(p)}<div><button class="plink" data-act="player" data-game="${esc(gid)}" data-player="${esc(p.id)}">${esc(p.name)}</button><div class="small muted">${esc(p.pos)} · ${esc(p.team)} ${highBadge(p)}</div></div><div class="big">${pc(p.chance)}</div></div>
   <div class="row small">${chip(p.tdConf.level, 'TD')} band ${pc(p.band[0])}–${pc(p.band[1])}</div>
   ${p.pos === 'QB' ? `<div class="small"><strong>Pass TD</strong> ${passTdCell(p)} · <strong>Pass yds</strong> ${volCell(p, 'passYd')}</div>` : ''}
   <div class="small">Rush ${volCell(p, 'rushYd')} · Rec yds ${volCell(p, 'recYd')} · Rec ${volCell(p, 'rec')}</div></div>`;
}

// ---------- Board
function boardRows() {
  const b = S.board; let list = allPlayers();
  if (b.pos !== 'ALL') list = list.filter(p => p.pos === b.pos);
  if (b.q) { const q = b.q.toLowerCase(); list = list.filter(p => p.name.toLowerCase().includes(q) || p.team.toLowerCase() === q || p.team.toLowerCase().includes(q)); }
  if (b.game) list = list.filter(p => p.gameId === b.game);
  if (b.hideLow) list = list.filter(p => p.chance >= 0.15);
  if (b.hideStarted) list = list.filter(p => !p.started);
  if (b.watchOnly) list = list.filter(p => S.watch.has(p.id));
  return sortPlayers(list, b.sort);
}
function renderBoard() {
  const v = $('#view-board'); if (!S.slate) { v.innerHTML = ''; return; }
  const b = S.board; const rows = boardRows();
  v.innerHTML = `<div class="filters" role="group" aria-label="Board filters">
    <div role="radiogroup" aria-label="Position" class="row">${['ALL', 'QB', 'RB', 'WR', 'TE', 'FB'].map(p => `<button class="btn ${b.pos === p ? 'gold' : ''}" role="radio" aria-checked="${b.pos === p}" data-act="pos" data-pos="${p}">${p}</button>`).join('')}</div>
    <label>Search <input id="bq" type="search" value="${esc(b.q)}" placeholder="Name or team"></label>
    <label>Game <select id="bgame"><option value="">All games</option>${S.slate.games.map(g => `<option value="${esc(g.id)}" ${b.game === g.id ? 'selected' : ''}>${esc(g.sides.away.team)} @ ${esc(g.sides.home.team)}</option>`).join('')}</select></label>
    <label><input type="checkbox" id="bhide" ${b.hideLow ? 'checked' : ''}> Hide under 15%</label>
    <label><input type="checkbox" id="bstarted" ${b.hideStarted ? 'checked' : ''}> Hide started</label>
    <label><input type="checkbox" id="bwatch" ${b.watchOnly ? 'checked' : ''}> Watchlist only</label>
    <label>Sort <select id="bsort">${Object.entries(SORTS).map(([k, s]) => `<option value="${k}" ${b.sort === k ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label></div>
   <p class="small muted">${rows.length} players. ${b.sort !== 'default' ? 'Explicit stat sort: team calls and ratings are unchanged.' : 'High touchdown confidence first, then chance.'}</p>
   <p class="scrollhint" aria-hidden="true">Scroll sideways for every column →</p>
   ${S.focus ? focusList(rows, p => p.gameId, 'Board', true) : `   <div class="tablewrap desk-only" tabindex="0" role="region" aria-label="Board"><table><thead><tr><th scope="col">Player</th><th scope="col">★</th><th scope="col">Anytime</th><th scope="col">80% band</th><th scope="col">Edge</th><th scope="col">American fair price</th><th scope="col">TD conf</th><th scope="col">Rush yds</th><th scope="col">Rec yds</th><th scope="col">Receptions</th><th scope="col">Role</th></tr></thead>
   <tbody>${rows.map(p => `<tr class="${p.tdConf.level === 'High' ? 'high' : ''}"><td>${playerBtn(p, p.gameId)}${qbLine(p)}</td><td>${star(p)}</td><td class="mid">${pc(p.chance)}</td><td>${pc(p.band[0])}–${pc(p.band[1])}</td><td>${p.edge == null ? 'n/a' : (p.edge > 0 ? '+' : '') + p.edge.toFixed(1)}</td><td>${fmtAmerican(p.chance)}</td><td>${chip(p.tdConf.level)}</td><td>${volCell(p, 'rushYd')}</td><td>${volCell(p, 'recYd')}</td><td>${volCell(p, 'rec')}</td><td>${(p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>
   <div class="cards-mobile">${rows.map(p => `<div class="row">${star(p)}<div style="flex:1">${mobileCard(p, p.gameId)}</div></div>`).join('')}</div>`}`;
}
const star = p => `<button class="star" aria-pressed="${S.watch.has(p.id)}" aria-label="${S.watch.has(p.id) ? 'Remove from' : 'Add to'} watchlist: ${esc(p.name)}" data-act="star" data-player="${esc(p.id)}">★</button>`;

// ---------- Player panel
let lastFocus = null;
function openPlayer(gameId, playerId, keep = false) {
  if (!keep) lastFocus = document.activeElement;
  S.panel = { gameId, playerId }; S.detail = null;
  send('detail', { gameId, playerId }); renderPanel();
}
function closePanel() {
  S.panel = null; S.detail = null; const p = $('#panel'); p.hidden = true; $('#scrim').hidden = true; document.body.classList.remove('locked', 'panel-open');
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
const isSmall = () => window.matchMedia('(max-width:1023px)').matches;
function pie(player, team, label) {
  if (!team) return `<figure><div class="muted small" style="height:80px;display:flex;align-items:center;justify-content:center">No team ${esc(label)}</div></figure>`;
  if (!player) return `<figure><div class="muted small" style="height:80px;display:flex;align-items:center;justify-content:center">No touches (0 of ${team})</div></figure>`;
  const f = player / team, a = f * 2 * Math.PI, x = 40 + 34 * Math.sin(a), y = 40 - 34 * Math.cos(a);
  const path = f >= 1 ? `<circle cx="40" cy="40" r="34" fill="#e4b54a"/>` : `<circle cx="40" cy="40" r="34" fill="#3f8f6a"/><path d="M40 40 L40 6 A34 34 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z" fill="#e4b54a"/>`;
  return `<figure><svg width="80" height="80" viewBox="0 0 80 80" role="img" aria-label="${player} of ${team} (${Math.round(f * 100)}%)">${path}</svg></figure>`;
}
function renderPanel() {
  const el = $('#panel'); if (!S.panel) return;
  const f = findPlayer(S.panel.gameId, S.panel.playerId); if (!f) return closePanel();
  const { g, p } = f; const d = S.detail; const small = isSmall();
  const focusWasInside = el.contains(document.activeElement) && document.activeElement?.dataset?.act === 'close';
  el.hidden = false; el.setAttribute('role', small ? 'dialog' : 'complementary'); if (small) el.setAttribute('aria-modal', 'true'); else el.removeAttribute('aria-modal');
  $('#scrim').hidden = !small; document.body.classList.toggle('locked', small); document.body.classList.toggle('panel-open', !small);
  const conf = [['Score', p.tdConf]].concat(Object.entries(p.volConf || {}).map(([k, c]) => [{ rushYd: 'Rush yards', rec: 'Receptions', recYd: 'Receiving yards', passYd: 'Pass yards' }[k], c]));
  if (p.pos === 'QB' && p.passTd) conf.push(['Passing TD', { level: p.passTd.level, reasons: p.passTd.reasons, blocks: [] }]);
  const highs = conf.filter(([, c]) => c?.level === 'High');
  const dist = p.dist || {};
  el.innerHTML = `<div class="row between"><h2 id="panelTitle">${esc(p.name)}</h2><button class="btn" data-act="close" aria-label="Close player details">Close ✕</button></div>
   ${d ? `<div class="card"><div class="eyebrow">SCORE MATCHUP</div><p>${esc(d.matchupLead.sentence)}</p><p class="small">${esc(d.matchupLead.evidence || '')} ${d.matchupLead.featured ? `This offense ${esc(d.matchupLead.featured)} the position (role ratio ${d.matchupLead.roleRatio?.toFixed(2)}).` : ''} ${d.matchupLead.liftBlocked ? 'No real recent scoring opportunities, so the soft position does not lift him.' : ''}</p></div>` : '<p class="muted">Loading details…</p>'}
   <div class="row">${photo(p)}<div><strong>${esc(p.name)}</strong> <span class="muted">${esc(p.pos)} · ${esc(p.team)} vs ${esc(f.s === 'away' ? g.sides.home.team : g.sides.away.team)}</span><div class="small">${esc(d?.role || p.role || '')} · ${esc(p.avail?.label || '')}${p.replacing ? ` · replacing ${esc(p.replacing.name)}` : ''}</div><div class="small muted">${esc(d?.weather?.note || '')}</div></div></div>
   <div class="card ${p.tdConf.level === 'High' ? 'high' : ''}"><div class="row between"><div><div class="small muted">Anytime chance</div><div class="big" aria-label="Anytime touchdown chance ${pc(p.chance)}">${pc(p.chance, 1)}</div></div>${chip(p.tdConf.level, 'TD confidence')}</div>
     <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p.chance * 100)}" aria-label="Chance"><span style="width:${(p.chance * 100).toFixed(1)}%"></span></div>
     <div class="kv small" style="margin-top:8px"><div>American fair price<br><strong>${fmtAmerican(p.chance)}</strong></div><div>Edge<br><strong>${p.edge == null ? 'unavailable' : (p.edge > 0 ? '+' : '') + p.edge.toFixed(1) + ' pts'}</strong></div><div>Published projection<br><strong>${p.published ? pc(p.published.probability) : 'none'}</strong></div><div>First TD<br><strong>${pc(p.firstTd, 1)}</strong></div><div>Two or more<br><strong>${pc(dist.twoPlus, 1)}</strong></div><div>80% band (probability)<br><strong>${pc(p.band[0])}–${pc(p.band[1])}</strong></div></div>
     <p class="small">Count distribution: 0 ${pc(dist.p0)} · 1 ${pc(dist.p1)} · 2 ${pc(dist.p2)} · 3+ ${pc(dist.p3plus)} (λ ${n1(p.lambda)}). The band is uncertainty about the probability, not a range for his touchdown count.</p></div>
   <div class="row">${conf.map(([k, c]) => chip(c?.level || 'Low', k)).join(' ')}</div>
   ${highs.length ? `<details><summary>Why High confidence</summary>${highs.map(([k, c]) => `<p class="small"><strong>${esc(k)}:</strong> ${esc(c.reasons.join(' '))}</p>`).join('')}</details>` : ''}
   <details><summary>Confidence reasons by area</summary>${conf.map(([k, c]) => `<p class="small"><strong>${esc(k)} ${c?.level}:</strong> ${esc([...(c?.reasons || []), ...(c?.blocks || [])].join(' '))}</p>`).join('')}</details>
   <h3>Volume forecasts</h3><div class="kv small">${Object.entries(p.volume || {}).map(([k, v]) => `<div><strong>${esc({ rushYd: 'Rush yards', rec: 'Receptions', recYd: 'Receiving yards', passYd: 'Pass yards' }[k])}</strong> ${k === 'rec' ? n1(v.mean) : n0(v.mean)} <span class="muted">(${k === 'rec' ? n1(v.lo) : n0(v.lo)}–${k === 'rec' ? n1(v.hi) : n0(v.hi)})</span><br>${esc(v.text || '')}<br><span class="muted">${esc(v.source || '')}</span></div>`).join('')}</div>
   ${p.pos === 'QB' ? `<div class="card"><h4>Passing touchdowns</h4><p>${passTdCell(p)}</p><p class="small">${esc((p.passTd?.reasons || []).join(' '))} Passing TDs do not count toward his anytime chance.</p></div>` : ''}
   ${[p.conversionNote, p.riser?.reason, p.secondOption, ...(p.safetyNotes || []), ...(p.lessonNotes || []), d?.notes?.spike].filter(Boolean).map(t => `<p class="small">• ${esc(t)}</p>`).join('')}
   ${d ? detailBody(d, p, g) : ''}`;
  if (el.dataset.focused !== p.id || focusWasInside || !el.contains(document.activeElement)) { el.dataset.focused = p.id; el.querySelector('[data-act=close]').focus({ preventScroll: true }); }
}
function statTable(rows, caption) {
  if (!rows.length) return `<p class="muted small">${esc(caption)}</p>`;
  return `<div class="tablewrap" tabindex="0" role="region" aria-label="${esc(caption)}"><table style="min-width:560px"><thead><tr><th scope="col">Game</th><th scope="col">Opp</th><th scope="col">H/A</th><th scope="col">Car</th><th scope="col">Rush yds</th><th scope="col">Tgt</th><th scope="col">Rec</th><th scope="col">Rec yds</th><th scope="col">TD</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.season} W${r.week}</td><td>${esc(r.opp)}</td><td>${r.home == null ? '—' : r.home ? 'Home' : 'Away'}</td><td>${r.carries}</td><td>${r.rushYd}</td><td>${r.targets}</td><td>${r.rec}</td><td>${r.recYd}</td><td>${r.td}</td></tr>`).join('')}</tbody></table></div>`;
}
const FR = [['carries', 'Carries'], ['rushYd', 'Rush yds'], ['rushTd', 'Rush TD'], ['rzRush', 'RZ rushes'], ['targets', 'Targets'], ['rec', 'Rec'], ['recYd', 'Rec yds'], ['airYd', 'Air yds'], ['yac', 'YAC'], ['recTd', 'Rec TD'], ['rzTgt', 'RZ targets'], ['att', 'Pass att'], ['cmp', 'Cmp'], ['passYd', 'Pass yds'], ['passTd', 'Pass TD'], ['rzPass', 'RZ passes']];
function detailBody(d, p, g) {
  const a = d.actual;
  const actual = a.status === 'pending' ? '<p class="small muted">Result pending.</p>' : a.status === 'missing' ? `<p class="small warn">Result missing: ${esc(a.note)}</p>` :
    `<p class="small"><strong>${a.status === 'confirmed' ? 'Confirmed' : 'Confirmed zero'}:</strong> ${a.td} TD · ${a.rushYd} rush yds · ${a.rec} catches · ${a.recYd} rec yds${p.pos === 'QB' ? ` · ${a.passYd} pass yds · ${a.passTd} pass TD` : ''}. ${a.spotKnown ? `By spot: ${['r1', 'r2', 'r3', 'r0', 't1', 't2', 't3', 't0'].filter(k => a.spotTd[k]).map(k => `${k} ${a.spotTd[k]}`).join(', ') || 'no TD spots'}` : 'Yard-line spots unknown.'}</p>`;
  const pies = ['t', 'r'].map(path => `<h4>${path === 't' ? 'Targets' : 'Rushes'}: player (gold) vs rest of team (green), last three weeks</h4><div class="pies">${[1, 2, 3].map(b => { const x = d.pies[`${path}${b}`]; return `<div>${pie(x.player, x.team, path === 't' ? 'targets' : 'rushes')}<figcaption><strong>${esc(x.label)}</strong><br>${esc(x.sub)}<br>${x.player} of ${x.team} · season ${x.seasonPlayer}/${x.seasonTeam}</figcaption></div>`; }).join('')}</div>`).join('');
  return `<h3>Final actuals</h3>${actual}
   <h3>Snaps</h3><p class="small">${d.snaps.recent ?? 0} offensive snaps over ${d.snaps.games} recent games · share ${d.snaps.share != null ? pc(d.snaps.share) : 'unknown'}</p>
   <h3>Last five games</h3>${statTable(d.last5, 'No recent game this season.')}
   <details><summary>Complete counting-stat log</summary><div class="tablewrap" tabindex="0"><table><thead><tr><th>Game</th>${FR.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${d.allLogs.map(r => `<tr><td>${r.season} W${r.week} ${esc(r.opp)}</td>${FR.map(([k]) => `<td>${r[k] ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
   <h3>Head-to-head (before this matchup)</h3>${statTable(d.h2h, 'No meeting in the last two seasons.')}
   <h3>Red-zone shares</h3>${pies}
   <h3>Per-spot expected looks and scores</h3><div class="tablewrap" tabindex="0"><table style="min-width:520px"><thead><tr><th>Path / spot</th><th>Exp. looks</th><th>Rate used</th><th>Exp. TD</th><th>Season looks/scores</th></tr></thead><tbody>${d.spotTable.map(r => `<tr><td>${r.path} ${esc(r.bin)}</td><td>${n1(r.looks)}</td><td>${pc(r.rate, 1)}</td><td>${r.td.toFixed(3)}</td><td>${r.seasonLooks}/${r.seasonScores}</td></tr>`).join('')}</tbody></table></div>
   <h3>Season and last-three-games frame</h3><div class="tablewrap" tabindex="0"><table><thead><tr><th>Span</th>${FR.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${['season', 'last3'].map(k => `<tr><td>${k === 'season' ? `Season (${d.frame.season.games} g)` : 'Last 3 games'}</td>${FR.map(([f]) => `<td>${d.frame[k][f] ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
   <h3>Research profile</h3><p class="small muted">${esc(d.profile.note)}</p><div class="kv small">${Object.entries(d.profile).filter(([k]) => k !== 'note').map(([k, v]) => `<div>${esc(k)}<br><strong>${v.value == null ? '—' : n1(v.value)}</strong> ${v.percentile == null ? '<span class="muted">(n/a)</span>' : `${v.percentile}th pct`}<br><span class="muted">${v.peers} peers</span></div>`).join('')}</div>
   <h3>Earlier-game splits</h3><div class="tablewrap" tabindex="0"><table style="min-width:600px"><thead><tr><th>Split</th><th>Games</th><th>Scoring games</th><th>Car</th><th>Rush yds</th><th>Tgt</th><th>Rec</th><th>Rec yds</th></tr></thead><tbody>${d.splits.map(s => `<tr><td>${esc(s.label)}${s.thin ? ' <span class="warn">(thin)</span>' : ''}</td><td>${s.n}</td><td>${s.scoringGames}</td><td>${n1(s.avg.carries)}</td><td>${n1(s.avg.rushYd)}</td><td>${n1(s.avg.targets)}</td><td>${n1(s.avg.rec)}</td><td>${n1(s.avg.recYd)}</td></tr>`).join('')}</tbody></table></div>
   <h3>Threshold explorer</h3><div class="row"><label>Metric <select id="thrMetric"><option value="rushYd">Rush yards</option><option value="recYd">Receiving yards</option><option value="rec">Catches</option><option value="passYd">QB passing yards</option></select></label><label>Threshold <input id="thrVal" type="number" value="50" min="0" style="width:90px"></label><button class="btn" data-act="thr">Check</button></div><p id="thrOut" class="small" aria-live="polite"></p>
   <h3>Scenarios</h3><p class="small muted">Conditional scenarios with team caps and scoring budget refit; not extra touchdown products.</p><div class="tablewrap" tabindex="0"><table style="min-width:480px"><thead><tr><th>Scenario</th><th>Chance</th><th>Carries</th><th>Targets</th><th>Attempts</th></tr></thead><tbody>${Object.entries(d.scenarios || {}).map(([k, s]) => `<tr><td>${esc({ close: 'Close game', lead: 'Playing with a lead', behind: 'Playing from behind', limited: 'Limited availability' }[k] || k)}</td><td>${pc(s.chance, 1)}</td><td>${n1(s.carries)}</td><td>${n1(s.targets)}</td><td>${n1(s.att)}</td></tr>`).join('')}</tbody></table></div>
   <h3>Advanced evidence</h3><div class="tablewrap" tabindex="0"><table style="min-width:620px"><thead><tr><th>Path / spot</th><th>Looks</th><th>Scores</th><th>Shrunk mean</th><th>~80% interval</th><th>Rate used</th><th>Note</th></tr></thead><tbody>${d.advanced.posterior.map(r => `<tr><td>${r.path} ${['', '1–5', '6–10', '11–20'][r.bin]}</td><td>${r.looks}</td><td>${r.scores}</td><td>${pc(r.mean, 1)}</td><td>${pc(r.lo, 1)}–${pc(r.hi, 1)}</td><td>${pc(r.used, 1)}</td><td class="small">${esc(r.note)}</td></tr>`).join('')}</tbody></table></div>
   <p class="small">Games this season ${d.advanced.coverage.gamesThisSeason} · known zone games ${d.advanced.coverage.zoneKnownGames} · share trend ${pc(d.advanced.trend.earlyShare)} → ${pc(d.advanced.trend.lateShare)} (${esc(d.advanced.trend.direction)}) · inside-10 fraction ${pc(d.advanced.inside10Fraction)} · volatility ${d.advanced.volatility == null ? 'n/a' : d.advanced.volatility.toFixed(2)} · role factor ${d.advanced.workload.roleFactor?.toFixed(2)} · availability ${d.advanced.workload.availability.toFixed(2)}</p>
   <p class="small muted">Not available (no real source): ${esc(d.advanced.unavailable.join(', '))}.</p>
   ${d.defenseTable ? `<h3>Positional defense vs offense share</h3><div class="kv small"><div>TD rate allowed (rush)<br><strong>${pc(d.defenseTable.pathRates.rush.allowed, 1)}</strong> vs ${pc(d.defenseTable.pathRates.rush.league, 1)} league · ${d.defenseTable.pathRates.rush.tds}/${d.defenseTable.pathRates.rush.plays}</div><div>TD rate allowed (targets)<br><strong>${pc(d.defenseTable.pathRates.target.allowed, 1)}</strong> vs ${pc(d.defenseTable.pathRates.target.league, 1)} · ${d.defenseTable.pathRates.target.tds}/${d.defenseTable.pathRates.target.plays}</div><div>Yards/carry allowed<br><strong>${n1(d.defenseTable.eff.ypc.allowed)}</strong> vs ${n1(d.defenseTable.eff.ypc.league)}</div><div>Catch rate allowed<br><strong>${pc(d.defenseTable.eff.catchRate.allowed)}</strong> vs ${pc(d.defenseTable.eff.catchRate.league)}</div><div>Yards/target allowed<br><strong>${n1(d.defenseTable.eff.ypt.allowed)}</strong> vs ${n1(d.defenseTable.eff.ypt.league)}</div><div>Offense role ratio<br><strong>${d.defenseTable.offenseShare?.toFixed(2)}</strong></div></div>
     ${d.defenseTable.rz ? `<h4>Yard-line defense (red zone allowed)</h4><div class="tablewrap" tabindex="0"><table style="min-width:420px"><thead><tr><th>Spot</th><th>Rush looks/TD</th><th>Target looks/TD</th></tr></thead><tbody>${[1, 2, 3].map(b => `<tr><td>${['', '1–5', '6–10', '11–20'][b]}</td><td>${d.defenseTable.rz.rush.bins[b]?.looks ?? 0}/${d.defenseTable.rz.rush.bins[b]?.scores ?? 0}</td><td>${d.defenseTable.rz.target.bins[b]?.looks ?? 0}/${d.defenseTable.rz.target.bins[b]?.scores ?? 0}</td></tr>`).join('')}</tbody></table></div>` : ''}` : ''}
   <h3>Published projection</h3><p class="small">${d.published.expected != null ? `${esc(d.published.source)}: ${d.published.expected.toFixed(2)} expected TDs → ${pc(d.published.probability, 1)}. ` : ''}${esc(d.published.note)}</p>
   <h3>Team scoring budget</h3><p class="small">Model ${n1(d.budget.teamLambda)} vs ${n1(d.budget.tdBudget)} (implied points × 0.7 / 6.9). ${esc((d.budget.notes || []).join(' '))}</p>
   <h3>Data limitations</h3><ul class="small">${d.limitations.map(l => `<li>${esc(l)}</li>`).join('') || '<li>None noted.</li>'}</ul>`;
}

// ---------- Lab
let recalcReq = 0;
function pickTrackerHtml() {
  const T = S.slate.pickTracker; if (!T) return '<div class="card"><h2>Pick tracker</h2><p class="small muted">Unavailable (archive not loaded).</p></div>';
  const rec = g => g.total ? `${g.hits}/${g.total} (${Math.round(100 * g.hits / g.total)}%)` : '0/0';
  const lst = l => l.map(x => `<li>${esc(x.name)} ${esc(x.team)} · ${pc(x.chance)} · <strong class="${x.outcome === 'scored' ? 'ok' : ''}">${esc(x.outcome)}</strong></li>`).join('') || '<li class="muted">None</li>';
  const kinds = { prospective: 'Prospective (frozen pregame snapshots)', reconstructed: 'Reconstructed (earlier-week features; not prospective evidence)' };
  return `<div class="card" id="pickTracker"><h2>Pick tracker</h2>
   ${Object.entries(kinds).map(([k, l]) => `<p class="small"><strong>${l}:</strong> team calls ${rec(T.totals[k].teamCalls)} · High TD names ${rec(T.totals[k].highTd)}</p>`).join('')}
   <div class="tablewrap" tabindex="0" role="region" aria-label="Pick tracker by week"><table><thead><tr><th scope="col">Week</th><th scope="col">Source</th><th scope="col">Team calls</th><th scope="col">High TD names</th></tr></thead><tbody>
   ${T.weeks.flatMap(w => Object.entries(w.groups).map(([k, g]) => `<tr><td>${w.week}</td><td>${k === 'prospective' ? 'Prospective' : 'Reconstructed'}</td>
     <td><details><summary>${rec(g.teamCalls)}${g.teamCalls.pending ? ` · ${g.teamCalls.pending} pending` : ''}</summary><ul class="small">${lst(g.teamCalls.list)}</ul></details></td>
     <td><details><summary>${rec(g.highTd)}${g.highTd.pending ? ` · ${g.highTd.pending} pending` : ''}</summary><ul class="small">${lst(g.highTd.list)}</ul></details></td></tr>`)).join('') || '<tr><td colspan="4" class="muted">No graded weeks yet.</td></tr>'}
   </tbody></table></div></div>`;
}
function learnedRepoHtml() {
  const X = S.slate.learned; if (!X) return '<p class="small muted">Shared archive not loaded (local or file:// copy): lessons above come from this device only.</p>';
  const pctc = v => `${v >= 1 ? '+' : ''}${((v - 1) * 100).toFixed(1)}%`;
  const sc = X.scales ? Object.entries(X.scales).flatMap(([g, o]) => Object.entries(o || {}).map(([k, v]) => `${g}.${k} ${pctc(v)}`)) : [];
  const ch = (X.changes || [])[0]; const comp = X.components || {};
  const dec = k => { const c = comp[k]; return c ? `<li><strong>${k}</strong>: ${c.enabled ? 'enabled' : 'off'} — ${esc(c.reason || '')}${c.decidedAt ? ` (${esc(c.decidedAt.slice(0, 10))})` : ''}</li>` : `<li><strong>${k}</strong>: not evaluated yet</li>`; };
  return `<h3>Shared archive (same on every device)</h3><p class="small">Current scales (week ${X.week ?? '—'}): ${esc(sc.join(' · ') || 'none')}</p>
   <p class="small">${ch ? `Latest change ${esc(new Date(ch.at).toLocaleString())} (week ${ch.week}): ${esc(ch.diff.map(d => `${d.group}.${d.key} ${pctc(d.from)} → ${pctc(d.to)}`).join(' · ') || 'basis updated, scales unchanged')}. ${esc(ch.why)}` : 'No change recorded yet.'}</p>
   <h3>Auto-calibration decisions</h3><ul class="small">${dec('caps')}${dec('challenger')}</ul>${X.promotion ? `<p class="small muted">Challenger promotion check: ${X.promotion.promote ? 'passes' : esc(X.promotion.reasons.join(' '))}</p>` : ''}`;
}
function renderLab() {
  const v = $('#view-lab'); if (!S.slate) { v.innerHTML = ''; return; }
  const W = S.weights; const labels = { recentBlend: 'Recent volume blend', publishedBlend: 'Published projection blend', script: 'Game script', redZone: 'Red zone', shrinkGames: 'Shrinkage games', tePremium: 'TE premium', goalLine: 'Goal-line weight' };
  const L = S.slate.lessons; const bt = S.backtest; const R = S.slate.research; const ch = S.slate.challenger;
  const met = c => c && c.n ? `n ${c.n} · Brier ${c.brier?.toFixed(4)} · log loss ${c.logLoss?.toFixed(4)} · flat-25% Brier ${c.flat25Brier?.toFixed(4)} · matched vs published (n ${c.matched.n}): ${c.matched.model?.toFixed(4) ?? '—'} vs ${c.matched.published?.toFixed(4) ?? '—'}` : 'no confirmed results';
  v.innerHTML = `<div class="card"><h2>Weights</h2><p class="small muted">Changes recalculate only unplayed games; finished predictions stay frozen. Saved on this device.</p>
    ${Object.keys(labels).map(k => `<label class="small" style="display:block">${labels[k]}: <strong id="wv-${k}">${W[k]}</strong><input type="range" data-weight="${k}" min="${WEIGHT_RANGES[k][0]}" max="${WEIGHT_RANGES[k][1]}" step="${k === 'shrinkGames' ? 1 : 0.01}" value="${W[k]}" aria-label="${labels[k]}"></label>`).join('')}
    <p class="small">Defense trust ${W.defenseTrust} (retained default).</p><button class="btn" data-act="reset">Reset weights</button></div>
   <div class="card"><h2>Learned from finished games</h2>${L?.describe?.length ? `<ul class="small">${L.describe.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small muted">No lesson yet.</p>'}
     <p class="small muted">Basis: ${(L?.active?.basis || []).map(b => `week ${b.week}: ${b.applied ? `${b.prospective} prospective / ${b.reconstructed} reconstructed` : 'none (counts as 1)'}`).join(' · ')}</p>
     ${learnedRepoHtml()}
     ${L?.inWeek?.applied ? `<p class="small">In-week nudge from ${L.inWeek.confirmed} completed results this week, damped (scale+2)/3, applied to unplayed games only.</p>` : '<p class="small muted">No in-week nudge (needs 8 completed results this week).</p>'}</div>
   <div class="card"><h2>Backtest: week ${S.week}</h2><button class="btn gold" data-act="backtest">Run backtest for selected week</button>
     ${bt ? `<p class="small">${bt.finishedGames} finished games · confirmed ${bt.td.cohorts.all.all.n} (prospective ${bt.td.prospective}, reconstructed ${bt.td.reconstructed}) · missing excluded ${bt.td.missingExcluded} · confirmed zeros ${bt.td.cohorts.all.all.confirmedZeros}</p>
      <p class="small"><strong>Reconstructed outcomes do not prove prospective accuracy.</strong></p>
      ${['all', 'contributors', 'teamCalls', 'highTd', 'medTd', 'lowTd'].map(k => `<p class="small"><strong>${k}</strong>: ${met(bt.td.cohorts[k].all)}<br><span class="muted">prospective: ${met(bt.td.cohorts[k].prospective)}</span></p>`).join('')}
      <h3>Calibration bins (all)</h3><div class="tablewrap"><table style="min-width:480px"><thead><tr><th>Bin</th><th>n</th><th>Avg chance</th><th>Hit rate</th><th>95% interval</th></tr></thead><tbody>${bt.td.cohorts.all.all.bins.map(b => `<tr><td>${b.label}</td><td>${b.n}</td><td>${pc(b.avgChance, 1)}</td><td>${pc(b.hitRate, 1)}</td><td>${pc(b.ci[0])}–${pc(b.ci[1])}</td></tr>`).join('')}</tbody></table></div>
      <h3>Volume accuracy</h3>${Object.entries(bt.volume).filter(([k]) => k !== 'passTd').map(([k, x]) => `<p class="small"><strong>${k}</strong>: n ${x.overall.n} · MAE ${n1(x.overall.mae)} · bias ${n1(x.overall.bias)} · coverage ${pc(x.overall.coverage)} · by confidence ${esc(Object.entries(x.byConfidence).map(([c, y]) => `${c} ${pc(y.coverage)} (n${y.n})`).join(', '))}</p>`).join('')}<p class="small warn">${esc(bt.volume.passTd.note)}</p>
      <h3>Highest-chance misses</h3><ul class="small">${bt.td.highestMisses.map(r => `<li>${esc(r.name)} ${pc(r.chance)} — ${esc(r.reason)}</li>`).join('')}</ul>
      <h3>Lowest-chance scorers</h3><ul class="small">${bt.td.lowestScorers.map(r => `<li>${esc(r.name)} ${pc(r.chance)} (${r.td} TD)</li>`).join('')}</ul>
      <h3>Expected vs actual by yard-line spot</h3><p class="small">${bt.td.spots.agg.map(s => `${s.spot}: ${s.expected.toFixed(1)} exp / ${s.actual} act`).join(' · ')} (unknown-spot rows excluded: ${bt.td.spots.excludedUnknown})</p>
      <h3>Meaningful expected, zero confirmed</h3><ul class="small">${bt.td.spots.meaningfulZero.slice(0, 12).map(r => `<li>${esc(r.name)} ${r.spot} expected ${r.expected.toFixed(2)}</li>`).join('') || '<li>None</li>'}</ul>` : ''}</div>
   ${pickTrackerHtml()}<div class="card"><h2>Champion / challenger</h2><p class="small">Challenger: ${esc(ch?.status || 'unknown')} ${ch?.reason ? '— ' + esc(ch.reason) : ''} · training ${ch?.trainingCount ?? 0} · cutoff ${esc(JSON.stringify(ch?.cutoff || {}))}</p>
     ${R?.promotion ? `<p class="small">Promotion: <strong>${R.promotion.promote ? 'eligible' : 'withheld'}</strong>. ${esc(R.promotion.reasons.join(' '))} Paired ${R.promotion.metrics.paired} across ${R.promotion.metrics.games} games. ${esc(R.promotion.note)}</p>` : '<p class="small muted">No validation run yet.</p>'}
     ${R?.summary ? `<p class="small">Archive summary: ${R.summary.prospective} prospective / ${R.summary.reconstructed} reconstructed graded · missing excluded ${R.summary.missingExcluded}</p>` : ''}</div>
   <div class="card"><h2>Refresh</h2><p class="small">${esc(S.slate.repoArchive ? 'A scheduled GitHub Actions job (user-approved) captures pregame snapshots and grades finished games into the shared archive; this page loads it.' : 'This copy has no shared archive; it refreshes when you press Refresh.')}</p>
     <label><input type="checkbox" id="autoToggle" ${S.auto.enabled ? 'checked' : ''}> Optional auto-refresh every ${S.auto.minutes} minutes while this page is open (off by default)</label>
     <p class="small">Archive job: ${S.slate.lastRun ? `last run ${esc(S.slate.lastRun.status)} at ${esc(S.slate.lastRun.finished_at || S.slate.lastRun.started_at)}` : 'never run'}.</p>
     <button class="btn" data-act="job">Run archive refresh now (one time)</button><p id="jobOut" class="small" aria-live="polite"></p>
     <h3>Sources</h3><ul class="small">${Object.values(S.slate.sources).map(s => `<li>${s.ok ? '✓' : '✗'} ${esc(s.label)} ${s.fetchedAt ? `· ${new Date(s.fetchedAt).toLocaleString()}` : ''}${s.stale ? ' · stale' : ''}${s.error ? ` · <span class="warn">${esc(s.error)}</span>` : ''}</li>`).join('')}</ul><p class="small muted">Charting: FTN Data via nflverse, CC-BY-SA 4.0.</p></div>`;
}
let autoTimer = null;
function applyAuto() { clearInterval(autoTimer); autoTimer = null; if (S.auto.enabled) autoTimer = setInterval(() => { if (!S.loading) startLoad(false); }, S.auto.minutes * 60000); }

// ---------- events
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return; const a = t.dataset.act;
  if (a === 'retry') startLoad(true);
  else if (a === 'dismiss') $('#loading').hidden = true;
  else if (a === 'game') { S.gameId = t.dataset.game; renderSlate(); const m = $('#matchup'); if (m) { m.querySelector('[data-act=back]')?.focus(); if (isSmall()) window.scrollTo(0, 0); } }
  else if (a === 'slateview') { S.resultsView = t.dataset.view === 'results'; renderSlate(); }
  else if (a === 'back') { const id = S.gameId; S.gameId = null; renderSlate(); document.querySelector(`[data-act=game][data-game="${CSS.escape(id)}"]`)?.focus(); }
  else if (a === 'player') openPlayer(t.dataset.game, t.dataset.player);
  else if (a === 'close') closePanel();
  else if (a === 'star') { const id = t.dataset.player; S.watch.has(id) ? S.watch.delete(id) : S.watch.add(id); save(LS.watch, [...S.watch]); renderBoard(); }
  else if (a === 'pos') { S.board.pos = t.dataset.pos; save(LS.board, S.board); renderBoard(); }
  else if (a === 'reset') { S.weights = { ...DEFAULT_WEIGHTS }; save(LS.weights, S.weights); recalcReq = send('recalc', { weights: S.weights }); renderLab(); }
  else if (a === 'backtest') send('backtest');
  else if (a === 'thr') send('threshold', { gameId: S.panel.gameId, playerId: S.panel.playerId, metric: $('#thrMetric').value, threshold: $('#thrVal').value });
  else if (a === 'job') { $('#jobOut').textContent = 'Running…'; fetch('/api/jobs/refresh', { method: 'POST', headers: { 'content-type': 'application/json', ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) }, body: '{}' }).then(r => r.json()).then(r => { $('#jobOut').textContent = `${r.status}: ${(r.details?.steps || []).join('; ')} ${r.details?.error || ''}`; startLoad(false); }).catch(err => { $('#jobOut').textContent = `Failed: ${err.message}`; }); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.weight) { S.weights[t.dataset.weight] = Number(t.value); $(`#wv-${t.dataset.weight}`).textContent = t.value; save(LS.weights, S.weights); clearTimeout(t._d); t._d = setTimeout(() => { recalcReq = send('recalc', { weights: S.weights }); }, 250); }
  if (t.id === 'bq') { S.board.q = t.value; save(LS.board, S.board); clearTimeout(t._d); t._d = setTimeout(() => { const pos = t.selectionStart; renderBoard(); const n = $('#bq'); n.focus(); n.setSelectionRange(pos, pos); }, 200); }
});
document.addEventListener('change', e => {
  const t = e.target; const b = S.board;
  if (t.id === 'bgame') b.game = t.value; else if (t.id === 'bhide') b.hideLow = t.checked; else if (t.id === 'bstarted') b.hideStarted = t.checked; else if (t.id === 'bwatch') b.watchOnly = t.checked; else if (t.id === 'bsort') b.sort = t.value;
  else if (t.id === 'autoToggle') { S.auto.enabled = t.checked; save(LS.auto, S.auto); applyAuto(); return; }
  else if (t.id === 'weekSelect') { S.week = Number(t.value); S.gameId = null; startLoad(false); return; }
  else return;
  save(LS.board, b); renderBoard();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && S.panel) { e.preventDefault(); closePanel(); }
  if (e.key === 'Tab' && S.panel && isSmall()) { // focus trap for the modal sheet
    const f = [...$('#panel').querySelectorAll('button,select,input,[tabindex="0"],summary')].filter(x => !x.disabled); if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
  const tab = e.target.closest?.('[role=tab]'); if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { const tabs = [...document.querySelectorAll('[role=tab]')]; const i = tabs.indexOf(tab); const nx = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; nx.focus(); nx.click(); }
});
$('#scrim').addEventListener('click', closePanel);
document.querySelectorAll('[role=tab]').forEach(t => t.addEventListener('click', () => {
  S.tab = t.id.replace('tab-', '');
  document.querySelectorAll('[role=tab]').forEach(x => { const on = x === t; x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1; document.getElementById(x.getAttribute('aria-controls')).hidden = !on; });
  renderAll();
}));
$('#prevWeek').addEventListener('click', () => { if (S.week > 1) { S.week--; S.gameId = null; startLoad(false); } });
$('#nextWeek').addEventListener('click', () => { if (S.week < 18) { S.week++; S.gameId = null; startLoad(false); } });
$('#refreshBtn').addEventListener('click', () => startLoad(true));
const syncFocus = () => { const b = $('#focusBtn'); b.setAttribute('aria-pressed', String(!!S.focus)); b.textContent = S.focus ? 'Focus ✓' : 'Focus'; b.classList.toggle('gold', !!S.focus); };
$('#focusBtn').addEventListener('click', () => { S.focus = !S.focus; save(LS.view, S.focus); syncFocus(); renderAll(); }); syncFocus();
window.addEventListener('resize', () => { if (S.panel) renderPanel(); });
renderControls(); applyAuto(); startLoad(false); // initial load only; no background schedule unless the user opts in
