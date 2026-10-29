// ENDZONE UI (browser module). Heavy computation runs in the Web Worker.
import { fmtAmerican, DEFAULT_WEIGHTS, WEIGHT_RANGES, sanitizeWeights } from '/src/model.js';
import { STAGES, etDisplay, requestGate } from '/src/feeds.js';
import { sortPlayers, SORTS, SORT_GROUPS, compareDefault } from '/src/ranking.js';
import { teamLogo } from '/src/roster.js';
import { snapshotPassTd } from '/src/passing-touchdowns.js';
import { buildBrief, analyze, PROVIDERS } from '/src/analyst.js';
import { driveAdjustFor, applyToChance, pLead } from '/src/drive-adjust.js';
import { buildSimInputs, runSim, summarize, playerGameStat, playerDriveTable, pAtLeast, simPatterns, driveCard, pct as simPct, hashSeed, GAME_PRESETS, SIM_PRESETS, STAT_LBL as SIM_LBL } from '/src/sim.js';
import { buildPbpInputs, calibratePbp, pbpRunner, finish as pbpFinish, summarizePbp, pbpPartial, replayGame } from '/src/sim-pbp.js';
import { STATS, PRESETS, thLabel, shortName, personName, ylText, statLine, cellText, playerDriveRows, hitSummary, meets, driveLabel } from '/src/drive-log.js';

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
  focus: load(LS.view, null) ?? window.matchMedia('(max-width:1023px) and (orientation:portrait)').matches };
const worker = new Worker('/src/worker.js', { type: 'module' });
let timers = [];

function send(type, extra = {}) { const reqId = ++S.reqId; worker.postMessage({ type, reqId, ...extra }); return reqId; }
const gate = requestGate(); let loadReq = 0;
function startLoad(force = false) {
  clearTimers(); S.loading = true; stageState.tryAgain = false;
  loadReq = gate.next(); S.reqId = loadReq - 1; send('load', { season: S.season, week: S.week, force, weights: S.weights, token: S.token });
  renderLoading({ stage: 0 }); status(force ? 'Refreshing…' : 'Loading…');
  timers.push(setTimeout(() => renderLoading({ tryAgain: true }), 20000));
  timers.push(setTimeout(() => { worker.postMessage({ type: 'cancel', reqId: loadReq }); S.loading = false; renderLoading({ timeout: true }); }, 50000));
}
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
let stageState = { current: 0, tryAgain: false };
function renderLoading(o) {
  const el = $('#loading');
  if (o.stage != null) stageState.current = o.stage;
  if (o.tryAgain) stageState.tryAgain = true; // sticky: a late stage message must not hide Try again
  const tryAgain = o.tryAgain || stageState.tryAgain;
  if (!S.loading && !o.timeout) { el.hidden = true; return; }
  el.hidden = false;
  const cur = stageState.current;
  el.innerHTML = `<h2>${o.timeout ? 'This is taking too long' : S.slate ? 'Refreshing — your last slate stays usable' : 'Building this week’s slate'}</h2>
   ${o.timeout ? `<p>The data service did not finish within 50 seconds. The request was cancelled.${S.slate ? ' The last usable slate is still shown.' : ''}</p>` : '<p class="muted small">First open can take about a minute.</p>'}
   <ol class="stages">${STAGES.map((s, i) => `<li class="stage ${i + 1 < cur ? 'done' : i + 1 === cur ? 'active' : ''}">${i + 1 < cur ? '✓' : i + 1 === cur ? '●' : '○'} ${s}</li>`).join('')}</ol>
   ${tryAgain || o.timeout ? `<div class="row"><button class="btn gold" data-act="retry">Try again</button>${o.timeout ? '<button class="btn" data-act="dismiss">Dismiss</button>' : ''}</div>` : ''}`;
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
const playerBtn = (p, gid) => `<button class="plink" data-act="player" data-game="${esc(gid)}" data-player="${esc(p.id)}">${photo(p)}<span>${esc(p.name)} <span class="muted small">${esc(p.pos)} · ${esc(p.team)}${p.injury ? ` · <span class="warn">${esc(p.injury)}</span>` : ''}</span> ${highBadge(p)}${trendTag(p)}</span></button>`;

const ppTxt = x => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs((x || 0) * 100).toFixed(1)} pp`;
const STATUS_LBL = { new: 'New', continuing: 'Continuing', faded: 'Faded' };
function trendTag(p) {
  const t = (p.trendTags || []).filter(x => x.status !== 'faded'); if (!t.length) return '';
  const top = t.slice().sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength))[0];
  return ` <span class="ttag ${top.direction}" title="${esc(t.map(x => `${x.type} ${x.direction} (${x.status || 'new'})`).join(' · '))}">${top.direction === 'up' ? '▲' : '▼'} ${esc(top.type)}${t.length > 1 ? ` +${t.length - 1}` : ''}</span>`;
}
function trendCard(t) {
  const ev = Object.entries(t.evidence || {}).map(([k, v]) => `${esc(k)} ${esc(Array.isArray(v) ? v.join(', ') : v)}`).join(' · ');
  const who = t.entity.kind === 'defense' ? `${esc(t.team)} D vs ${esc(t.entity.pos)}` : t.entity.kind === 'team' ? `${esc(t.team)} offense` : `${esc(t.entity.name)} · ${esc(t.entity.pos)} · ${esc(t.team)}`;
  return `<article class="trendcard ${t.status}" data-family="${esc(t.family)}"><header><span class="ttag ${t.direction}">${t.direction === 'up' ? '▲' : '▼'} ${esc(t.type)}</span><span class="chip st-${t.status}">${STATUS_LBL[t.status] || t.status}</span><span class="who small muted">${who}</span></header>
   <p class="ttext">${esc(t.text)}</p>
   ${t.affected.length ? `<ul class="small affected">${t.affected.slice(0, 4).map(a => `<li><button class="plink" data-act="player" data-game="${esc(a.gameId)}" data-player="${esc(a.id)}">${esc(a.name)}</button> <span class="muted">${pc(a.chance, 1)}</span> <span class="pp">${ppTxt(a.pp)}</span></li>`).join('')}${t.affected.length > 4 ? `<li class="muted">+${t.affected.length - 4} more</li>` : ''}</ul>` : ''}
   <footer class="small muted"><span>${esc(t.mode)}${t.mode === 'active' ? ` · weight ${t.weight}` : ''}</span><details><summary>Evidence</summary>${ev} · strength ${t.strength.toFixed(2)} · first detected week ${t.firstDetectedWeek ?? '—'}</details></footer></article>`;
}
// ---- Drive-trends agent (scripts/drives/build.mjs -> archive/drives/<season>/w<week>.json). Display-only unless
// app 4.8: the model reads the patterns through src/drive-adjust.js (weight fitted walk-forward, gated; 0 = shown, moves nothing).
const drivesData = () => S.slate?.drives || null;
const driveRow = p => { const D = drivesData(); if (!D) return null; const g = p.gsis && D.players[p.gsis] ? p.gsis : D.bySleeper?.[p.id]; return g ? D.players[g] : null; };
const relChip = r => `<span class="chip rel-${esc(r)}">${esc(r)}</span>`;
const pct0 = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
function driveStatusLine(D) {
  if (D?.fit) { const g = S.slate?.learned?.components?.drives; return g?.enabled ? `Used in the model at weight ${esc(String(g.weight))} (±10% cap, before the safety caps).` : `The model computes a drive-pattern adjustment for every player with a pattern; ${D.fit.weight.model || D.fit.weight.blend ? `the "blend + drives" challenger uses weight ${esc(String(D.fit.weight.blend))}` : 'the walk-forward weight is 0, so it moves chances by 0'} and the headline chance uses it only after the gate passes.`; }
  const P = D?.prediction; if (!P) return 'Display-only: drive patterns do not change any chance.';
  return P.adopted ? `Used in predictions: ${esc(P.note || '')}` : `Display-only: ${esc(P.note || 'drive features did not significantly improve walk-forward Brier / log loss, so they do not change any chance.')}`;
}
function driveChartHtml(r) {
  const G = r.games || []; if (!G.length) return '';
  const maxN = Math.max(...G.map(g => g.d.length)); const cols = Array.from({ length: maxN }, (_, i) => i + 1);
  const cell = x => { const t = x[0] + x[2]; const lvl = t === 0 ? 0 : t === 1 ? 1 : t <= 3 ? 2 : 3; return `<td class="dc l${lvl}${x[4] ? ' rz' : ''}" title="${x[0]} tgt, ${x[1]} rec, ${x[2]} car, ${x[3]} yds${x[4] ? `, ${x[4]} red-zone` : ''}">${t || ''}</td>`; };
  return `<div class="tablewrap drivechart" tabindex="0" role="region" aria-label="Touches by drive, last ${G.length} games"><table class="dtab"><thead><tr><th scope="col">Game</th>${cols.map(n => `<th scope="col">${n}</th>`).join('')}</tr></thead><tbody>
   ${G.slice().reverse().map(g => `<tr><th scope="row">${g.s !== S.slate.season ? `'${String(g.s).slice(2)} ` : ''}W${g.w} <span class="muted">${esc(g.opp)}</span></th>${cols.map(n => g.d[n - 1] ? cell(g.d[n - 1]) : '<td class="dc na"></td>').join('')}</tr>`).join('')}</tbody></table></div>
   <p class="small muted">Touches (targets + carries) on each of his team's drives, newest game first; outlined = he touched it in the red zone. Tap a cell for targets / receptions / carries / yards.</p>`;
}
function drivePanelHtml(p) {
  const D = drivesData(); if (!D) return '<p class="small muted">Drive table not loaded for this week.</p>';
  const r = driveRow(p); if (!r) return `<p class="small muted">No drive history for him in ${D.season - 1}–${D.season} before week ${D.week} (needs 2+ games this season).</p><p class="small muted">${driveStatusLine(D)}</p>`;
  const a = r.summary, c = r.curSummary || a; const yr = D.season;
  const prof = [
    `Opening-script touches (drives 1–2): <strong>${c.openPerGame.toFixed(1)} per game</strong> in ${yr} <span class="muted">(${a.openPerGame.toFixed(1)} since ${yr - 1})</span>`,
    a.rzTgtShare != null ? `Red-zone-drive targets: <strong>${pct0(a.rzTgtShare)}</strong> of the team's <span class="muted">(n=${a.rzDrives} drives)</span>` : null,
    a.gtgTouchShare != null ? `Goal-to-go-drive touches: <strong>${pct0(a.gtgTouchShare)}</strong> of the team's <span class="muted">(n=${a.gtgDrives} drives)</span>` : null,
    `Second-half touches per drive: <strong>${a.leadPerDrive.toFixed(1)}</strong> leading · <strong>${a.trailPerDrive.toFixed(1)}</strong> trailing`,
  ].filter(Boolean);
  const pats = r.patterns || [];
  const me = allPlayers().find(x => x.id === p.id); const gm = me && (S.slate.games || []).find(x => x.id === me.gameId);
  const sp = gm?.sides.away.lines?.known ? (gm.sides.away.team === p.team ? gm.sides.away.lines.awaySpread : -gm.sides.away.lines.awaySpread) : null;
  const gs = p.gsis && D.players[p.gsis] ? p.gsis : D.bySleeper?.[p.id];
  const mv = me ? modelView(D, gs, { opp: me.opp, spread: sp, chance: p.chance ?? null, blend: p.challenger ?? null }) : null;
  const seen = mv ? `<h4>What the model sees</h4><ul class="mvlist small">${modelViewHtml(D, mv, { name: false })}</ul>` : '<h4>What the model sees</h4><p class="small muted">No pattern or watch item for him: the drive adjustment is ×1.00.</p>';
  return `${seen}${driveChartHtml(r)}
   <h4>Usage profile</h4><ul class="small dprof">${prof.map(x => `<li>${x}</li>`).join('')}</ul>
   <h4>Patterns that survived the checks</h4>${pats.length ? `<ul class="small dpats">${pats.map(t => `<li>${relChip(t.rel)} ${esc(t.text.replace(/, (strong|moderate)\)$/, ')'))}${t.own?.weeks && t.own.retention != null ? ` <span class="muted">· ${t.own.retention >= 1 ? 'fully held up' : t.own.retention > 0 ? `kept ${Math.round(t.own.retention * 100)}% of its edge` : 'did not hold up'} over ${t.own.weeks} later week${t.own.weeks > 1 ? 's' : ''}</span>` : ''}</li>`).join('')}</ul>`
     : `<p class="small">None for him. ${D.counts ? `League-wide only ${D.counts.drive.fdr} of ${D.counts.drive.tests.toLocaleString()} exact drive-number tests survived FDR (${D.counts.drive.raw05} hit p&lt;0.05 vs ${D.counts.drive.expectedByChance} expected by chance), so "N catches on the 3rd drive" style claims are almost always noise.` : ''}</p>`}
   <p class="small muted">${driveStatusLine(D)} Shares are of his team's own volume on those drives vs his share on its other drives in the same games; rates are shrunk toward his overall share. Strong = FDR q ≤ 0.05, 20+ drives and the pattern family held up out of sample.</p>`;
}
function drivesTrendsHtml() {
  const D = drivesData(); if (!D) return '';
  const inSlate = new Map(); for (const g of S.slate.games || []) for (const sd of ['away', 'home']) for (const p of g.sides[sd].players) { const k = p.gsis && D.players[p.gsis] ? p.gsis : D.bySleeper?.[p.id]; if (k) inSlate.set(k, { g, p }); }
  const top = (D.top || []).filter(t => t.rel === 'strong' || t.rel === 'moderate').slice(0, 15); const C = D.counts, P = D.persistence;
  const ret = x => x?.retention != null ? `${Math.round(x.retention * 100)}% [${Math.round(x.ciLo * 100)}–${Math.round(x.ciHi * 100)}%]` : '—';
  return `<div class="card drivescard" id="drivePatterns"><h2>Drive patterns · week ${D.week}</h2>${S.tab !== 'drives' ? '<p><button class="btn gold" data-act="gotab" data-tab="drives">Open the Drives section (team / matchup)</button></p>' : ''}
   <p class="small">Every team drive since ${D.season - 1}, per player: who gets the touches on which drive and in which game phase. ${driveStatusLine(D)}</p>
   <div class="kv small"><div>Exact drive-number patterns<br><strong>${C.drive.fdr} of ${C.drive.tests.toLocaleString()}</strong> survive FDR <span class="muted">(${C.drive.raw05} at p&lt;0.05, ${C.drive.expectedByChance} expected by chance)</span></div>
     <div>Phase patterns<br><strong>${C.phase.fdr} of ${C.phase.tests.toLocaleString()}</strong> survive FDR <span class="muted">(${C.phase.raw05} at p&lt;0.05, ${C.phase.expectedByChance} by chance)</span></div>
     <div>Out-of-sample lift kept<br>drive # <strong>${ret(P?.drive?.fdr)}</strong> · phase <strong>${ret(P?.phase?.fdr)}</strong></div></div>
   <ol class="dtop small">${top.map(t => { const s = inSlate.get(t.pid); const nm = s ? `<button class="plink" data-act="player" data-game="${esc(s.g.id)}" data-player="${esc(s.p.id)}">${esc(t.name)}</button>` : esc(t.name); return `<li>${relChip(t.rel)} <strong>${nm}</strong> <span class="muted">${esc(t.pos || '')} · ${esc(t.team)}</span><br>${esc(t.text.replace(/, (strong|moderate)\)$/, ')'))}</li>`; }).join('') || '<li class="muted">No pattern passed the reliability checks this week.</li>'}</ol>
   <p class="small muted">${D.appVersion ? `App ${esc(D.appVersion)} · model ${esc(D.modelVersion || '')} (${S.slate?.learned?.components?.drives?.enabled ? 'drive adjustment active in the headline chance' : D.fit ? `headline unchanged; drive adjustment runs as the "blend + drives" challenger at weight ${D.fit.weight.blend}` : 'unchanged: drive patterns are display-only'}). ` : ''}Out-of-sample lift kept: patterns found through week N, scored on week N+1 (100% = the pattern held fully, 0% = it was noise around his normal share).</p></div>`;
}
// ---------- Drives section (app 4.8): team or matchup picker over the weekly drive file (archive/drives/<s>/w<w>.json).
// Everything here is pre-game (drives before this week). "What the model sees" = the drive-pattern adjustment the engine
// computes (src/drive-adjust.js); it moves a chance only by the walk-forward weight the Tuesday gate allows.
const LS_DRIVES = 'endzone.drives.v1';
S.dv = Object.assign({ mode: 'team', team: 'DET', game: '', a: '', b: '', n: 6, who: '', lg: '', pl: '', st: 'rec', th: 1 }, load(LS_DRIVES, {}));
const saveDv = () => save(LS_DRIVES, S.dv);
const PHASE_ROWS = [
  ['open', 'Opening script (drives 1–2)', d => d[0] <= 2], ['rz', 'Red zone', d => (d[3] & 4) > 0], ['gtg', 'Goal to go', d => (d[3] & 8) > 0],
  ['lead', 'Leading', d => d[2] > 0], ['trail', 'Trailing', d => d[2] < 0], ['two', 'Two-minute', d => (d[3] & 2) > 0], ['all', 'All drives', () => true]];
const RES_LBL = { TD: 'Touchdown', FG: 'Field goal', MFG: 'Missed field goal', Punt: 'Punt', TO: 'Turnover', Downs: 'Turnover on downs', Half: 'End of half', Safety: 'Safety' };
const ppSigned = x => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} pp`);
const pctSigned = x => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const ord = n => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const slateIndex = D => { const M = new Map(); for (const g of S.slate?.games || []) for (const sd of ['away', 'home']) for (const p of g.sides[sd].players) { const k = p.gsis && D.players[p.gsis] ? p.gsis : D.bySleeper?.[p.id]; if (k) M.set(k, { g, p, sd }); } return M; };
const teamGames = (D, team, n) => { const G = D.teams?.[team]?.games || []; return n === 'season' ? G : G.slice(-n); };
function teamTendencies(D, team, n) {
  const T = D.teams?.[team]; if (!T) return null; const G = teamGames(D, team, n); const people = T.people;
  const rows = PHASE_ROWS.map(([k, label, f]) => {
    const ds = G.flatMap(g => g.d.filter(f)); const tgt = ds.reduce((s, d) => s + d[6], 0), car = ds.reduce((s, d) => s + d[7], 0);
    const who = new Map(); for (const d of ds) for (const x of d[8]) who.set(x[0], (who.get(x[0]) || 0) + x[1] + x[4]);
    const tot = tgt + car; const top = [...who.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([pi, c]) => ({ name: people[pi][1], pos: people[pi][2], share: tot ? c / tot : 0 }));
    return { k, label, drives: ds.length, plays: ds.length ? ds.reduce((s, d) => s + d[4], 0) / ds.length : null, pass: tot ? tgt / tot : null, rz: ds.length ? ds.filter(d => d[3] & 4).length / ds.length : null, td: ds.length ? ds.filter(d => d[5] === 'TD').length / ds.length : null, top };
  });
  return { games: G.length, rows };
}
function tendTable(t, compact = false) {
  if (!t) return '<p class="small muted">No drive history for this team yet.</p>';
  return `<div class="tablewrap" tabindex="0" role="region" aria-label="Tendencies by phase"><table class="dtend"><thead><tr><th scope="col">Phase</th><th scope="col">Drives</th>${compact ? '' : '<th scope="col">Plays / drive</th>'}<th scope="col">Pass share</th><th scope="col">Red zone</th><th scope="col">TD</th><th scope="col">Who gets the ball</th></tr></thead><tbody>
   ${t.rows.map(r => `<tr${r.k === 'all' ? ' class="tot"' : ''}><th scope="row">${esc(r.label)}</th><td>${r.drives}</td>${compact ? '' : `<td>${n1(r.plays)}</td>`}<td>${pct0(r.pass)}</td><td>${r.k === 'rz' || r.k === 'gtg' ? '—' : pct0(r.rz)}</td><td>${pct0(r.td)}</td><td class="who">${r.top.map(x => `${esc(shortName(x.name))} <span class="muted">${pct0(x.share)}</span>`).join(', ') || '—'}</td></tr>`).join('')}</tbody></table></div>
   <p class="small muted">Pass share = targets ÷ (targets + carries). "Who gets the ball" = share of the team's targets + carries on those drives. Red-zone rate = drives that reached the opponent's 20.</p>`;
}
function driveGrid(D, team, n) {
  const T = D.teams?.[team]; if (!T) return ''; const G = teamGames(D, team, n).slice().reverse(); if (!G.length) return '';
  const who = S.dv.who && T.people.findIndex(x => x[0] === S.dv.who); const pi = who >= 0 && who !== '' ? who : -1;
  const maxN = Math.max(...G.map(g => g.d.length)); const cols = Array.from({ length: maxN }, (_, i) => i + 1);
  const cell = (g, d) => {
    if (!d) return '<td class="dg na"></td>'; const rz = d[3] & 4, td = d[5] === 'TD';
    let body; if (pi >= 0) { const x = d[8].find(y => y[0] === pi); body = x ? `${x[1] ? `<span>${x[1]}t ${x[2]}c ${x[3]}y</span>` : ''}${x[4] ? `<span>${x[4]}r ${x[5]}y</span>` : ''}${x[7] ? '<b>TD</b>' : ''}` || '·' : '<span class="muted">·</span>'; }
    else body = `<b>${esc(d[5])}</b><span>${d[6]}t ${d[7]}r</span>`;
    return `<td class="dg${td ? ' td' : ''}${rz ? ' rz' : ''}"><button class="dgb" data-act="dcell" data-w="${g.w}" data-n="${d[0]}" aria-label="Week ${g.w} drive ${d[0]}: ${esc(RES_LBL[d[5]] || d[5])}">${body}</button></td>`;
  };
  return `<div class="row small" role="group" aria-label="Grid player"><label>Show <select class="select" id="dvWho"><option value="">Team (result, targets, carries)</option>${T.people.map(p => `<option value="${esc(p[0])}" ${S.dv.who === p[0] ? 'selected' : ''}>${esc(p[1])} · ${esc(p[2])}</option>`).join('')}</select></label></div>
   <div class="tablewrap drivegrid" tabindex="0" role="region" aria-label="Drive-by-drive grid"><table class="dgrid"><thead><tr><th scope="col">Game</th>${cols.map(c => `<th scope="col">${c}</th>`).join('')}</tr></thead><tbody>
   ${G.map(g => `<tr><th scope="row">W${g.w} <span class="muted">${esc(g.opp)}</span></th>${cols.map(c => cell(g, g.d[c - 1])).join('')}</tr>`).join('')}</tbody></table></div>
   <div id="dcellOut" class="small dcellout" aria-live="polite"><span class="muted">Tap a drive for every player's line.</span></div>
   <p class="small muted">${pi >= 0 ? 't = targets, c = catches, r = carries, y = yards.' : 't = targets, r = carries; result code on top.'} Gold = touchdown drive; outlined = reached the red zone. Newest game first; the grid scrolls inside its box.</p>`;
}
function dcellHtml(D, team, w, n) {
  const T = D.teams?.[team]; const g = T?.games.find(x => x.w === +w); const d = g?.d.find(x => x[0] === +n); if (!d) return '';
  return `<strong>Week ${g.w} vs ${esc(g.opp)} · drive ${d[0]}</strong> · ${esc(RES_LBL[d[5]] || d[5])} · ${d[4]} plays · ${d[1] === 1 ? '1st' : '2nd'} half · score ${d[2] > 0 ? '+' : ''}${d[2]}${d[3] & 4 ? ' · red zone' : ''}${d[3] & 8 ? ' · goal to go' : ''}${d[3] & 2 ? ' · two-minute' : ''}
   <ul>${d[8].map(x => `<li>${esc(T.people[x[0]][1])}: ${x[1] ? `${x[1]} tgt, ${x[2]} rec, ${x[3]} yds` : ''}${x[1] && x[4] ? ' · ' : ''}${x[4] ? `${x[4]} car, ${x[5]} yds` : ''}${x[6] ? ' · red zone' : ''}${x[7] ? ' · <strong>TD</strong>' : ''}</li>`).join('') || '<li class="muted">No targets or carries recorded.</li>'}</ul>`;
}
// ---- 4.8.1: drive-by-drive log (every drive, every player's line, nothing behind a tap) and the player-by-drive threshold table
function driveLogHtml(D, team, n) {
  const T = D.teams?.[team]; if (!T) return ''; const G = teamGames(D, team, n).slice().reverse(); if (!G.length) return '<p class="small muted">No drives yet.</p>';
  const g = G.find(x => x.w === +S.dv.lg) || G[0];
  const tds = g.d.filter(d => d[5] === 'TD').length, rz = g.d.filter(d => d[3] & 4).length;
  const pl = (x, d) => { const nm = personName(D, T, x[0]); return `<span class="dlpl"><button class="plink" data-act="dvpl" data-pid="${esc(T.people[x[0]][0])}" title="${esc(nm)}: show by drive">${esc(shortName(nm))}</button> ${esc(statLine(x)).replace(', TD', ', <strong>TD</strong>')}</span>`; };
  const rows = g.d.map(d => { const ps = d[8].slice().sort((a, b) => (b[2] + b[4]) - (a[2] + a[4]) || b[1] - a[1]);
    return `<tr class="${d[5] === 'TD' ? 'td' : ''}${d[3] & 4 ? ' rz' : ''}"><td class="dln" data-l="Drive">${d[0]}</td><td data-l="">${d[9] ? (d[9] > 4 ? 'OT' : 'Q' + d[9]) : (d[1] === 1 ? '1st half' : '2nd half')}</td><td data-l="Start">${esc(ylText(d[10], team, g.opp))}</td><td data-l="Plays">${d[4]}</td><td class="dlres" data-l=""><b>${esc(RES_LBL[d[5]] || d[5])}</b>${d[3] & 8 ? ' <span class="muted">goal to go</span>' : d[3] & 4 ? ' <span class="muted">red zone</span>' : ''}</td>
     <td class="dlp">${ps.length ? ps.map(x => pl(x, d)).join('<span class="dlsep"> · </span>') : '<span class="muted">No targets or carries (sacks, kneels or penalties only).</span>'}</td></tr>`; }).join('');
  return `<div class="row small"><label>Game <select class="select" id="dvLogG">${G.map(x => `<option value="${x.w}" ${x === g ? 'selected' : ''}>Week ${x.w} vs ${esc(x.opp)}</option>`).join('')}</select></label></div>
   <p class="small">${esc(team)} vs ${esc(g.opp)}, week ${g.w}: <strong>${g.d.length}</strong> drives · <strong>${tds}</strong> TD · ${rz} reached the red zone. Tap a name for that player's drive-by-drive table.</p>
   <div class="tablewrap dlogwrap" tabindex="0" role="region" aria-label="Drive log, week ${g.w}"><table class="dlog"><thead><tr><th scope="col">Drive</th><th scope="col">Qtr</th><th scope="col">Start</th><th scope="col">Plays</th><th scope="col">Result</th><th scope="col">Who got the ball</th></tr></thead><tbody>${rows}</tbody></table></div>
   <p class="small muted">rec = receptions, tgt = targets, car = carries; yards are receiving or rushing yards on that drive. Gold edge = touchdown drive. Start = yard line of the first snap.</p>`;
}
function playerByDriveHtml(D, team, n) {
  const T = D.teams?.[team]; if (!T) return ''; const G = teamGames(D, team, n);
  const inv = new Map(); for (const g of G) for (const d of g.d) for (const x of d[8]) inv.set(x[0], (inv.get(x[0]) || 0) + x[1] + x[4]);
  const opts = T.people.map((p, i) => ({ pid: p[0], i, name: personName(D, T, i), pos: p[2], k: inv.get(i) || 0 })).filter(o => o.k > 0).sort((a, b) => b.k - a.k);
  if (!opts.length) return '<p class="small muted">No player data in this window.</p>';
  const pid = opts.some(o => o.pid === S.dv.pl) ? S.dv.pl : opts[0].pid; const me = opts.find(o => o.pid === pid);
  const st = STATS[S.dv.st] ? S.dv.st : 'rec'; const th = Number.isFinite(+S.dv.th) && +S.dv.th >= 0 ? +S.dv.th : 1;
  const R = playerDriveRows(T, pid, G); const H = hitSummary(R.rows, st, th, R.maxN); const P = D.players?.[pid];
  const cols = Array.from({ length: R.maxN }, (_, i) => i + 1); const tl = thLabel(st, th);
  const statBtns = Object.entries(STATS).map(([k, s]) => `<button class="btn ${k === st ? 'gold' : ''}" data-act="dvst" data-st="${k}" aria-pressed="${k === st}">${s.label}</button>`).join('');
  const pre = PRESETS.map(([s, t]) => `<button class="btn ${s === st && t === th ? 'gold' : ''}" data-act="dvth" data-st="${s}" data-th="${t}" aria-pressed="${s === st && t === th}">${thLabel(s, t)}</button>`).join('');
  const cell = (r, c) => { const has = c <= r.nDrives; if (!has) return '<td class="pbd na"></td>'; const x = r.by.get(c); const d = r.drives[c - 1]; const hit = meets(x, st, th);
    return `<td class="pbd${hit ? ' hit' : ''}${d[5] === 'TD' ? ' td' : ''}" title="Drive ${c}: ${esc(RES_LBL[d[5]] || d[5])}">${esc(cellText(x, st))}${x?.[7] ? ' <b>TD</b>' : ''}</td>`; };
  const grid = R.rows.length ? `<div class="tablewrap pbdwrap" tabindex="0" role="region" aria-label="${esc(me.name)} by drive"><table class="pbdt"><thead><tr><th scope="col">Game</th>${cols.map(c => `<th scope="col">D${c}</th>`).join('')}<th scope="col">Hit</th></tr></thead><tbody>
   ${R.rows.map(r => { const h = r.drives.filter(d => meets(r.by.get(d[0]), st, th)).length; return `<tr><th scope="row">W${r.w} <span class="muted">${esc(r.opp)}</span></th>${cols.map(c => cell(r, c)).join('')}<td class="mid">${h}/${r.nDrives}</td></tr>`; }).join('')}</tbody></table></div>` : '';
  const yLbl = STATS[st].fam === 'rec' ? 'rec yds' : STATS[st].fam === 'rush' ? 'rush yds' : 'yds';
  const lbl = n2 => { const L = driveLabel(P, n2); return L.label === 'pattern' ? `<span class="chip rel-${esc(L.rel)}" title="${esc(L.text || '')}">pattern</span>` : `<span class="chip rel-chance" title="${esc(L.text ? 'Close but not reliable: ' + L.text : 'No drive-number test for this player passed FDR + persistence')}">small sample / likely chance</span>`; };
  const summ = `<div class="tablewrap" tabindex="0" role="region" aria-label="Hit rate by drive number"><table class="pbds"><thead><tr><th scope="col">Drive</th><th scope="col">Hit rate</th><th scope="col">Avg ${yLbl}</th><th scope="col">Reliability</th></tr></thead><tbody>
   ${H.byDrive.map(b => `<tr><th scope="row">Drive ${b.n}</th><td>${tl} in <strong>${b.hits} of ${b.games}</strong> games <span class="muted">${pct0(b.rate)}</span></td><td>${n1(b.avgYds)}</td><td class="rel">${lbl(b.n)}</td></tr>`).join('')}
   <tr class="base"><th scope="row">Any drive</th><td>${tl} on <strong>${H.all.hits} of ${H.all.drives}</strong> drives <span class="muted">${pct0(H.all.rate)}</span></td><td>${n1(H.all.avgYds)}</td><td class="rel muted">baseline</td></tr></tbody></table></div>`;
  const pats = (P?.patterns || []).filter(t => /^d\d+$/.test(t.sub));
  return `<div class="row small"><label>Player <select class="select" id="dvPl">${opts.map(o => `<option value="${esc(o.pid)}" ${o.pid === pid ? 'selected' : ''}>${esc(o.name)} · ${esc(o.pos || '')}</option>`).join('')}</select></label></div>
   <div class="row small" role="group" aria-label="Stat">${statBtns}</div>
   <div class="row small dvth" role="group" aria-label="Threshold">${pre}<label>Custom ${esc(STATS[st].unit)} ≥ <input class="input dvthc" id="dvThC" type="number" inputmode="numeric" min="0" step="1" value="${th}"></label></div>
   <p class="small"><strong>${esc(me.name)}</strong>: ${tl} on ${H.all.hits} of ${H.all.drives} drives (${pct0(H.all.rate)}) across ${R.rows.length} game${R.rows.length === 1 ? '' : 's'}${R.skipped ? ` <span class="muted">(${R.skipped} team game${R.skipped === 1 ? '' : 's'} without a target or carry left out)</span>` : ''}. Highlighted cells meet ${tl}.</p>
   ${grid}<h4>By drive number</h4>${summ}
   <p class="small muted">Labels come from the existing drive-number tests (his share of the team's touches on drive N vs his other drives, 2025–26, Benjamini–Hochberg q ≤ 0.10 and out-of-sample persistence). "pattern" only if that survives; everything else is "small sample / likely chance" — with ${R.rows.length} games, a drive at ${pct0(H.all.rate)} baseline will often show 0 of ${R.rows.length} or ${R.rows.length} of ${R.rows.length} by luck alone. Hit rates are this season before week ${D.week}.${pats.length ? ` Drive-number patterns on file: ${pats.map(t => esc(t.text)).join('; ')}.` : ''}</p>`;
}
function offenseKv(D, team) {
  const o = D.offense?.[team], L = D.league; if (!o) return '';
  return `<div class="kv small"><div>Drives / game<br><strong>${n1(o.dpg)}</strong> <span class="muted">lg ${n1(L.dpg)}</span></div><div>Plays / drive<br><strong>${n1(o.playsPerDrive)}</strong></div>
   <div>Reach red zone<br><strong>${pct0(o.rzPerDrive)}</strong> <span class="muted">lg ${pct0(L.rzPerDrive)}</span></div><div>TD per drive<br><strong>${pct0(o.tdPerDrive)}</strong> <span class="muted">lg ${pct0(L.tdPerDrive)}</span></div>
   <div>TD per red-zone trip<br><strong>${pct0(o.rzTd)}</strong> <span class="muted">lg ${pct0(L.rzTd)}</span></div><div>Opening-script TD<br><strong>${pct0(o.openTd)}</strong> <span class="muted">lg ${pct0(L.openTd)}</span></div></div>
   <p class="small muted">${D.season} season before week ${D.week} (${o.games ?? D.defense?.[team]?.games ?? '—'} games).</p>`;
}
// ---- the model's view of one player: patterns (strong / moderate), watch items, adjustment at the fitted weight and full weight
function modelView(D, gsis, { opp = null, spread = null, chance = null, blend = null } = {}) {
  const r = D.players[gsis]; if (!r) return null; const pats = r.patterns || [], watch = r.watch || [];
  if (!pats.length && !watch.length) return null;
  const pl = { gsis, team: r.team, pos: r.pos, id: gsis };
  const wB = D.fit?.weight?.blend || 0, wM = S.slate?.learned?.components?.drives?.enabled ? (D.fit?.weight?.model || 0) : 0;
  const a = opp ? driveAdjustFor(D, pl, { opp, spread, weight: wM }) : null; const full = opp ? driveAdjustFor(D, pl, { opp, spread, weight: 1 }) : null;
  return { gsis, r, pats, watch, a, full, wB, wM, chance, blend, nowPP: a && chance != null ? applyToChance(chance, a.logm) - chance : null, fullPP: full && chance != null ? applyToChance(chance, full.logm) - chance : null };
}
function modelViewHtml(D, m, { name = true, link = '' } = {}) {
  const ctxBits = (m.full?.items || []).map(x => x.why).filter(Boolean);
  return `<li class="mv"><div class="mvhead">${name ? `<strong>${link || esc(m.r.name)}</strong> <span class="muted">${esc(m.r.pos)} · ${esc(m.r.team)}</span>` : ''}${m.chance != null ? ` <span class="mvnum">anytime <strong>${pc(m.chance, 1)}</strong>${m.blend != null ? ` · blend ${pc(m.blend, 1)}` : ''}</span>` : ''}</div>
   ${m.pats.length ? `<ul class="mvp">${m.pats.map(t => `<li>${relChip(t.rel)} <span class="ptag">Pattern</span> ${esc(t.text.replace(/, (strong|moderate)\)$/, ')'))}</li>`).join('')}</ul>` : ''}
   ${m.watch.length ? `<ul class="mvw">${m.watch.map(t => `<li><span class="chip rel-watch">worth watching</span> ${esc(t.text.replace(/, worth watching\)$/, ')'))} <span class="muted">— not a pattern: ${esc(t.why || `did not pass the reliability checks (q ${t.q})`)}</span></li>`).join('')}</ul>` : ''}
   ${m.full && m.pats.length ? `<p class="mveff">This week: ${ctxBits.length ? esc(ctxBits.join('; ')) + '. ' : ''}Signal at full weight <strong>${pctSigned(Math.exp(m.full.logm) - 1)}</strong> on his TD intensity${m.fullPP != null ? ` (${ppSigned(m.fullPP)})` : ''}${m.full.capped ? ', capped at ±10%' : ''}. <strong>Applied now: ${m.nowPP != null ? ppSigned(m.nowPP) : pctSigned(Math.exp(m.a?.logm || 0) - 1)}</strong> <span class="muted">(weight ${m.wM}${m.wM ? '' : ' — walk-forward fit gave 0, see the scoreboard'})</span>.</p>` : m.pats.length ? '' : '<p class="mveff muted">Only "worth watching" items: they never move a number.</p>'}</li>`;
}
function playerPatternsHtml(D, team, opp = null, spread = null) {
  const idx = slateIndex(D);
  const ids = Object.entries(D.players).filter(([, r]) => r.team === team && ((r.patterns || []).length || (r.watch || []).length)).map(([g]) => g);
  const L = ids.map(g => { const s = idx.get(g); return modelView(D, g, { opp, spread, chance: s?.p.chance ?? null, blend: s?.p.challenger ?? null }); }).filter(Boolean)
    .sort((a, b) => b.pats.length - a.pats.length || (b.chance ?? 0) - (a.chance ?? 0));
  if (!L.length) return `<p class="small">No player pattern for ${esc(team)} passed the reliability checks this week, and nothing is close enough to watch.</p>`;
  return `<ul class="mvlist small">${L.map(m => { const s = idx.get(m.gsis); return modelViewHtml(D, m, { link: s ? `<button class="plink" data-act="player" data-game="${esc(s.g.id)}" data-player="${esc(s.p.id)}">${esc(m.r.name)}</button>` : '' }); }).join('')}</ul>`;
}
const DEF_ROWS = [['rzPer', 'Red-zone trips per drive', 'rzPerDrive'], ['tdPer', 'TDs per drive', 'tdPerDrive'], ['rzTd', 'TDs per red-zone trip', 'rzTd'], ['gtgTd', 'TDs per goal-to-go drive', 'gtgTd'], ['openTd', 'Opening-script TD rate', 'openTd']];
function defenseHtml(D, team) {
  const d = D.defense?.[team], L = D.league; if (!d) return '<p class="small muted">No defensive drive profile yet.</p>';
  const sig = k => d.q[k] <= 0.10 ? `<span class="chip rel-strong">significant (q ${d.q[k].toFixed(2)})</span>` : `<span class="muted">rank only (q ${d.q[k].toFixed(2)})</span>`;
  const pos = ['RB', 'WR', 'TE', 'QB'];
  return `<div class="tablewrap" tabindex="0" role="region" aria-label="${esc(team)} defense drive profile allowed"><table class="ddef"><thead><tr><th scope="col">${esc(team)} D allowed</th><th scope="col">Rate</th><th scope="col">n</th><th scope="col">League</th><th scope="col">Rank</th><th scope="col">Test</th></tr></thead><tbody>
   ${DEF_ROWS.map(([k, l, lk]) => `<tr><th scope="row">${l}</th><td>${pct0(d.rate[k])}</td><td>${d.n[k][0]}/${d.n[k][1]}</td><td>${pct0(L[lk])}</td><td>${d.rank[k]} of 32</td><td>${sig(k)}</td></tr>`).join('')}</tbody></table></div>
   <div class="tablewrap" tabindex="0" role="region" aria-label="Who scores against ${esc(team)}"><table class="ddef"><thead><tr><th scope="col">TDs allowed by position</th>${pos.map(p => `<th scope="col">${p}</th>`).join('')}</tr></thead><tbody>
   ${['rz', 'gtg'].map(s => `<tr><th scope="row">${s === 'rz' ? 'Red zone' : 'Goal to go'} <span class="muted">(${d.posIdx[s].tds} TDs)</span></th>${pos.map(p => `<td>${d.posTds[s][p] || 0} <span class="muted">${pct0(d.posShare[s][p])} · lg ${pct0(L.posShare[s][p])}</span></td>`).join('')}</tr>`).join('')}</tbody></table></div>
   <p class="small muted">${d.games} games, ${d.drives} drives faced (${n1(d.dpg)} per game). Rank 1 = allowed the most. Rates are tested against the league (exact binomial, Benjamini–Hochberg across all 32 × 5 tests); "rank only" means the difference is not distinguishable from chance yet.</p>`;
}
function defenseSentences(D, team, offense) {
  const d = D.defense?.[team]; if (!d) return [];
  const out = []; const sigs = DEF_ROWS.filter(([k]) => d.q[k] <= 0.10);
  for (const [k, l] of sigs) out.push({ rel: 'pattern', text: `${team}'s defense: ${(/^[A-Z][a-z]/.test(l) ? l[0].toLowerCase() + l.slice(1) : l)} ${pct0(d.rate[k])} vs league ${pct0(D.league[DEF_ROWS.find(x => x[0] === k)[2]])} — significant after the FDR check.` });
  const ext = DEF_ROWS.filter(([k]) => d.q[k] > 0.10 && (d.rank[k] <= 3 || d.rank[k] >= 30));
  for (const [k, l] of ext) out.push({ rel: 'watch', text: `${team}'s defense has the ${(r => r === 1 ? '' : ord(r) + '-')(d.rank[k] <= 3 ? d.rank[k] : 33 - d.rank[k])}${d.rank[k] <= 3 ? 'highest' : 'lowest'} rate of ${(/^[A-Z][a-z]/.test(l) ? l[0].toLowerCase() + l.slice(1) : l)} allowed (${pct0(d.rate[k])} vs league ${pct0(D.league[DEF_ROWS.find(x => x[0] === k)[2]])}, ${d.n[k][0]}/${d.n[k][1]}), but with ${d.games} games that is not distinguishable from chance (q ${d.q[k].toFixed(2)}).` });
  const pr = d.rank.pos || {}; for (const [k, v] of Object.entries(pr)) if (v <= 2) { const s = k.slice(0, -2), p = k.slice(-2); out.push({ rel: 'watch', text: `${offense}'s ${p}s: ${team} has allowed ${pct0(d.posShare[s]?.[p])} of its ${s === 'rz' ? 'red-zone' : 'goal-to-go'} TDs to ${p}s (league ${pct0(D.league.posShare[s]?.[p])}; ${d.posTds[s]?.[p] || 0} of ${d.posIdx[s].tds}) — descriptive only.` }); }
  return out;
}
function scoreboardHtml(D, where = 'drives') {
  const F = D?.fit; if (!F) return '<p class="small muted">The walk-forward fit has not run yet (Tuesday auto run with --fit).</p>';
  const gate = S.slate?.learned?.components?.drives; const pr = S.slate?.learned?.drivesPromotion; const mon = pr?.monitor;
  const f = x => (x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(3)}`); const ci = a => (a ? `[${f(a[0])}, ${f(a[1])}]` : '');
  const row = (lbl, x) => x ? `<tr><th scope="row">${lbl}</th><td>${x.n.toLocaleString()} / ${x.games}</td><td>${f(x.dBrier)} <span class="muted">${ci(x.dBrierCI)}</span></td><td>${f(x.dLogLoss)} <span class="muted">${ci(x.dLogLossCI)}</span></td></tr>` : '';
  return `<div class="tablewrap" tabindex="0" role="region" aria-label="With vs without drive patterns"><table class="dscore"><thead><tr><th scope="col">With − without drive patterns</th><th scope="col">Players / games</th><th scope="col">ΔBrier ×1000</th><th scope="col">Δlog loss ×1000</th></tr></thead><tbody>
   ${row('Blend + drives vs blend (walk-forward, all)', F.all?.blend)}${row('Model + drives vs model (walk-forward, all)', F.all?.model)}${row('Blend + drives vs blend (prospective snapshots)', F.prosp?.blend)}${mon?.withDrives_vs_blend ? row('Live: graded since 4.8 snapshots', mon.withDrives_vs_blend) : ''}</tbody></table></div>
   <p class="small">Fitted weight: blend <strong>${F.weight.blend}</strong> · model <strong>${F.weight.model}</strong> (grid 0–3, chosen each week from earlier weeks only; ${F.rows.toLocaleString()} player-games, ${F.all?.n ? `${F.all.blend.n.toLocaleString()} scored` : ''}). ${esc(F.note || '')}</p>
   <p class="small">Status: <strong>${gate?.enabled ? `active in the model (weight ${gate.weight})` : 'challenger only'}</strong>${gate?.reason ? ` — ${esc(gate.reason)}` : ' — the Tuesday gate has not decided yet; until it passes the headline chance never uses drive patterns.'}${pr ? ` Promotion check: ${pr.promote ? 'passes' : esc((pr.reasons || []).join(' '))}` : ''}</p>
   ${F.movedPP ? `<p class="small muted">If the adjustment were applied at the walk-forward weights it would have moved a chance by a median ${F.movedPP.median.toFixed(2)} pp (90th pct ${F.movedPP.p90.toFixed(2)}, max ${F.movedPP.max.toFixed(2)}) on ${F.movedPP.n} player-games with patterns. Negative Δ = drive patterns helped. Intervals resample whole games. Refit every Tuesday.</p>` : ''}`;
}
function seesHtml(D, gA, gB, ctx) {
  // ctx: {spreadA, spreadB}
  const lines = [];
  for (const [off, def, sp] of [[gA, gB, ctx.spreadA], [gB, gA, ctx.spreadB]]) {
    const xd = (D.offense[off]?.dpg + D.defense[def]?.dpg) / 2;
    lines.push(`<li><span class="ptag ctx">Context</span> ${esc(off)} offense vs ${esc(def)} defense: about <strong>${n1(xd)}</strong> expected drives (league ${n1(D.league.dpg)})${sp != null ? `; ${esc(off)} ${sp > 0 ? '+' : ''}${sp} → P(leading in the 2nd half) ${pct0(pLead(sp))}` : ''}.</li>`);
    for (const s of defenseSentences(D, def, off)) lines.push(`<li>${s.rel === 'pattern' ? '<span class="chip rel-strong">pattern</span>' : '<span class="chip rel-watch">worth watching</span>'} ${esc(s.text)}</li>`);
  }
  const idx = slateIndex(D);
  for (const [off, def, sp] of [[gA, gB, ctx.spreadA], [gB, gA, ctx.spreadB]]) for (const [gs, r] of Object.entries(D.players)) {
    if (r.team !== off || !(r.patterns || []).length) continue; const s = idx.get(gs);
    const m = modelView(D, gs, { opp: def, spread: sp, chance: s?.p.chance ?? null, blend: s?.p.challenger ?? null }); if (!m) continue;
    const full = Math.exp(m.full.logm) - 1;
    lines.push(`<li><span class="chip rel-${esc(m.pats[0].rel)}">pattern</span> <strong>${esc(r.name)}</strong> <span class="muted">${esc(r.pos)} · ${esc(off)}${m.chance != null ? ` · anytime ${pc(m.chance, 1)}${m.blend != null ? `, blend ${pc(m.blend, 1)}` : ''}` : ''}</span>: ${m.pats.map(t => esc(t.text.replace(/, (strong|moderate)\)$/, ')'))).join('; ')}. Against ${esc(def)} that is a ${full >= 0 ? 'boost' : 'cut'} of ${pctSigned(full)} at full weight${m.full.capped ? ' (at the cap: ×1.1 up, ÷1.1 down)' : ''}; applied now ${m.nowPP != null ? ppSigned(m.nowPP) : pctSigned(Math.exp(m.a.logm) - 1)}.</li>`);
  }
  return `<ul class="sees small">${lines.join('')}</ul>`;
}
// ---------- 4.9.0: game simulator (Drives → Simulator). Research / UI only: plays the matchup out drive by drive 10,000
// times from the model's pre-game inputs (src/sim.js) in a Web Worker. Never feeds the live chance or the gate.
const SIM_N = 10000;
S.sim = { mode: load('endzone.simMode', 'drive') === 'pbp' ? 'pbp' : 'drive', prog: null, partial: null, replay: null, rg: null, E: null, key: '', status: 'idle', sum: null, raw: null, ms: null, err: null, team: 'both', st: 'rec', th: 4, pj: null, dst: 'rec', dth: 1, seed: null, ds: 0 };
let simW = null, simSeq = 0;
const simSideFor = t => { for (const x of S.slate?.games || []) for (const sd of ['away', 'home']) if (x.sides[sd].team === t) return x.sides[sd]; return null; };
function simPick() {
  const D = drivesData(); const teams = Object.keys(D?.teams || {}).sort(); const games = S.slate?.games || [];
  const g = S.dv.game && S.dv.game !== 'custom' ? games.find(x => x.id === S.dv.game) : null;
  const A = g ? g.sides.away.team : S.dv.a || teams[0], B = g ? g.sides.home.team : S.dv.b || teams[1];
  const mode = S.sim.mode === 'pbp' && S.slate?.pbp ? 'pbp' : 'drive';
  return { g, A, B, mode, key: `${S.week}|${A}@${B}|${mode}` };
}
function simDone(m, key) {
  if (S.sim.key !== key) return; if (!m.ok) { S.sim.status = 'error'; S.sim.err = m.error; paintSim(); return; }
  Object.assign(S.sim, { status: 'done', sum: m.sum, raw: m.raw, ms: m.ms, msPilot: m.msPilot ?? null, wall: Math.round(performance.now() - S.sim.t0), pj: null, prog: null, partial: null, replay: null, rg: null }); paintSim();
}
// 4.10.0: live progress (play-by-play mode posts every 250 games; a partial read-out every 1,000)
function simProgress(m, key) {
  if (S.sim.key !== key || S.sim.status !== 'running') return; S.sim.prog = m.progress; if (m.partial) S.sim.partial = m.partial;
  const el = document.getElementById('simProg'); if (el) el.outerHTML = simProgHtml(); else paintSim();
}
function simProgHtml() {
  const pr = S.sim.prog, pa = S.sim.partial; if (!pr) return '<div id="simProg" class="simprog small muted" aria-live="polite">Starting…</div>';
  const pctDone = pr.n ? pr.done / pr.n : 0; const s = S.sim.inputs;
  const part = pa?.done ? `<p class="small">So far (${pa.done.toLocaleString()} games): ${esc(s.away)} ${pa.pts[0].toFixed(1)} – ${esc(s.home)} ${pa.pts[1].toFixed(1)} on average · ${esc(s.away)} wins ${pc(pa.win[0])}, ${esc(s.home)} ${pc(pa.win[1])}<br>Top 4 TD scorers so far: ${pa.top4.map(t => `${esc(t.name)} <span class="muted">${esc(t.team)}</span> <strong>${pc(t.p)}</strong>`).join(' · ')}</p>` : '';
  return `<div id="simProg" class="simprog"><div class="row between small"><span aria-live="polite"><strong>${pr.phase === 'pilot' ? 'Matching player roles to the model…' : `Simulated ${pr.done.toLocaleString()} / ${pr.n.toLocaleString()} games`}</strong></span><span class="muted">${Math.round(pctDone * 100)}%</span></div>
   <progress max="${pr.n}" value="${pr.done}" aria-label="Simulation progress">${Math.round(pctDone * 100)}%</progress>${part}</div>`;
}
function simReplay(g) {
  const sum = S.sim.sum; if (!sum || sum.mode !== 'pbp') return; const n = sum.n; if (g == null) g = Math.floor(Math.random() * n);
  S.sim.rg = g; S.sim.replay = { g, status: 'loading' }; paintSim();
  const done = log => { if (S.sim.rg !== g) return; S.sim.replay = { g, status: 'done', log }; paintSim(); document.getElementById('simGame')?.scrollIntoView({ block: 'nearest' }); };
  if (S.sim.E) { setTimeout(() => done(replayGame(S.sim.E, S.sim.seed, g)), 10); return; }
  if (!simW) { S.sim.replay = { g, status: 'error' }; paintSim(); return; }
  simW.postMessage({ id: `r${g}`, replay: g });
}
function runSimUi(newSeed) {
  const D = drivesData(); if (!D) return; const { g, A, B, key, mode } = simPick(); if (A === B) { S.sim = { ...S.sim, key, status: 'error', err: 'Pick two different teams.' }; paintSim(); return; }
  const seed = (Math.random() * 2 ** 31) >>> 0; // fresh 10,000 games every run
  let inputs = buildSimInputs(D, { away: A, home: B, sideFor: simSideFor, lines: g ? g.sides.away.lines || null : null, gameId: g?.id || `${A}@${B}` });
  if (mode === 'pbp') { const pi = buildPbpInputs(inputs, S.slate.pbp); if (!pi) { S.sim = { ...S.sim, key, status: 'error', err: 'No play-by-play parameters for one of these teams yet.' }; paintSim(); return; } inputs = pi; }
  Object.assign(S.sim, { key, status: 'running', sum: null, raw: null, err: null, seed, t0: performance.now(), inputs, prog: mode === 'pbp' ? { done: 0, n: SIM_N, phase: 'pilot' } : null, partial: null, replay: null, rg: null, E: null }); paintSim();
  const id = ++simSeq;
  const inPagePbp = () => { // chunked so the page stays responsive and the counter moves
    try { const t0 = performance.now(); const { E, pilots } = calibratePbp(inputs, { pilots: 2, n: 800, seed: seed + 9 }); const tp = performance.now(); const R = pbpRunner(inputs, { n: SIM_N, seed, E }); let next = 1000;
      const step = () => { if (id !== simSeq) return; try { if (!R.run(250)) { const msg = { progress: { done: R.W.done, n: SIM_N, phase: 'run' } }; if (R.W.done >= next) { msg.partial = pbpPartial(R.W, inputs); next += 1000; } simProgress(msg, key); setTimeout(step, 0); return; }
        const S2 = pbpFinish(R.W, R.E); S2.pilot = pilots; S.sim.E = R.E; simDone({ id, ok: true, ms: Math.round(performance.now() - t0), msPilot: Math.round(tp - t0), sum: summarizePbp(S2, inputs), raw: S2 }, key); } catch (e) { simDone({ ok: false, error: String(e) }, key); } };
      setTimeout(step, 0); } catch (e) { simDone({ ok: false, error: String(e) }, key); } };
  const inPage = () => setTimeout(() => { if (mode === 'pbp') { inPagePbp(); return; } try { const t0 = performance.now(); const R = runSim(inputs, { n: SIM_N, seed }); simDone({ id, ok: true, ms: Math.round(performance.now() - t0), sum: summarize(R, inputs), raw: R }, key); } catch (e) { simDone({ ok: false, error: String(e) }, key); } }, 30);
  try { if (!simW) { simW = window.__ezMakeSimWorker ? window.__ezMakeSimWorker() : new Worker('/src/sim-worker.js', { type: 'module' }); } } catch (e) { simW = null; }
  if (!simW) { inPage(); return; }
  simW.onmessage = e => { const m = e.data || {}; if (m.replay) { if (S.sim.rg === m.replay.g) { S.sim.replay = { g: m.replay.g, status: 'done', log: m.replay.log }; paintSim(); document.getElementById('simGame')?.scrollIntoView({ block: 'nearest' }); } return; }
    if (typeof m.id === 'string' && m.id[0] === 'r') { if (!m.ok && S.sim.replay) { S.sim.replay = { ...S.sim.replay, status: 'error' }; paintSim(); } return; }
    if (m.id !== simSeq) return; if (m.progress) simProgress(m, key); else simDone(m, key); };
  simW.onerror = () => { simW = null; inPage(); };
  simW.postMessage({ id, inputs, n: SIM_N, seed });
}
const simPhrase = (st, th) => st === 'rec' ? (th <= 1 ? 'a catch' : `${th}+ catches`) : st === 'td' ? (th <= 1 ? 'a TD' : `${th}+ TDs`) : `${th}+ ${SIM_LBL[st]?.toLowerCase() || st}`;
const simRange = d => d ? `${n1(d.med)} <span class="muted">(${n1(d.p10)}–${n1(d.p90)})</span>` : '—';
const sgn = x => (x > 0 ? '+' : '') + x;
function simBars(h, lbl, fmt) {
  const max = Math.max(...h.map(x => x[1]), 0.0001); const w = 100 / h.length;
  return `<svg class="simhist" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="${esc(lbl)}">${h.map(([b, p], i) => `<rect x="${(i * w).toFixed(2)}" y="${(40 - 38 * p / max).toFixed(2)}" width="${Math.max(0.3, w - 0.3).toFixed(2)}" height="${(38 * p / max).toFixed(2)}"><title>${esc(fmt(b))}: ${pc(p, 1)}</title></rect>`).join('')}</svg><div class="row between small muted"><span>${esc(fmt(h[0]?.[0] ?? 0))}</span><span>${esc(lbl)}</span><span>${esc(fmt(h[h.length - 1]?.[0] ?? 0))}</span></div>`;
}
function simPlayerDriveHtml(sum, raw) {
  const p = sum.players.find(x => x.j === S.sim.pj); if (!p) return '';
  const st = S.sim.dst, th = S.sim.dth; const rows = playerDriveTable(raw, p.j, st, th, 14);
  const btn = (s, t) => `<button class="btn ${st === s && th === t ? 'gold' : ''}" data-act="simdth" data-st="${s}" data-th="${t}" aria-pressed="${st === s && th === t}">${esc(simPhrase(s, t))}</button>`;
  return `<div class="card simpl" id="simPl"><div class="row between"><h3>${esc(p.name)} · ${esc(p.pos)} · simulated by drive</h3><button class="btn" data-act="simpl" data-j="" aria-label="Close player table">Close</button></div>
   <div class="row" role="group" aria-label="Per-drive threshold">${[...SIM_PRESETS, ['tch', 2], ['td', 1]].map(([s, t]) => btn(s, t)).join('')}<label class="small">Custom <select class="select" id="simDSt">${['rec', 'recYd', 'car', 'rushYd', 'tch', 'tgt'].map(s => `<option value="${s}" ${s === st ? 'selected' : ''}>${SIM_LBL[s]}</option>`).join('')}</select> ≥ <input class="input" id="simDTh" type="number" min="1" max="60" step="1" value="${th}" style="width:5em" inputmode="numeric"></label></div>
   <div class="tablewrap" tabindex="0" role="region" aria-label="${esc(p.name)} simulated by drive"><table class="simtab"><thead><tr><th scope="col">${esc(p.team)} drive</th><th scope="col">Drive happens</th><th scope="col">${esc(simPhrase(st, th))} (all sims)</th><th scope="col">…if the drive happens</th><th scope="col">Any touch, if it happens</th><th scope="col">Avg ${esc(SIM_LBL[st] || st)}</th><th scope="col">TD on drive</th></tr></thead><tbody>
   ${rows.map(r => `<tr><th scope="row">${r.n}${r.last ? '+' : ''}</th><td>${pc(r.happen)}</td><td><strong>${pc(r.pHit)}</strong></td><td>${pc(r.pHitGiven)}</td><td>${pc(r.pTouch)}</td><td>${r.mean.toFixed(2)}</td><td>${pc(r.pTd, 1)}</td></tr>`).join('')}</tbody></table></div>
   <p class="small muted">Simulated: share of the ${sum.n.toLocaleString()} simulated games. "Drive happens" = his team had that many possessions; "(all sims)" counts every simulated game, so it falls on late drives that often never happen; the "if" columns are the rate on that drive when it happened. Game: anytime TD ${pc(p.anytime)} (model ${pc(p.model.chance)}), 2+ TDs ${pc(p.twoPlus)}.${p.pats.length ? ` Validated drive patterns applied to his touch share: ${p.pats.map(t => `${esc(t.sub)} ×${t.mult}`).join(', ')}.` : ''}</p></div>`;
}
// 4.9.1: "Drive N" cards (one per team) and the touchdown-scorer patterns section, written as sentences
const SIM_RES_COL = [['TD', 'TD', 'td'], ['FG', 'FG', 'fg'], ['MFG', 'Missed FG', 'mfg'], ['Punt', 'Punt', 'punt'], ['TO', 'Turnover', 'to'], ['Downs', 'Downs', 'downs'], ['Half', 'End of half', 'half'], ['Safety', 'Safety', 'saf']];
function simDriveTeamHtml(c, fp = '') {
  if (!c.res) return `<div class="simdrive"><h4>${esc(c.team)} · ${esc(c.dname)}</h4><p class="small muted">${esc(c.headline[0])}</p></div>`;
  const segs = SIM_RES_COL.filter(([k]) => c.res[k] >= 0.005);
  const bar = `<div class="simresbar" role="img" aria-label="${esc(c.team)} ${esc(c.dname)} results: ${segs.map(([k, l]) => `${l} ${simPct(c.res[k])}`).join(', ')}">${segs.map(([k, l, cl]) => `<span class="r-${cl}" style="flex:${c.res[k]}" title="${esc(l)} ${simPct(c.res[k])}">${c.res[k] >= (l.length + 4) * 0.012 ? `${esc(l)} ${simPct(c.res[k])}` : ''}</span>`).join('')}</div>`;
  const part = (p, txt) => p >= 0.005 ? txt : '';
  const pl = c.players.slice(0, 7).map(p => { const bits = [
      part(p.pCar1, `gets a carry <strong>${simPct(p.pCar1)}</strong>${p.medRushYd != null ? ` (median ${p.medCar} carr${p.medCar === 1 ? 'y' : 'ies'}, ${p.medRushYd} yd${p.medRushYd === 1 ? '' : 's'} when he does)` : ''}${p.pRush10 >= 0.005 ? `, 10+ rush yds ${simPct(p.pRush10)}` : ''}`),
      part(p.pRec1, `catches a pass <strong>${simPct(p.pRec1)}</strong>${p.pRec2 >= 0.005 ? ` (2+ catches ${simPct(p.pRec2)})` : ''}${p.medRecYd != null ? `, median ${p.medRecYd} yd${p.medRecYd === 1 ? '' : 's'} when he catches one` : ''}${p.pRecYd10 >= 0.005 ? `, 10+ rec yds ${simPct(p.pRecYd10)}` : ''}`),
      `scores the drive's TD <strong>${simPct(p.pTd)}</strong>`].filter(Boolean);
    return `<li><strong>${esc(p.name)}</strong> <span class="muted">${esc(p.pos)}</span> — ${bits.join('; ')}.</li>`; }).join('');
  const links = c.links.slice(0, 4).map(l => `<li>${esc(l.name)} <span class="muted">${esc(l.team)}</span>: scores at some point in <strong>${simPct(l.pIf)}</strong> of those games (vs ${simPct(l.p)} normally).</li>`).join('');
  return `<div class="simdrive"><h4>${esc(c.team)} · ${esc(c.dname)} <span class="small muted">${c.slot ? `happens in ${simPct(c.happen)} of games` : 'every game'}</span></h4>
   <p class="simlead">${esc(c.headline[0])}</p>${bar}${fp}<ul class="small sees">${c.headline.slice(1).map(h => `<li>${esc(h)}</li>`).join('')}</ul>
   <h5>Who touches the ball on this drive</h5><ul class="small simpls">${pl}</ul>
   ${links ? `<h5>If ${esc(c.team)} scores a TD on this drive <span class="chip rel-chance">Sim structure</span></h5><ul class="small simpls">${links}</ul><p class="small muted">"At some point" counts this drive's TD too, so the drive's likely scorers rise most.</p>` : ''}</div>`;
}
function simDriveCardHtml(s, raw) {
  const ds = S.sim.ds || 0; const cards = ds === 0 && s.drive1 ? s.drive1 : [0, 1].map(k => driveCard(raw, s, k, ds));
  const maxD = Math.max(...s.team.map(T => T.slots.filter(r => r.happen >= 0.05).length), 1);
  const btns = Array.from({ length: Math.min(12, maxD) }, (_, i) => `<button class="btn ${ds === i ? 'gold' : ''}" data-act="simdrv" data-s="${i}" aria-pressed="${ds === i}">${i + 1}</button>`).join('');
  return `<div class="card simdrvcard" id="simDrv"><h3>Drive ${ds + 1}: what happens <span class="chip rel-chance">Simulated</span></h3>
   <div class="row simdrvsel" role="group" aria-label="Drive number"><span class="small muted">Drive</span>${btns}</div>
   <div class="dvcols">${cards.map((c, k) => simDriveTeamHtml(c, simFpLine(s, k, ds))).join('')}</div>
   <p class="small muted">Each team's own drive ${ds + 1}, across all ${s.n.toLocaleString()} simulated games${ds ? ' that got that far' : ''}. Drive-level rates mostly reflect volume (how often a player gets the ball) and game state (score, clock, two-minute drives); they are not a measured "drive ${ds + 1}" skill. Who receives the opening kickoff is a 50/50 coin flip in the sim, and the other team gets the ball to start the second half.</p></div>`;
}
// 4.10.0 play-by-play helpers: field position as "GB 28" (own side) / "CAR 35" (opponent side) from yards-to-goal
const fpSpot = (yl, off, def) => yl == null ? '—' : yl > 50 ? `${off} ${Math.round(100 - yl)}` : yl < 50 ? `${def} ${Math.round(yl)}` : 'midfield';
const fpOwn = yl => yl == null ? '—' : yl > 50 ? `own ${Math.round(100 - yl)}` : yl < 50 ? `opp ${Math.round(yl)}` : 'midfield';
const YO_LBL = ['1–2', '3–5', '6–10', '11–20', '21–40', '41+'];
function simFpLine(s, k, ds) {
  const d = s.pbp?.drive?.[k]?.[ds]; if (!d) return '';
  return `<p class="small simfp">Field position: starts at the <strong>${esc(fpOwn(d.avgStart))}</strong> on average · reaches the red zone <strong>${simPct(d.rz)}</strong>${d.tdRush != null ? ` · its TDs: ${simPct(d.tdRush)} runs, ${simPct(1 - d.tdRush)} passes, from ${d.tdYo.toFixed(0)} yards out on average` : ''}.</p>`;
}
function simTdFpHtml(s) {
  const P = s.pbp; if (!P) return '';
  const tm = P.team.map(t => `<li><strong>${esc(t.team)}</strong>: average drive start ${esc(fpOwn(t.avgStart))} · TDs ${simPct(t.tdSrc[0])} rushing, ${simPct(t.tdSrc[1])} passing${t.tdSrc[2] + t.tdSrc[3] >= 0.005 ? `, ${simPct(t.tdSrc[2] + t.tdSrc[3])} defense / special teams` : ''} · offensive TDs from ${YO_LBL.map((l, i) => `${l} yds ${simPct(t.tdYo[i])}`).join(', ')}.</li>`).join('');
  const pl = P.players.filter(p => p.tdN >= 0.08 && p.tdYo).sort((a, b) => b.tdN - a.tdN).slice(0, 8).map(p => { const far = p.tdYo[4] + p.tdYo[5];
    return `<li><strong>${esc(p.name)}</strong> <span class="muted">${esc(p.pos)} ${esc(p.team)}</span>: ${simPct(p.tdI5)} of his TDs from inside the 5, ${simPct(p.tdYo[2] + p.tdYo[3])} from 6–20 yards, ${simPct(far)} from 21+.</li>`; }).join('');
  return `<h4>Where the TDs come from <span class="chip rel-chance">Play-by-play</span></h4><ul class="small simpls">${tm}</ul>${pl ? `<h5>Yards out on each player's TDs</h5><ul class="small simpls">${pl}</ul>` : ''}
   <p class="small muted">Each TD is credited to the player who scored on that simulated play (the runner, or the receiver on a TD catch).</p>`;
}
function simRzHtml(s) {
  const P = s.pbp; if (!P) return '';
  const H = P.hist || [];
  const rows = P.team.map((t, k) => { const h = H[k]; return `<tr><th scope="row">${esc(t.team)}</th><td><strong>${t.rzTrips.toFixed(1)}</strong>${h ? ` <span class="muted">(${h.rzPerG.toFixed(1)})</span>` : ''}</td><td><strong>${simPct(t.rzTdPct)}</strong>${h?.rzTdPct != null ? ` <span class="muted">(${simPct(h.rzTdPct)})</span>` : ''}</td><td>${t.i10Trips.toFixed(1)}${h ? ` <span class="muted">(${h.i10PerG.toFixed(1)})</span>` : ''}</td><td>${esc(fpOwn(t.avgStart))}</td><td>${t.drives.toFixed(1)}</td><td>${simPct(t.tdSrc[0])} / ${simPct(t.tdSrc[1])}</td></tr>`; }).join('');
  const pats = P.rzPatterns.slice(0, 10).map(x => `<li>${esc(x.text)}</li>`).join('');
  const pl = P.players.filter(p => (p.carI10 || 0) >= 0.1 || (p.tgtRz || 0) >= 0.1).sort((a, b) => a.k - b.k || ((b.carI10 || 0) + (b.tgtRz || 0)) - ((a.carI10 || 0) + (a.tgtRz || 0))).slice(0, 12)
    .map(p => `<tr><th scope="row">${esc(p.name)} <span class="small muted">${esc(p.pos)} ${esc(p.team)}</span></th><td>${simPct(p.carRz)}</td><td>${simPct(p.carI10)}</td><td>${simPct(p.carI5)}</td><td>${simPct(p.tgtRz)}</td><td>${simPct(p.tgtI10)}</td></tr>`).join('');
  return `<div class="card simrz" id="simRz"><h3>Red-zone patterns <span class="chip rel-chance">Play-by-play</span></h3>
   <ol class="simkey">${pats}</ol>
   <div class="tablewrap" tabindex="0" role="region" aria-label="Red-zone trips and touchdown rate"><table class="simtab"><thead><tr><th scope="col">Team</th><th scope="col">RZ trips / game</th><th scope="col">RZ TD %</th><th scope="col">Inside-10 trips</th><th scope="col">Avg start</th><th scope="col">Drives</th><th scope="col">TDs run / pass</th></tr></thead><tbody>${rows}</tbody></table></div>
   <p class="small muted">Simulated, with each team's real 2026 numbers before this week in brackets. A red-zone trip is a drive that runs a play inside the opponent's 20.</p>
   ${pl ? `<h4>Who gets the ball near the goal line</h4><div class="tablewrap" tabindex="0" role="region" aria-label="Red-zone usage by player"><table class="simtab"><thead><tr><th scope="col">Player</th><th scope="col">Carries inside 20</th><th scope="col">inside 10</th><th scope="col">inside 5</th><th scope="col">Targets inside 20</th><th scope="col">inside 10</th></tr></thead><tbody>${pl}</tbody></table></div><p class="small muted">Share of his team's carries or targets from that part of the field, across all simulated plays.</p>` : ''}</div>`;
}
const ORD = ['', '1st', '2nd', '3rd', '4th'];
function pbpPlayText(e, I) {
  const T = I.teams; const off = T[e.k]?.team, def = T[1 - e.k]?.team; const nm = j => j >= 0 ? (T[e.k].players[j]?.name || '?') : '';
  const qb = e.qb >= 0 ? nm(e.qb) : 'QB'; const dd = e.down ? `${ORD[e.down]} & ${e.yl <= e.togo ? 'goal' : e.togo} at ${fpSpot(e.yl, off, def)}` : '';
  const yd = y => `${y} yd${Math.abs(y) === 1 ? '' : 's'}`;
  switch (e.t) {
    case 'play': { let x;
      if (e.kind === 0) x = `${nm(e.j)} run for ${yd(e.yds)}`; else if (e.kind === 2) x = `${qb} scrambles for ${yd(e.yds)}`; else if (e.kind === 3) x = `${qb} sacked for ${yd(e.yds)}`;
      else if (e.kind === 4) x = `${qb} pass complete to ${nm(e.j)} for ${yd(e.yds)}`; else x = e.to === 1 ? `${qb} pass for ${nm(e.j)} INTERCEPTED` : `${qb} pass incomplete${e.j >= 0 ? ` for ${nm(e.j)}` : ''}`;
      if (e.td) x += ' — TOUCHDOWN'; if (e.to === 2) x += ' — FUMBLE, lost'; if (e.safety) x += ' — SAFETY'; if (e.ob) x += ' (out of bounds)'; return { dd, x, hi: e.td || e.to || e.safety }; }
    case 'pen': return { dd: '', x: `Penalty on the ${e.off ? 'offense' : 'defense'}, ${yd(Math.abs(e.y))}; now ${dd}` };
    case 'fg': return { dd, x: `${e.dist}-yd field goal ${e.good ? 'is GOOD' : 'is no good'}`, hi: e.good };
    case 'punt': return { dd: '', x: e.td ? `${off} punt returned for a TOUCHDOWN` : `${off} punts; ${def} takes over at ${fpSpot(e.ny, def, off)}`, hi: e.td };
    case 'pat': return { dd: '', x: e.two ? `Two-point try ${e.ok ? 'good' : 'fails'}` : `Extra point ${e.ok ? 'good' : 'missed'}` };
    case 'ko': { const r = T[e.ret]?.team, kk = T[e.k]?.team; return { dd: '', x: e.onside ? `${kk} onside kick, recovered by ${e.rec ? kk : r}` : e.td ? `${kk} kickoff returned for a TOUCHDOWN by ${r}` : `${kk} kicks off; ${r} starts at ${fpSpot(e.yl, r, kk)}${e.free ? ' (free kick)' : ''}`, hi: e.td }; }
    case 'kneel': return { dd, x: `${qb} kneels` };
    case 'note': return { dd: '', x: e.txt, note: true };
    default: return { dd: '', x: e.t };
  }
}
function simGameHtml() {
  const s = S.sim.sum; if (s?.mode !== 'pbp') return ''; const R = S.sim.replay; const I = S.sim.inputs;
  const btns = `<div class="row"><button class="btn gold" data-act="simgame">${R ? 'Open another sample game' : 'Open a sample game'}</button>${R?.status === 'done' ? `<button class="btn" data-act="simgame" data-close="1">Close</button>` : ''}</div>`;
  if (!R) return `<div class="card simgame" id="simGame"><h3>Sample game <span class="chip rel-chance">Play-by-play</span></h3>${btns}<p class="small muted">Opens one of the ${s.n.toLocaleString()} simulated games at random, drive by drive, with every play.</p></div>`;
  if (R.status !== 'done') return `<div class="card simgame" id="simGame"><h3>Sample game #${R.g + 1}</h3>${btns}<p class="small muted">${R.status === 'error' ? 'Could not replay this game.' : 'Loading…'}</p></div>`;
  const L = R.log; const groups = []; let cur = { d: null, ev: [] };
  for (const e of L) { if (e.t === 'drive') { if (cur.d || cur.ev.length) groups.push(cur); cur = { d: e, ev: [] }; } else cur.ev.push(e); } groups.push(cur);
  const fin = L.at(-1)?.sc || [0, 0]; const T = I.teams;
  const drives = groups.map((G, i) => { const d = G.d; const lines = G.ev.map(e => { const t = pbpPlayText(e, I); return `<li class="${t.hi ? 'hi' : ''}${t.note ? ' note' : ''}"><span class="pclk">Q${e.q} ${esc(e.clk)}</span>${t.dd ? `<span class="pdd">${esc(t.dd)}</span>` : ''}<span class="ptxt">${esc(t.x)}</span><span class="psc">${e.sc[0]}–${e.sc[1]}</span></li>`; }).join('');
    if (!d) return `<li class="pdrv pre"><ul class="plays small">${lines}</ul></li>`;
    const plays = G.ev.filter(e => e.t === 'play' && e.k === d.k); const last = [...G.ev].reverse().find(e => (e.t === 'play' && e.k === d.k) || e.t === 'fg' || e.t === 'punt' || e.t === 'kneel');
    const res = !last ? 'End of half' : last.t === 'fg' ? (last.good ? 'Field goal' : 'Missed FG') : last.t === 'punt' ? 'Punt' : last.t === 'kneel' ? 'Kneel' : last.td ? 'Touchdown' : last.to === 1 ? 'Interception' : last.to === 2 ? 'Fumble' : last.safety ? 'Safety' : G.ev.some(e => e.t === 'note' && /half|Overtime/.test(e.txt)) ? 'End of half' : last.down === 4 ? 'Downs' : 'End of half';
    const yds = last && last.t === 'play' ? d.yl - (last.td ? 0 : last.yl - last.yds) : last && last.yl != null ? d.yl - last.yl : 0;
    const tm = T[d.k].team, op = T[1 - d.k].team; const sc = G.ev.at(-1)?.sc || [0, 0];
    return `<li class="pdrv"><details${i < 3 ? ' open' : ''}><summary><strong>${esc(tm)} drive ${d.dno}</strong> · Q${G.ev[0]?.q ?? ''} ${esc(G.ev[0]?.clk ?? '')} · starts ${esc(fpSpot(d.yl, tm, op))} · ${plays.length} play${plays.length === 1 ? '' : 's'}, ${yds} yds · <span class="${/Touchdown|Field goal/.test(res) ? 'gap' : 'muted'}">${esc(res)}</span> <span class="muted">${sc[0]}–${sc[1]}</span></summary><ul class="plays small">${lines}</ul></details></li>`; }).join('');
  return `<div class="card simgame" id="simGame"><h3>Sample game #${R.g + 1}: ${esc(s.away)} ${fin[0]} – ${esc(s.home)} ${fin[1]} <span class="chip rel-chance">Play-by-play</span></h3>${btns}
   <p class="small muted">One simulated game, exactly as the sim played it (same seed). Tap a drive to open its plays. Score shown as ${esc(s.away)}–${esc(s.home)}.</p><ol class="pdrives">${drives}</ol></div>`;
}
function simTdHtml(s) {
  const t = s.tdp; if (!t) return '';
  const firstL = (arr, ttl) => `<div><h5>${esc(ttl)}</h5><ol class="small simfirst">${arr.slice(0, 5).map(f => `<li>${esc(f.label)} <strong>${simPct(f.p)}</strong></li>`).join('')}</ol></div>`;
  const pl = t.players.slice(0, 10).map(p => `<li><strong>${esc(p.name)}</strong> <span class="muted">${esc(p.pos)} ${esc(p.team)}</span> scores in <strong>${simPct(p.anytime)}</strong> of games · 2+ TDs ${simPct(p.twoPlus)} · 3+ ${simPct(p.threePlus)} · first TD of the game ${simPct(p.first)} · first ${esc(p.team)} TD ${simPct(p.firstTeam)}.</li>`).join('');
  const li = arr => arr.map(x => `<li>${esc(x.text)}</li>`).join('');
  return `<div class="card simtd" id="simTd"><h3>Touchdown scorer patterns <span class="chip rel-chance">Simulated</span></h3>
   <h4>Key patterns, ranked</h4><ol class="simkey">${t.key.map(k => `<li>${esc(k)}</li>`).join('')}</ol>
   <h4>First touchdown</h4><div class="simcols3">${firstL(s.firstTd, 'First TD of the game')}${firstL(t.firstTeam[0], `First ${s.away} TD`)}${firstL(t.firstTeam[1], `First ${s.home} TD`)}</div>
   <p class="small muted">Shares of all games. "No … TD" = that team never scored an offensive TD; defense / special-teams scores are listed separately.</p>
   <h4>Anytime, 2+ and 3+</h4><ul class="small simpls">${pl}</ul>${simTdFpHtml(s)}
   <h4>When and how each player's TDs come</h4><ul class="small simpls">${li(t.timing)}</ul>
   <h4>Most common TD pairs (both score)</h4><ul class="small simpls">${t.combos.slice(0, 6).map(c => `<li>${esc(c.a)} + ${esc(c.b)} both score: <strong>${simPct(c.p)}</strong>${c.same ? ' <span class="muted">same team</span>' : ''}</li>`).join('')}</ul>
   <h4>Links between scorers, drives and results <span class="chip rel-chance">Sim structure</span></h4>
   <p class="small muted">These links come from how the sim is built (one scorer per TD drive, each team's TD budget, score and clock), not from measured real-life player-to-player links. Biggest first.</p>
   <h5>One player scores → another</h5><ul class="small simpls">${li(t.links.slice(0, 6))}</ul>
   <h5>Opening-drive TD → anytime TD</h5><ul class="small simpls">${li(t.d1links.slice(0, 5))}</ul>
   <h5>Scorer → win and total</h5><ul class="small simpls">${li(t.winLinks.slice(0, 5))}</ul></div>`;
}
// 4.9.2: Top 4 TD scorers (sim), team profiles (opponent-adjusted 2026 drives) and sim vs model
const sdiff = d => `${d >= 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)}`;
function simTop4Html(s) {
  const t = s.vs?.top4; if (!t?.length) return '';
  return `<div class="card simtop4" id="simTop4"><h3>Top 4 TD scorers (sim) <span class="chip rel-chance">Simulated</span></h3>
   <ol class="top4">${t.map((p, i) => `<li><div class="t4head"><span class="t4rank">${i + 1}</span><span class="t4name"><strong>${esc(p.name)}</strong> <span class="muted">${esc(p.team)} ${esc(p.pos)}</span></span><span class="t4p">${simPct(p.anytime)}</span></div>
    <div class="t4nums small"><span>Model <strong>${simPct(p.model)}</strong> <span class="${Math.abs(p.diff) >= 0.03 ? 'gap' : 'muted'}">(${sdiff(p.diff)} pts)</span></span><span>2+ TDs <strong>${simPct(p.twoPlus)}</strong></span><span>First TD <strong>${simPct(p.first)}</strong></span></div>
    <p class="small t4line">${esc(p.line)}</p></li>`).join('')}</ol>
   <p class="small muted">Ranked by anytime TD across both teams in this run of ${s.n.toLocaleString()} simulated games. The sim runs on each team's own opponent-adjusted 2026 ${simPick().mode === 'pbp' ? 'plays' : 'drives'} and is not forced to match the model, so the two can differ.</p></div>`;
}
function simProfileHtml(s) {
  const T = s.vs?.teams; if (!T?.length || !T[0].off) return '';
  const side = t => `<div class="simprof"><h4>${esc(t.team)} offense <span class="small muted">vs ${esc(t.opp)} defense</span></h4>
    <ul class="small sees">${t.off.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
    ${t.def ? `<h5>${esc(t.def.team)} defense (what ${esc(t.team)} faces)</h5><ul class="small sees">${t.def.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    <p class="small">In this matchup the sim gives ${esc(t.team)} <strong>${t.simTd.toFixed(2)}</strong> offensive TDs a game${t.modelTd != null ? ` (model budget ${t.modelTd.toFixed(2)}, <span class="${Math.abs(t.diffTd) >= 0.2 ? 'gap' : 'muted'}">${t.diffTd >= 0 ? '+' : '−'}${Math.abs(t.diffTd).toFixed(2)}</span>)` : ''}, ${t.simPts.toFixed(1)} points, ${t.simDrives.toFixed(1)} drives and throws on ${simPct(t.passSim)} of plays${t.passModel != null ? ` (model volume ${simPct(t.passModel)})` : ''}.</p></div>`;
  return `<div class="card simprofcard" id="simProf"><h3>How each team plays · 2026, opponent-adjusted <span class="chip rel-chance">Sim inputs</span></h3>
   <div class="dvcols">${T.map(side).join('')}</div>
   <p class="small muted">From every 2026 drive before this week (recent games count more), fitted jointly so each offense is judged against the defenses it faced and each defense against the offenses it faced; small samples are pulled toward league average. Ranks are out of 32 teams. No play-by-play: "quick-strike" (TD drives of 4 plays or fewer) stands in for explosive plays. Injuries and roles come from the model's player projections (who is active and how a team's targets, carries and TDs are shared).</p></div>`;
}
function simGapsHtml(s) {
  const g = s.vs?.gaps; if (!g?.length) return '<p class="small muted">No player differs from the model by 3 points or more in this run.</p>';
  return `<h4>Biggest sim vs model disagreements</h4><ul class="small simpls">${g.map(x => `<li><strong>${esc(x.name)}</strong> <span class="muted">${esc(x.pos)} ${esc(x.team)}</span>: sim ${simPct(x.anytime)} vs model ${simPct(x.model)} <span class="gap">(${sdiff(x.diff)} pts)</span></li>`).join('')}</ul>`;
}
function simResultHtml() {
  const s = S.sim.sum, raw = S.sim.raw; const A = s.away, B = s.home; const TA = s.team[0], TB = s.team[1];
  const wbar = `<div class="simwin" role="img" aria-label="${A} wins ${pc(s.win.away)}, ${B} wins ${pc(s.win.home)}, tie ${pc(s.win.tie, 1)}"><span style="flex:${s.win.away}">${esc(A)} ${pc(s.win.away)}</span>${s.win.tie >= 0.005 ? `<span class="tie" style="flex:${Math.max(s.win.tie, 0.04)}">T ${pc(s.win.tie, 0)}</span>` : ''}<span class="h" style="flex:${s.win.home}">${esc(B)} ${pc(s.win.home)}</span></div>`;
  const vegas = s.line ? `<p class="small">Sim vs the betting line: ${s.line.spreadHome != null ? `${esc(B)} ${s.line.spreadHome > 0 ? '+' : ''}${s.line.spreadHome} covers in <strong>${pc(s.homeCover)}</strong>` : ''}${s.line.total != null ? ` · over ${s.line.total} in <strong>${pc(s.over)}</strong>` : ''}. <span class="muted">The team-style sim does not use the betting line, so this is an independent read (walk-forward: it has not beaten closing lines).</span></p>` : '';
  const kv = `<div class="kv small"><div>Median score<br><strong>${esc(A)} ${TA.pts.med} – ${esc(B)} ${TB.pts.med}</strong></div><div>Average<br><strong>${TA.mean.pts.toFixed(1)} – ${TB.mean.pts.toFixed(1)}</strong></div><div>Total (median)<br><strong>${s.total.med}</strong> <span class="muted">80%: ${s.total.p10}–${s.total.p90}</span></div><div>${esc(B)} margin<br><strong>${sgn(s.margin.med)}</strong> <span class="muted">80%: ${sgn(s.margin.p10)} to ${sgn(s.margin.p90)}</span></div><div>Middle 50%<br>total ${s.total.p25}–${s.total.p75} · margin ${sgn(s.margin.p25)} to ${sgn(s.margin.p75)}</div><div>Overtime<br><strong>${pc(s.win.ot, 1)}</strong></div><div>Drives per team<br>${TA.mean.drives.toFixed(1)} / ${TB.mean.drives.toFixed(1)} <span class="muted">(target ${s.targetDrives})</span></div><div>Offensive TDs<br>${TA.mean.td.toFixed(2)} / ${TB.mean.td.toFixed(2)}${s.vs?.teams?.[0]?.modelTd != null ? ` <span class="muted">(model ${s.vs.teams[0].modelTd.toFixed(2)} / ${s.vs.teams[1].modelTd?.toFixed(2) ?? '—'})</span>` : ''}</div></div>`;
  const top = `<div class="row simtop">${s.top.slice(0, 8).map(t => `<span class="chip">${t.winner === 'tie' ? 'Tie' : esc(t.winner)} ${esc(t.score)} · ${pc(t.p, 1)}</span>`).join('')}</div><p class="small muted">Exact final scores are spread thin: even the most common one happens in about ${pc(s.top[0]?.p, 1)} of games.</p>`;
  // players
  const team = S.sim.team; const st = S.sim.st, th = S.sim.th;
  const list = s.players.filter(p => (team === 'both' || p.team === team) && (p.anytime >= 0.01 || p.rec.mean + p.car.mean >= 0.5)).sort((a, b) => b.anytime - a.anytime);
  const thBtn = (s2, t) => `<button class="btn ${st === s2 && th === t ? 'gold' : ''}" data-act="simth" data-st="${s2}" data-th="${t}" aria-pressed="${st === s2 && th === t}">${esc(simPhrase(s2, t))}</button>`;
  const prow = p => { const hit = pAtLeast(playerGameStat(raw, p.j, st), th); const qb = p.pos === 'QB' && p.passTd != null ? ` <span class="small muted">· pass TD ${p.passTd.toFixed(2)} avg</span>` : '';
    return `<tr><th scope="row"><button class="plink" data-act="simpl" data-j="${p.j}">${esc(p.name)}</button> <span class="small muted">${esc(p.pos)} ${esc(p.team)}</span>${qb}${p.history ? ' <span class="chip rel-watch">history-only</span>' : ''}</th><td><strong>${pc(p.anytime)}</strong></td><td class="muted">${pc(p.model.chance)}</td><td class="${Math.abs(p.anytime - p.model.chance) >= 0.03 ? 'gap' : 'muted'}">${sdiff(p.anytime - p.model.chance)}</td><td>${pc(p.twoPlus, 1)}</td><td>${simRange(p.rec)}</td><td>${simRange(p.recYd)}</td><td>${simRange(p.rushYd)}</td><td><strong>${pc(hit)}</strong></td></tr>`; };
  const players = `<div class="row" role="group" aria-label="Team">${['both', A, B].map(t => `<button class="btn ${team === t ? 'gold' : ''}" data-act="simteam" data-team="${esc(t)}" aria-pressed="${team === t}">${t === 'both' ? 'Both' : esc(t)}</button>`).join('')}</div>
   <div class="row" role="group" aria-label="Game threshold">${GAME_PRESETS.map(([a, b]) => thBtn(a, b)).join('')}<label class="small">Custom <select class="select" id="simSt">${['rec', 'recYd', 'car', 'rushYd', 'tgt', 'tch', 'td'].map(x => `<option value="${x}" ${x === st ? 'selected' : ''}>${SIM_LBL[x]}</option>`).join('')}</select> ≥ <input class="input" id="simTh" type="number" min="1" max="400" step="1" value="${th}" style="width:5em" inputmode="numeric"></label></div>
   <div class="tablewrap" tabindex="0" role="region" aria-label="Simulated player outcomes"><table class="simtab simplayers"><thead><tr><th scope="col">Player (tap for drives)</th><th scope="col">Sim TD</th><th scope="col">Model TD</th><th scope="col">Diff (pts)</th><th scope="col">2+ TD</th><th scope="col">Rec</th><th scope="col">Rec yds</th><th scope="col">Rush yds</th><th scope="col">${esc(simPhrase(st, th))}</th></tr></thead><tbody>${list.map(prow).join('')}</tbody></table></div>
   <p class="small muted">Simulated medians with the 10th–90th percentile in brackets. Sim TD comes from the team-style sim (each team's opponent-adjusted 2026 drives); Model TD is the board's number. They are allowed to differ; gaps of 3+ points are highlighted. The board keeps the model's number.</p>${simGapsHtml(s)}`;
  // drive patterns
  const pats = simPatterns(raw, s, { max: 8 });
  const patHtml = pats.length ? `<ul class="sees small">${pats.map(x => `<li><strong>${esc(x.name)}</strong> gets ${esc(simPhrase(x.stat, x.th))} on ${esc(x.team)} drive ${x.drive} in <strong>${pc(x.p)}</strong> of sims${x.swing.drive !== x.drive && Math.abs(x.swing.given - x.avg) >= 0.03 ? `; his biggest swing is drive ${x.swing.drive} (${pc(x.swing.given)} when it happens vs ${pc(x.avg)} average)` : ''}.</li>`).join('')}</ul>` : '';
  const applied = s.players.filter(p => p.pats.length); const appliedHtml = applied.length ? `<p class="small">Validated real-drive patterns built into the sim (touch-share multipliers on matching drives): ${applied.map(p => `${esc(p.name)} ${p.pats.map(t => `<span class="chip rel-${t.rel}">${esc(t.sub)} ×${t.mult}</span>`).join(' ')}`).join(' · ')}</p>` : '<p class="small muted">No validated drive patterns for these players, so per-drive rates move only with game state (two-minute drives, leading or trailing).</p>';
  const slotTab = T => `<div class="tablewrap" tabindex="0" role="region" aria-label="${esc(T.team)} drive results by drive number"><table class="simtab"><thead><tr><th scope="col">${esc(T.team)} drive</th><th scope="col">Happens</th><th scope="col">TD</th><th scope="col">FG</th><th scope="col">Punt</th><th scope="col">Turnover</th><th scope="col">Downs</th><th scope="col">End of half</th></tr></thead><tbody>${T.slots.slice(0, 14).map(r => `<tr><th scope="row">${r.n}</th><td>${pc(r.happen)}</td><td><strong>${pc(r.TD)}</strong></td><td>${pc(r.FG)}</td><td>${pc(r.Punt)}</td><td>${pc(r.TO)}</td><td>${pc(r.Downs)}</td><td>${pc(r.Half)}</td></tr>`).join('')}</tbody></table></div><p class="small">${esc(T.team)} offensive TDs: ${T.tdDist.map((p, i) => `${i}${i === 6 ? '+' : ''}: ${pc(p)}`).join(' · ')}</p>`;
  const scripts = `<div class="simscripts small">${s.scripts.map(x => `<div><span>${esc(x.label)}</span><span class="bar"><i style="width:${(x.p * 100).toFixed(1)}%"></i></span><strong>${pc(x.p)}</strong></div>`).join('')}</div><h4>Most common game scripts</h4><ol class="small">${s.combos.map(c => `<li>${esc(c.label)} · <strong>${pc(c.p)}</strong></li>`).join('')}</ol>`;
  return `${simTop4Html(s)}${simProfileHtml(s)}<div class="card simres"><h3>Result · ${s.n.toLocaleString()} simulated games <span class="chip rel-chance">Simulated</span></h3>${wbar}${vegas}${kv}
    <div class="simhists"><div>${simBars(s.marHist, `${B} margin`, b => sgn(b))}</div><div>${simBars(s.totHist, 'Total points', b => String(b))}</div></div>
    <h4>Most common final scores</h4>${top}</div>
   ${simGameHtml()}${simRzHtml(s)}${simDriveCardHtml(s, raw)}${simTdHtml(s)}
   ${S.sim.pj != null ? simPlayerDriveHtml(s, raw) : ''}
   <div class="card"><h3>Players · simulated <span class="chip rel-chance">Simulated</span></h3>${players}</div>
   <div class="card"><h3>Drive-by-drive patterns in the sims <span class="chip rel-chance">Simulated</span></h3>${patHtml}${appliedHtml}
    <div class="dvcols"><div><h4>${esc(A)} scoring by drive number</h4>${slotTab(TA)}</div><div><h4>${esc(B)} scoring by drive number</h4>${slotTab(TB)}</div></div></div>
   <div class="card"><h3>Game scripts <span class="chip rel-chance">Simulated</span></h3>${scripts}</div>`;
}
function paintSim() {
  const o = document.getElementById('simOut'); if (!o) return; const { A, B, key, mode } = simPick(); const sim = S.sim; const mine = sim.key === key;
  const hasPbp = !!S.slate?.pbp; const run = sim.status === 'running';
  const modeSel = `<div class="row simmode" role="group" aria-label="Simulation engine"><button class="btn ${mode === 'drive' ? 'gold' : ''}" data-act="simmode" data-mode="drive" aria-pressed="${mode === 'drive'}" ${run ? 'disabled' : ''}>Drive sim</button><button class="btn ${mode === 'pbp' ? 'gold' : ''}" data-act="simmode" data-mode="pbp" aria-pressed="${mode === 'pbp'}" ${!hasPbp || run ? 'disabled' : ''}>Play-by-play (beta)</button></div>`;
  const head = mode === 'pbp' ? `${modeSel}<p class="small">Plays <strong>${esc(A)} @ ${esc(B)}</strong> snap by snap ${SIM_N.toLocaleString()} times: down, distance, yard line, clock, timeouts and score; kickoffs, punts, field goals by distance, turnovers with returns, penalties, fourth-down calls, two-minute and end-of-half play. Every carry and target is placed on the field, so red-zone and goal-line patterns come out of the games.</p>` : `${modeSel}<p class="small">Plays <strong>${esc(A)} @ ${esc(B)}</strong> drive by drive ${SIM_N.toLocaleString()} times: possession alternation, score, quarter and clock, two-minute drives and overtime; every drive ends in a TD, FG, punt, turnover, downs or end of half with its plays, targets, carries, catches and yards, and who scored.</p>`;
  const ctl = `<div class="row"><button class="btn gold" data-act="simrun" ${sim.status === 'running' ? 'disabled' : ''}>${sim.status === 'running' && mine ? 'Simulating…' : mine && sim.status === 'done' ? `Run ${SIM_N.toLocaleString()} new games` : `Run ${SIM_N.toLocaleString()} games`}</button><span class="small muted" aria-live="polite">${mine && sim.status === 'done' ? `${sim.sum.n.toLocaleString()} games simulated in ${(sim.wall / 1000).toFixed(1)} s · run #${sim.seed}` : mine && sim.status === 'running' && !sim.prog ? 'Running in the background…' : ''}</span></div>${mine && run && sim.prog ? simProgHtml() : ''}`;
  const notes = mine && sim.sum?.notes?.length ? `<p class="small simnote">${sim.sum.notes.map(esc).join('<br>')}</p>` : '';
  const err = mine && sim.status === 'error' ? `<p class="small" role="alert">Simulation failed: ${esc(sim.err)}</p>` : '';
  const discP = `<p class="small muted simdisc"><strong>Simulated, not a guarantee. Beta.</strong> Play-by-play mode: pass/run calls by down, distance, field zone and score, sacks, interceptions, fumbles, explosive plays, scrambles, red-zone and goal-line touchdown rates and pace come from every 2026 play before this week (2025 as the prior), adjusted for the opponents each team has faced and pulled toward league average on small samples. Who gets each carry and target by down and field zone (red zone, inside the 10 and 5) comes from 2026 play-by-play blended with the model's projections. Walk-forward on 2026 weeks 3–7 it has not beaten the drive sim on both team and player accuracy, so the drive sim stays the default. It does not change any prediction on the board and is not part of the model or the challenger gate.</p>`;
  const disc = mode === 'pbp' ? discP : `<p class="small muted simdisc"><strong>Simulated, not a guarantee.</strong> How often each drive ends in a TD, FG, punt, turnover or downs, pace, pass rate by game script, red-zone finishing and two-minute scoring all come from each team's own 2026 drives, adjusted for the opponents it has played (offense vs this defense, defense vs this offense). Who gets the ball (targets, carries, TD shares, injuries) comes from the model's player projections. The sim runs free: it is not forced to match the model's TD chances or the betting line, so it can disagree. It does not change any prediction on the board and is not part of the model or the challenger gate.</p>`;
  o.innerHTML = `<div class="card simhead"><h2>Game simulator <span class="chip rel-chance">Simulated</span></h2>${head}${ctl}${notes}${err}${disc}</div>${mine && sim.status === 'done' ? simResultHtml() : ''}`;
  const on = (id, f) => o.querySelector('#' + id)?.addEventListener('change', e => { f(e.target.value); paintSim(); });
  on('simSt', x => { S.sim.st = x; if (!(S.sim.th >= 1)) S.sim.th = 1; }); on('simTh', x => { const v = Math.max(1, Math.round(+x)); if (Number.isFinite(v)) S.sim.th = v; });
  on('simDSt', x => { S.sim.dst = x; }); on('simDTh', x => { const v = Math.max(1, Math.round(+x)); if (Number.isFinite(v)) S.sim.dth = v; });
}
function renderDrives() {
  const v = $('#view-drives'); const D = drivesData();
  if (!D) { v.innerHTML = `<div class="card"><h2>Drives</h2><p class="muted">The weekly drive file is not loaded for week ${S.week ?? ''} (it is built by the auto run; local copies without the archive cannot show it).</p></div>`; return; }
  if (!D.teams) { v.innerHTML = `<div class="card"><h2>Drives</h2><p class="muted">This week's drive file predates the Drives section (app 4.8); team and matchup views need a rebuild.</p></div>${drivesTrendsHtml()}`; return; }
  const teams = Object.keys(D.teams).sort(); const games = S.slate?.games || [];
  if (!teams.includes(S.dv.team)) S.dv.team = teams[0];
  if (S.dv.mode !== 'team' && !S.dv.game && games[0] && !(S.dv.a && S.dv.b)) S.dv.game = games[0].id;
  const g = S.dv.mode !== 'team' && S.dv.game && S.dv.game !== 'custom' ? games.find(x => x.id === S.dv.game) : null;
  const A = g ? g.sides.away.team : S.dv.a || teams[0], B = g ? g.sides.home.team : S.dv.b || teams[1];
  const spreadA = g?.sides.away.lines?.known ? g.sides.away.lines.awaySpread : null, spreadB = spreadA != null ? -spreadA : null;
  const tsel = (id, cur, lbl) => `<label class="small">${lbl} <select class="select" id="${id}">${teams.map(t => `<option ${t === cur ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
  const nBtns = `<div class="row" role="group" aria-label="Games window">${[[3, 'Last 3'], [6, 'Last 6'], ['season', 'Season']].map(([k, l]) => `<button class="btn ${S.dv.n === k ? 'gold' : ''}" data-act="dvn" data-n="${k}" aria-pressed="${S.dv.n === k}">${l}</button>`).join('')}</div>`;
  const picker = `<div class="card dvpick"><h2>Drives · week ${D.week}</h2>
   <div class="row dvctl"><div class="row" role="group" aria-label="View"><button class="btn ${S.dv.mode === 'team' ? 'gold' : ''}" data-act="dvmode" data-mode="team" aria-pressed="${S.dv.mode === 'team'}">Team</button><button class="btn ${S.dv.mode === 'matchup' ? 'gold' : ''}" data-act="dvmode" data-mode="matchup" aria-pressed="${S.dv.mode === 'matchup'}">Matchup</button><button class="btn ${S.dv.mode === 'sim' ? 'gold' : ''}" data-act="dvmode" data-mode="sim" aria-pressed="${S.dv.mode === 'sim'}">Simulator</button></div>
   <div class="row">${S.dv.mode === 'team' ? tsel('dvTeam', S.dv.team, 'Team') : `<label class="small">Game <select class="select" id="dvGame">${games.map(x => `<option value="${esc(x.id)}" ${S.dv.game === x.id ? 'selected' : ''}>${esc(x.sides.away.team)} @ ${esc(x.sides.home.team)}</option>`).join('')}<option value="custom" ${S.dv.game === 'custom' ? 'selected' : ''}>Any two teams…</option></select></label>${S.dv.game === 'custom' ? tsel('dvA', A, 'Team A') + tsel('dvB', B, 'Team B') : ''}`}</div>
   ${S.dv.mode === 'sim' ? '' : nBtns}</div><p class="small muted">Pre-game: only drives before week ${D.week}. Your choice is saved on this device.</p></div>`;
  const nLbl = S.dv.n === 'season' ? 'this season' : `last ${S.dv.n} games`;
  let body;
  if (S.dv.mode === 'sim') body = '<div id="simOut"></div>';
  else if (S.dv.mode === 'team') {
    const t = S.dv.team; const opp = (() => { for (const x of games) for (const sd of ['away', 'home']) if (x.sides[sd].team === t) return { opp: x.sides[sd === 'away' ? 'home' : 'away'].team, spread: x.sides.away.lines?.known ? (sd === 'away' ? x.sides.away.lines.awaySpread : -x.sides.away.lines.awaySpread) : null }; return null; })();
    body = `<div class="card"><h2>${esc(t)} offense</h2>${offenseKv(D, t)}</div>
     <div class="card" id="dvLog"><h3>Drive log · every drive, every touch</h3>${driveLogHtml(D, t, S.dv.n)}</div>
     <div class="card" id="dvPbd"><h3>Player by drive · ${nLbl}</h3>${playerByDriveHtml(D, t, S.dv.n)}</div>
     <div class="card"><h3>Drive grid · ${nLbl}</h3>${driveGrid(D, t, S.dv.n)}</div>
     <div class="card"><h3>Tendencies by phase · ${nLbl}</h3>${tendTable(teamTendencies(D, t, S.dv.n))}</div>
     <div class="card"><h3>What the model sees · ${esc(t)} players${opp ? ` vs ${esc(opp.opp)}` : ''}</h3>${playerPatternsHtml(D, t, opp?.opp || null, opp?.spread ?? null)}<p class="small muted">Patterns = survived FDR (q ≤ 0.10), enough drives and held up out of sample; strong counts fully, moderate half. "Worth watching" = close but failed a check; never used.</p></div>
     <div class="card"><h3>${esc(t)} defense: drives allowed</h3>${defenseHtml(D, t)}</div>`;
  } else {
    const GT = S.dv.gt === B ? B : A; S.dv.gridTeam = GT;
    const col = (t, opp, sp) => `<div class="card dvcol"><h3>${esc(t)} offense</h3>${offenseKv(D, t)}<h4>Tendencies · ${nLbl}</h4>${tendTable(teamTendencies(D, t, S.dv.n), true)}<h4>What the model sees · ${esc(t)} players vs ${esc(opp)}</h4>${playerPatternsHtml(D, t, opp, sp)}<h4>${esc(opp)} defense: drives allowed</h4>${defenseHtml(D, opp)}</div>`;
    body = `<div class="card"><h2>${esc(A)} @ ${esc(B)} · what the model sees</h2>${seesHtml(D, A, B, { spreadA, spreadB })}<p class="small muted">Only findings that pass the reliability checks are called patterns; everything else is labelled "worth watching" or "rank only" and never moves a number.</p></div>
     <div class="dvcols">${col(A, B, spreadA)}${col(B, A, spreadB)}</div>
     <div class="card"><h3>Drive by drive · ${nLbl}</h3><div class="row" role="group" aria-label="Grid team">${[A, B].map(t => `<button class="btn ${GT === t ? 'gold' : ''}" data-act="dvgt" data-team="${esc(t)}" aria-pressed="${GT === t}">${esc(t)}</button>`).join('')}</div>
     <h4 id="dvLog">Drive log · every drive, every touch</h4>${driveLogHtml(D, GT, S.dv.n)}<h4 id="dvPbd">Player by drive</h4>${playerByDriveHtml(D, GT, S.dv.n)}<h4>Drive grid</h4>${driveGrid(D, GT, S.dv.n)}</div>`;
  }
  v.innerHTML = S.dv.mode === 'sim' ? `${picker}${body}` : `${picker}${body}<div class="card" id="drivesScore"><h3>Scoreboard: with vs without drive patterns</h3>${scoreboardHtml(D)}</div>${drivesTrendsHtml()}`;
  const on = (id, f) => v.querySelector('#' + id)?.addEventListener('change', e => { f(e.target.value); saveDv(); renderDrives(); });
  on('dvTeam', x => { S.dv.team = x; S.dv.who = ''; S.dv.lg = ''; }); on('dvGame', x => { S.dv.game = x; S.dv.who = ''; }); on('dvA', x => { S.dv.a = x; }); on('dvB', x => { S.dv.b = x; }); on('dvWho', x => { S.dv.who = x; }); on('dvLogG', x => { S.dv.lg = x; }); on('dvPl', x => { S.dv.pl = x; }); on('dvThC', x => { const v = Math.max(0, Math.round(+x)); if (Number.isFinite(v)) S.dv.th = v; });
  if (S.dv.mode === 'team') S.dv.gridTeam = S.dv.team;
  if (S.dv.mode === 'sim') paintSim();
}
function renderTrends() {
  const v = $('#view-trends'); const T = S.slate?.trends; if (!T) { v.innerHTML = '<p class="muted">No trends loaded.</p>'; return; }
  S.tf = S.tf || { family: 'all', team: 'all', status: 'all' };
  const fams = [...new Set(T.items.map(t => t.family))]; const teams = [...new Set(T.items.map(t => t.team))].sort();
  const rows = T.items.filter(t => (S.tf.family === 'all' || t.family === S.tf.family) && (S.tf.team === 'all' || t.team === S.tf.team || t.side === S.tf.team) && (S.tf.status === 'all' || t.status === S.tf.status));
  const on = Object.entries(T.weights).filter(([, w]) => w).map(([k]) => T.families[k]?.label || k);
  const opt = (id, cur, list, lbl) => `<label class="small">${lbl} <select class="select" id="${id}" aria-label="${lbl}"><option value="all">All</option>${list.map(([k, l]) => `<option value="${esc(k)}" ${cur === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  v.innerHTML = `<div class="card"><h2>Trends agent · week ${S.slate.week}</h2><p class="small">Detected only from games before this week. ${T.items.filter(t => t.status !== 'faded').length} live trends, ${T.items.filter(t => t.status === 'faded').length} faded. ${on.length ? `Families moving predictions: ${esc(on.join(', '))}.` : '<strong>No family has passed walk-forward validation yet, so every trend is tracking, not yet proven, and moves chances by ±0.0 pp.</strong>'} Effects are bounded (×0.85–1.15 per trend) and applied before the safety caps and team TD budget.</p>
   <div class="row" role="group" aria-label="Trend filters">${opt('tfFamily', S.tf.family, fams.map(f => [f, T.families[f]?.label || f]), 'Type')}${opt('tfTeam', S.tf.team, teams.map(t => [t, t]), 'Team')}${opt('tfStatus', S.tf.status, [['new', 'New'], ['continuing', 'Continuing'], ['faded', 'Faded']], 'Status')}</div></div>
   ${drivesTrendsHtml()}
   <div class="trendgrid">${rows.map(trendCard).join('') || '<p class="muted">No trends match these filters.</p>'}</div>`;
  for (const [id, k] of [['tfFamily', 'family'], ['tfTeam', 'team'], ['tfStatus', 'status']]) v.querySelector('#' + id).addEventListener('change', e => { S.tf[k] = e.target.value; renderTrends(); });
}
function panelTrendsHtml(p) {
  const T = S.slate?.trends; const mine = (T?.items || []).filter(t => t.status !== 'faded' && t.affected.some(a => a.id === p.id));
  if (!mine.length) return '<p class="small muted">No active trend detected for him this week.</p>';
  const e = p.trendEffect;
  return `<p class="small">Before trends ${pc(e?.before, 1)} → after ${pc(e?.after, 1)} <span class="muted">(${esc(e?.note || 'before safety caps and the team TD budget')})</span></p><ul class="small">${mine.map(t => { const a = t.affected.find(x => x.id === p.id); return `<li><strong>${esc(t.type)}</strong> ${t.direction === 'up' ? '▲' : '▼'} <span class="pp">${ppTxt(a.pp)}</span> · ${esc(t.mode)} · ${STATUS_LBL[t.status]} since week ${t.firstDetectedWeek ?? '—'}<br>${esc(t.text)}</li>`; }).join('')}</ul>`;
}
function labTrendsHtml() {
  const T = S.slate?.trends; if (!T) return '';
  const V = T.validation || {}; const val = V.validation2026_x1e4 || {}; const gate = S.slate.learned?.components?.trends;
  const fmt = a => a ? `${a[0] > 0 ? '+' : ''}${a[0].toFixed(2)} [${a[1].toFixed(2)}, ${a[2].toFixed(2)}]` : '—';
  return `<div><h3>Trends agent validation</h3><p class="small">${esc(V.note || '')}</p>
   <div class="tablewrap" tabindex="0" role="region" aria-label="Trend family validation"><table style="min-width:560px"><thead><tr><th>Family</th><th>Weight</th><th>Status</th><th>Held-out ΔBrier ×1e-4</th><th>Held-out Δlog loss ×1e-4</th><th>Result</th></tr></thead><tbody>
   ${Object.entries(T.families).filter(([, f]) => f.effect !== 'none').map(([k, f]) => { const r = Object.entries(val).find(([n]) => n.startsWith(k + '@')); return `<tr><td>${esc(f.label)}</td><td>${T.weights[k] || 0}</td><td>${T.weights[k] ? 'on' : 'off (tracking)'}</td><td>${r ? `${fmt(r[1].dBrier)} <span class="muted">@${r[0].split('@')[1]}</span>` : '—'}</td><td>${r ? fmt(r[1].dLogLoss) : '—'}</td><td class="small">${esc(r?.[1].result || '')}</td></tr>`; }).join('')}</tbody></table></div>
   <p class="small muted">Negative = better. Display-only families: ${Object.entries(T.families).filter(([, f]) => f.effect === 'none').map(([, f]) => esc(f.label)).join(', ')}.</p>
   <p class="small">Tuesday gate: ${gate ? `${esc(gate.reason || '')}${gate.decidedAt ? ` (${esc(gate.decidedAt.slice(0, 10))})` : ''}` : 'not run yet for trends'}</p></div>`;
}
// ---------- AI analysis agent (key stays in this device's localStorage; sent only to the chosen provider)
const AI_LS = 'endzone.ai.v1', AI_CACHE = 'endzone.aicache.v1';
function aiSettings() { return load(AI_LS, { provider: 'xai', baseUrl: '', model: '', key: '' }); }
const snapKey = g => g.capturedAt || (g.frozen === 'snapshot' ? 'frozen' : S.slate?.generatedAt || '');
const aiKey = (g, p) => `${g.id}|${p.id}|${snapKey(g)}`;
function aiCached(g, p) { return (load(AI_CACHE, {}))[aiKey(g, p)] || null; }
function aiStore(g, p, rv) { const c = load(AI_CACHE, {}); c[aiKey(g, p)] = { ...rv, at: new Date().toISOString() }; const ks = Object.keys(c); for (const k of ks.slice(0, Math.max(0, ks.length - 150))) delete c[k]; save(AI_CACHE, c); }
function aiReviewHtml(rv) {
  const li = a => (a?.length ? `<ul class="small">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small muted">None noted.</p>');
  return `<section class="card ai ${rv.source}" aria-label="AI analysis"><div class="row between"><span class="eyebrow">${esc(rv.label)}</span><span class="small muted">${rv.at ? esc(new Date(rv.at).toLocaleString()) : ''}</span></div>
   <p class="why"><strong>${esc(rv.verdict)}</strong></p>${rv.note ? `<p class="small warn">${esc(rv.note)}</p>` : ''}
   <div class="aigrid"><div><h4>Case for</h4>${li(rv.caseFor)}</div><div><h4>Case against</h4>${li(rv.caseAgainst)}</div></div>
   <h4>Key risks</h4>${li(rv.risks)}<p class="small"><strong>Vs the model:</strong> ${esc(rv.vsModel)}</p>
   <p class="small muted">Commentary only: the model's numbers above are unchanged.</p></section>`;
}
async function runAi() {
  const f = findPlayer(S.panel.gameId, S.panel.playerId); if (!f) return; const { g, p } = f; const out = $('#aiOut');
  out.innerHTML = '<p class="small muted">Writing review…</p>';
  const opp = f.s === 'away' ? g.sides.home.team : g.sides.away.team;
  const misses = (S.slate?.trends?.items || []).filter(t => t.family === 'miss' && t.affected.some(a => a.id === p.id));
  const brief = buildBrief(p, S.detail || null, { opp, fair: fmtAmerican(p.chance), snapshotLabel: g.frozen || 'live', misses });
  const rv = await analyze(brief, aiSettings());
  aiStore(g, p, rv); if (S.panel?.playerId === p.id) out.innerHTML = aiReviewHtml({ ...rv, at: new Date().toISOString() });
}
function aiSettingsHtml() {
  const a = aiSettings(); const P = PROVIDERS[a.provider] || PROVIDERS.xai;
  return `<p class="small">Optional. Paste your own API key to get an AI-written review on each player panel. <strong>The key is stored only in this browser's localStorage on this device and is sent directly from your browser to the provider you choose.</strong> It is never sent to ENDZONE, the repo, snapshots or logs. Without a key, the panel uses a built-in rule-based review.</p>
   <div class="formgrid"><label class="small">Provider <select id="aiProvider">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${a.provider === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
   <label class="small">Base URL <input id="aiBase" type="url" placeholder="${esc(P.baseUrl)}" value="${esc(a.baseUrl)}"></label>
   <label class="small">Model <input id="aiModel" placeholder="${esc(P.model)}" value="${esc(a.model)}"></label>
   <label class="small">API key <input id="aiKey" type="password" autocomplete="off" placeholder="${a.key ? 'saved on this device' : 'paste key'}" value=""></label></div>
   <div class="row"><button class="btn" data-act="aisave">Save</button><button class="btn" data-act="aiclear">Remove key</button><span class="small muted" id="aiState">${a.key ? 'Key saved on this device.' : 'No key saved.'}</span></div>`;
}
function renderAll() {
  renderControls();
  if (S.tab === 'slate') renderSlate(); else if (S.tab === 'board') renderBoard(); else if (S.tab === 'trends') renderTrends(); else if (S.tab === 'drives') renderDrives(); else renderLab();
}
function renderControls() {
  $('#seasonLabel').textContent = S.slate ? `${S.slate.season} season` : '';
  $('#weekSelect').innerHTML = Array.from({ length: 18 }, (_, i) => `<option value="${i + 1}" ${S.week === i + 1 ? 'selected' : ''}>Week ${i + 1}${S.slate?.currentWeek === i + 1 ? ' (current)' : ''}</option>`).join('');
  $('#prevWeek').disabled = S.week <= 1; $('#nextWeek').disabled = S.week >= 18;
}

// ---------- Results vs predicted (finished games)
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
// Board stat sorts show the sorted stat (with its own model-confidence chip) in the focus list's last column.
const STAT_LBL = { rushYd: 'Rush yds', recYd: 'Rec yds', rec: 'Rec' };
const sortStat = k => { const m = String(k || '').replace(/Conf$/, ''); return STAT_LBL[m] ? m : null; };
const primaryCell = (p, stat) => { const [m, l] = stat ? [stat, STAT_LBL[stat]] : (PRIMARY[p.pos] || PRIMARY.WR); const v = p.volume?.[m]; return `<span class="muted small">${l}</span> ${v ? (m === 'rec' ? n1(v.mean) : n0(v.mean)) : '—'}${stat || (p.pos === 'QB' && /^passYd/.test(S.board.sort) && S.tab === 'board') ? ` ${chip(p.volConf?.[m]?.level)}` : ''}`; };
const focusBtn = (p, gid) => `<button class="plink" data-act="player" data-game="${esc(gid)}" data-player="${esc(p.id)}">${photo(p)}<span>${esc(p.name)} <span class="muted small">${esc(p.pos)} · ${esc(p.team)}</span></span></button>`;
function focusList(players, gidOf, label, withStar = false, stat = null) {
  return `<div class="focuslist" role="table" aria-label="${esc(label)} (focus view)"><div role="row" class="frow fhead small muted"><span role="columnheader">Player</span><span role="columnheader">Anytime</span><span role="columnheader">TD conf</span><span role="columnheader">${stat ? esc(STAT_LBL[stat]) : 'Primary yards'}</span></div>
   ${players.map(p => `<div role="row" class="frow ${p.tdConf.level === 'High' ? 'high' : ''}"><span role="cell" class="fplayer">${withStar ? star(p) : ''}${focusBtn(p, gidOf(p))}</span><span role="cell" class="mid">${pc(p.chance)}${blendMini(p)}</span><span role="cell" aria-label="TD confidence ${p.tdConf.level}">${chip(p.tdConf.level)}</span><span role="cell">${primaryCell(p, stat)}</span></div>`).join('')}</div>`;
}
function mobileCard(p, gid) {
  return `<div class="card ${p.tdConf.level === 'High' ? 'high' : ''}"><div class="pcard">${photo(p)}<div><button class="plink" data-act="player" data-game="${esc(gid)}" data-player="${esc(p.id)}">${esc(p.name)}</button><div class="small muted">${esc(p.pos)} · ${esc(p.team)} ${highBadge(p)}</div></div><div class="big">${pc(p.chance)}</div></div>
   <div class="row small">${chip(p.tdConf.level, 'TD')} band ${pc(p.band[0])}–${pc(p.band[1])}</div>${blendLine(p)}
   ${p.pos === 'QB' ? `<div class="small"><strong>Pass TD</strong> ${passTdCell(p)} · <strong>Pass yds</strong> ${volCell(p, 'passYd')}</div>` : ''}
   <div class="small">Rush ${volCell(p, 'rushYd')} · Rec yds ${volCell(p, 'recYd')} · Rec ${volCell(p, 'rec')}</div></div>`;
}

// ---------- Blend challenger (endzone-4.6, shadow only: never replaces the model's number until the gate passes)
const LEG_LABEL = { model: 'model', sleeper: 'Sleeper', usage: 'usage' };
const legsText = p => (p.challengerLegs || []).map(l => LEG_LABEL[l] || l).join(' + ');
const LEG_SHORT = { model: 'M', sleeper: 'S', usage: 'U' };
const blendMini = p => (p.challenger != null && p.challengerLegs ? `<span class="small muted blendline blendmini" title="Blend challenger (shadow): ${esc(legsText(p))}" aria-label="Blend challenger ${pc(p.challenger)} from ${esc(legsText(p))}">blend ${pc(p.challenger)} <span class="legs">${p.challengerLegs.map(l => LEG_SHORT[l] || l).join('')}</span></span>` : '');
const blendLine = p => (p.challenger != null && p.challengerLegs ? `<div class="small muted blendline" title="Shadow challenger: equal cloglog blend of ${esc(legsText(p))}">blend ${pc(p.challenger)} · ${esc(legsText(p))}</div>` : '');

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
    <label>Sort <select id="bsort">${SORT_GROUPS.map(([g, ks]) => `<optgroup label="${esc(g)}">${ks.map(k => `<option value="${k}" ${b.sort === k ? 'selected' : ''}>${esc(SORTS[k].label)}</option>`).join('')}</optgroup>`).join('')}</select></label></div>
   <p class="small muted">${rows.length} players. ${b.sort === 'default' ? 'High touchdown confidence first, then chance.' : b.sort === 'conf' ? 'Model TD confidence High › Med › Low, then chance. Team calls and ratings are unchanged.' : SORTS[b.sort]?.conf ? `Model confidence for ${esc(SORTS[b.sort].label.split(' — ')[0].toLowerCase())}: High › Med › Low, then projection. Players without that projection last.` : 'Explicit stat sort: team calls and ratings are unchanged.'}</p>
   <p class="scrollhint" aria-hidden="true">Scroll sideways for every column →</p>
   ${S.focus ? focusList(rows, p => p.gameId, 'Board', true, sortStat(b.sort)) : `   <div class="tablewrap desk-only" tabindex="0" role="region" aria-label="Board"><table><thead><tr><th scope="col">Player</th><th scope="col">★</th><th scope="col">Anytime</th><th scope="col">80% band</th><th scope="col">Edge</th><th scope="col">American fair price</th><th scope="col">TD conf</th><th scope="col">Rush yds</th><th scope="col">Rec yds</th><th scope="col">Receptions</th><th scope="col">Role</th></tr></thead>
   <tbody>${rows.map(p => `<tr class="${p.tdConf.level === 'High' ? 'high' : ''}"><td>${playerBtn(p, p.gameId)}${qbLine(p)}</td><td>${star(p)}</td><td class="mid">${pc(p.chance)}${blendLine(p)}</td><td>${pc(p.band[0])}–${pc(p.band[1])}</td><td>${p.edge == null ? 'n/a' : (p.edge > 0 ? '+' : '') + p.edge.toFixed(1)}</td><td>${fmtAmerican(p.chance)}</td><td>${chip(p.tdConf.level)}</td><td>${volCell(p, 'rushYd')}</td><td>${volCell(p, 'recYd')}</td><td>${volCell(p, 'rec')}</td><td>${(p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>
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
const sec = (title, body, open = false) => `<details class="sec"${open ? ' open' : ''}><summary>${esc(title)}</summary><div class="secbody">${body}</div></details>`;
// turn "<h3>Title</h3>body" chunks from the detail renderer into collapsed disclosures
const h3ToDetails = html => html.split('<h3>').filter(x => x.trim()).map(ch => { const k = ch.indexOf('</h3>'); return k < 0 ? ch : `<details class="sec"><summary>${ch.slice(0, k)}</summary><div class="secbody">${ch.slice(k + 5)}</div></details>`; }).join('');
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
  const [pm, pl] = PRIMARY[p.pos] || PRIMARY.WR; const pv = p.volume?.[pm];
  const why = d?.matchupLead?.sentence || p.conversionNote || p.tdConf.reasons?.[0] || '';
  const opp = f.s === 'away' ? g.sides.home.team : g.sides.away.team;
  const notes = [p.conversionNote, p.riser?.reason, p.secondOption, ...(p.safetyNotes || []), ...(p.lessonNotes || []), d?.notes?.spike].filter(Boolean);
  el.innerHTML = `<div class="pcols"><div class="pcol-a"><div class="row between phead"><h2 id="panelTitle">${esc(p.name)}</h2><button class="btn" data-act="close" aria-label="Close player details">Close ✕</button></div>
   <div class="row pid">${photo(p)}<div><span class="muted">${esc(p.pos)} · ${esc(p.team)} vs ${esc(opp)}</span><div class="small">${esc(d?.role || p.role || '')} · ${esc(p.avail?.label || '')}${p.replacing ? ` · replacing ${esc(p.replacing.name)}` : ''}</div></div></div>
   <section class="card summary ${p.tdConf.level === 'High' ? 'high' : ''}" aria-labelledby="sumH"><h3 id="sumH" class="eyebrow">Summary</h3>
     <div class="sumgrid"><div class="sumchance"><div class="small muted">Anytime chance</div><div class="big" aria-label="Anytime touchdown chance ${pc(p.chance)}">${pc(p.chance, 1)}</div></div>
       <div><div class="small muted">Fair price</div><strong>${fmtAmerican(p.chance)}</strong></div>
       <div><div class="small muted">Edge</div><strong>${p.edge == null ? '—' : (p.edge > 0 ? '+' : '') + p.edge.toFixed(1) + ' pts'}</strong></div>
       <div><div class="small muted">TD conf.</div>${chip(p.tdConf.level)}</div>
       <div><div class="small muted">${pl}</div><strong>${pv ? (pm === 'rec' ? n1(pv.mean) : n0(pv.mean)) : '—'}</strong> <span class="small muted">${pv ? `${n0(pv.lo)}–${n0(pv.hi)}` : ''}</span></div></div>
     <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p.chance * 100)}" aria-label="Chance"><span style="width:${(p.chance * 100).toFixed(1)}%"></span></div>
     ${why ? `<p class="why">${esc(why)}</p>` : ''}</section>
   <div class="row"><button class="btn gold" data-act="ai" aria-describedby="aiHint">AI analysis</button><span id="aiHint" class="small muted">${aiSettings().key ? `Uses your ${esc(PROVIDERS[aiSettings().provider]?.label || 'AI')} key from Lab · never changes the model's number` : 'No AI key set: built-in review (add a key in Lab → AI analyst)'}</span></div>
   <div id="aiOut" aria-live="polite">${aiCached(g, p) ? aiReviewHtml(aiCached(g, p)) : ''}</div>
   </div><div class="pcol-b">
   ${sec('Probability details', `<div class="kv small"><div>Published projection<br><strong>${p.published ? pc(p.published.probability) : 'none'}</strong></div>${p.challenger != null ? `<div>Blend challenger<br><strong>${pc(p.challenger, 1)}</strong> <span class="muted">(${esc(legsText(p) || 'model')})</span></div>` : ''}${p.usage != null ? `<div>Usage leg<br><strong>${pc(p.usage, 1)}</strong></div>` : ''}<div>First TD<br><strong>${pc(p.firstTd, 1)}</strong></div><div>Two or more<br><strong>${pc(dist.twoPlus, 1)}</strong></div><div>80% band<br><strong>${pc(p.band[0])}–${pc(p.band[1])}</strong></div></div>
     ${p.challenger != null ? `<p class="small muted">Blend challenger = equal-weight average of ${esc(legsText(p) || 'model')} on the log-intensity (cloglog) scale, after the safety caps. Shadow only: the headline number stays the model's until the prospective gate (500 players / 40 games) promotes it.</p>` : ''}
     <p class="small">Count distribution: 0 ${pc(dist.p0)} · 1 ${pc(dist.p1)} · 2 ${pc(dist.p2)} · 3+ ${pc(dist.p3plus)} (λ ${n1(p.lambda)}). The band is uncertainty about the probability, not a range for his touchdown count.</p>`)}
   ${d ? sec('Score matchup', `<p>${esc(d.matchupLead.sentence)}</p><p class="small">${esc(d.matchupLead.evidence || '')} ${d.matchupLead.featured ? `This offense ${esc(d.matchupLead.featured)} the position (role ratio ${d.matchupLead.roleRatio?.toFixed(2)}).` : ''} ${d.matchupLead.liftBlocked ? 'No real recent scoring opportunities, so the soft position does not lift him.' : ''}</p><p class="small muted">${esc(d?.weather?.note || '')}</p>`) : '<p class="muted small">Loading details…</p>'}
   ${sec('Confidence by area', `<div class="row">${conf.map(([k, c]) => chip(c?.level || 'Low', k)).join(' ')}</div>${highs.length ? `<p class="small"><strong>Why High:</strong> ${highs.map(([k, c]) => `${esc(k)}: ${esc(c.reasons.join(' '))}`).join(' ')}</p>` : ''}${conf.map(([k, c]) => `<p class="small"><strong>${esc(k)} ${c?.level}:</strong> ${esc([...(c?.reasons || []), ...(c?.blocks || [])].join(' '))}</p>`).join('')}`)}
   ${sec('Volume forecasts', `<div class="kv small">${Object.entries(p.volume || {}).map(([k, v]) => `<div><strong>${esc({ rushYd: 'Rush yards', rec: 'Receptions', recYd: 'Receiving yards', passYd: 'Pass yards' }[k])}</strong> ${k === 'rec' ? n1(v.mean) : n0(v.mean)} <span class="muted">(${k === 'rec' ? n1(v.lo) : n0(v.lo)}–${k === 'rec' ? n1(v.hi) : n0(v.hi)})</span><br>${esc(v.text || '')}<br><span class="muted">${esc(v.source || '')}</span></div>`).join('')}</div>`)}
   ${p.pos === 'QB' ? sec('Passing touchdowns', `<p>${passTdCell(p)}</p><p class="small">${esc((p.passTd?.reasons || []).join(' '))} Passing TDs do not count toward his anytime chance.</p>`) : ''}
   ${sec('Drive patterns', drivePanelHtml(p))}
   ${sec('Trends that moved his chance', panelTrendsHtml(p))}
   ${notes.length ? sec('Model notes', notes.map(t => `<p class="small">• ${esc(t)}</p>`).join('')) : ''}
   ${d ? h3ToDetails(detailBody(d, p, g)) : ''}</div></div>`;
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
  const T = S.slate.pickTracker; if (!T) return '<div><h3>Pick tracker</h3><p class="small muted">Unavailable (archive not loaded).</p></div>';
  const rec = g => g.total ? `${g.hits}/${g.total} (${Math.round(100 * g.hits / g.total)}%)` : '0/0';
  const lst = l => l.map(x => `<li>${esc(x.name)} ${esc(x.team)} · ${pc(x.chance)} · <strong class="${x.outcome === 'scored' ? 'ok' : ''}">${esc(x.outcome)}</strong></li>`).join('') || '<li class="muted">None</li>';
  const kinds = { prospective: 'Prospective (frozen pregame snapshots)', reconstructed: 'Reconstructed (earlier-week features; not prospective evidence)' };
  return `<div id="pickTracker"><h3>Pick tracker</h3>
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
   <h3>Auto-calibration decisions</h3><ul class="small">${dec('caps')}${dec('challenger')}${dec('trends')}${dec('drives')}</ul>${X.promotion ? `<p class="small muted">Challenger promotion check: ${X.promotion.promote ? 'passes' : esc(X.promotion.reasons.join(' '))}</p>` : ''}`;
}
function blendMonitorHtml() {
  const R = S.slate.research; const M = R?.monitor; const B = S.slate.blendBaseline; const ch = S.slate.challenger;
  const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(d)}`);
  const ci = c => (c ? `[${f(c[0])}, ${f(c[1])}]` : '');
  const cell = d => (d ? `<span class="${d.dBrierCI[1] < 0 ? 'ok' : d.dBrierCI[0] > 0 ? 'warn' : ''}">${f(d.dBrier)}</span> <span class="muted">${ci(d.dBrierCI)}</span>` : '—');
  const table = (rep, cap) => {
    if (!rep?.slices || !(rep.n ?? rep.slices.all?.n)) return `<p class="small muted">${esc(cap)}: no graded rows yet.</p>`;
    return `<p class="small"><strong>${esc(cap)}</strong></p><div class="tablewrap" tabindex="0" role="region" aria-label="${esc(cap)}"><table class="monitor" style="min-width:560px"><thead><tr><th scope="col">Slice</th><th scope="col">n</th><th scope="col">Actual</th><th scope="col">Model</th><th scope="col">Blend</th><th scope="col">Sleeper</th><th scope="col">Blend − model Brier ×1000</th><th scope="col">Blend − Sleeper Brier ×1000</th></tr></thead><tbody>
      ${['all', 'implied275', 'fav7', 'gl1535', 'te1', 'runQb'].filter(k => rep.slices[k]).map(k => [k, rep.slices[k]]).map(([k, x]) => x.n ? `<tr data-slice="${k}"><th scope="row">${esc(x.name)}</th><td>${x.n}</td><td>${pc(x.actual, 1)}</td><td>${pc(x.model.mean, 1)}</td><td>${pc(x.challenger.mean, 1)}</td><td>${pc(x.sleeper.mean, 1)}</td><td>${cell(x.vsModel)}</td><td>${cell(x.vsSleeper)}</td></tr>` : `<tr data-slice="${k}"><th scope="row">${esc(x.name)}</th><td colspan="7" class="muted">no rows yet</td></tr>`).join('')}</tbody></table></div>`;
  };
  // TE-gap flag: the first non-provisional source (live 4.6.0 → backfilled snapshots → walk-forward baseline); small samples are shown as provisional notes
  const teSrc = [['live', M?.live?.teGap], ['snapshots', M?.withBackfill?.teGap], ['walk-forward baseline', B?.teGap]].filter(([, t]) => t?.n);
  const [teFrom, te] = teSrc.find(([, t]) => !t.provisional) || teSrc[teSrc.length - 1] || [];
  const teProv = teSrc.filter(([k, t]) => t.provisional && k !== teFrom).map(([k, t]) => `${k}: blend ${t.gapBlendPts > 0 ? '+' : ''}${t.gapBlendPts} pts vs actual, n ${t.n} (provisional)`);
  const H = B?.headline; const pr = R?.promotion?.metrics;
  return `<div id="blendMonitor"><h3>Blend challenger vs model vs Sleeper</h3>
   <p class="small">Challenger: <strong>${esc(ch?.kind === 'blend3' ? '3-way blend (model + Sleeper + usage leg)' : ch?.status || 'unknown')}</strong>${ch?.usage ? ` · usage table week ${ch.usage.week} (${ch.usage.players} players, ${ch.usage.trainRows} training player-games)` : ''}${ch?.reason ? ` · ${esc(ch.reason)}` : ''}. Shadow only until the prospective gate passes.</p>
   ${pr ? `<p class="small">Running score (prospective, counts toward the gate): ${pr.paired} players / ${pr.games} games${pr.champion ? ` · Brier model ${pr.champion.brier.toFixed(4)} vs blend ${pr.challenger.brier.toFixed(4)}` : ''}. Gate needs 500 / 40.</p>` : ''}
   ${te ? `<p class="small ${te.flagged ? 'warn' : 'ok'}" id="teGapFlag" role="status">${te.flagged ? '⚑ ' : ''}${esc(te.reason)} <span class="muted">(${esc(teFrom)}, n ${te.n}${teProv.length ? `; ${esc(teProv.join('; '))}` : ''})</span></p>` : ''}
   ${table(M?.live, 'Live: prospective 4.6.0 snapshots')}
   ${M?.withBackfill?.n ? table(M.withBackfill, `All frozen snapshots${M.retroWeeks?.length ? ` (weeks ${M.retroWeeks.join(', ')} scored with a walk-forward backfilled blend, not counted by the gate)` : ''}`) : ''}
   ${B ? `<details class="sec"><summary>Walk-forward baseline (${B.n} players)</summary><div class="secbody">
     <p class="small">Blend − model: Brier ${f(H.vsModel.dB)} ${ci(H.vsModel.dBci)}, log loss ${f(H.vsModel.dLL)} ${ci(H.vsModel.dLLci)} (×1000). Blend − Sleeper: Brier ${f(H.vsSleeper.dB)}, log loss ${f(H.vsSleeper.dLL)}. Negative = blend better.</p>
     ${table(B, B.label)}</div></details>` : ''}
   <p class="small muted">Slices: implied team total 27.5+, favored by 7+, goal-line share 15–35%, TE1s, running QBs (3.5+ projected carries). Intervals resample whole games. Updated by each archive run.</p></div>`;
}
function renderLab() {
  const v = $('#view-lab'); if (!S.slate) { v.innerHTML = ''; return; }
  const W = S.weights; const labels = { recentBlend: 'Recent volume blend', publishedBlend: 'Published projection blend', script: 'Game script', redZone: 'Red zone', shrinkGames: 'Shrinkage games', tePremium: 'TE premium', goalLine: 'Goal-line weight' };
  const L = S.slate.lessons; const bt = S.backtest; const R = S.slate.research; const ch = S.slate.challenger;
  const met = c => c && c.n ? `n ${c.n} · Brier ${c.brier?.toFixed(4)} · log loss ${c.logLoss?.toFixed(4)} · flat-25% Brier ${c.flat25Brier?.toFixed(4)} · vs published (n ${c.matched.n}): ${c.matched.model?.toFixed(4) ?? '—'} vs ${c.matched.published?.toFixed(4) ?? '—'}` : 'no confirmed results';
  const sect = (id, title, body) => `<section class="labsec card" aria-labelledby="lab-${id}"><h2 id="lab-${id}">${title}</h2>${body}</section>`;
  const repo = learnedRepoHtml(); const cut = repo.indexOf('<h3>Auto-calibration decisions</h3>');
  const repoLearn = cut < 0 ? repo : repo.slice(0, cut), repoGates = cut < 0 ? '' : repo.slice(cut);
  v.innerHTML = `<nav class="labnav small" aria-label="Lab sections">${[['weights', 'Weights'], ['results', 'Results & calibration'], ['learning', 'Learning'], ['trends', 'Trends'], ['drives', 'Drive patterns'], ['gates', 'Model gates'], ['ai', 'AI analyst'], ['sources', 'Sources']].map(([k, l]) => `<a href="#lab-${k}">${l}</a>`).join('')}</nav>
   ${sect('weights', 'Weights', `<p class="small muted">Changes recalculate only unplayed games; finished predictions stay frozen. Saved on this device.</p>
    <div class="sliders">${Object.keys(labels).map(k => `<label class="small">${labels[k]} <strong id="wv-${k}">${W[k]}</strong><input type="range" data-weight="${k}" min="${WEIGHT_RANGES[k][0]}" max="${WEIGHT_RANGES[k][1]}" step="${k === 'shrinkGames' ? 1 : 0.01}" value="${W[k]}" aria-label="${labels[k]}"></label>`).join('')}</div>
    <button class="btn" data-act="reset">Reset weights</button>`)}
   ${sect('results', 'Results & calibration', `<div class="row"><button class="btn gold" data-act="backtest">Run backtest for week ${S.week}</button></div>
     ${bt ? `<p class="small">${bt.finishedGames} finished games · confirmed ${bt.td.cohorts.all.all.n} (prospective ${bt.td.prospective}, reconstructed ${bt.td.reconstructed}) · missing excluded ${bt.td.missingExcluded} · confirmed zeros ${bt.td.cohorts.all.all.confirmedZeros}</p>
      <p class="small"><strong>Reconstructed outcomes do not prove prospective accuracy.</strong></p>
      ${['all', 'contributors', 'teamCalls', 'highTd', 'medTd', 'lowTd'].map(k => `<p class="small"><strong>${k}</strong>: ${met(bt.td.cohorts[k].all)}<br><span class="muted">prospective: ${met(bt.td.cohorts[k].prospective)}</span></p>`).join('')}
      <h3>Calibration bins (all)</h3><div class="tablewrap"><table style="min-width:480px"><thead><tr><th>Bin</th><th>n</th><th>Avg chance</th><th>Hit rate</th><th>95% interval</th></tr></thead><tbody>${bt.td.cohorts.all.all.bins.map(b => `<tr><td>${b.label}</td><td>${b.n}</td><td>${pc(b.avgChance, 1)}</td><td>${pc(b.hitRate, 1)}</td><td>${pc(b.ci[0])}–${pc(b.ci[1])}</td></tr>`).join('')}</tbody></table></div>
      <h3>Volume accuracy</h3>${Object.entries(bt.volume).filter(([k]) => k !== 'passTd').map(([k, x]) => `<p class="small"><strong>${k}</strong>: n ${x.overall.n} · MAE ${n1(x.overall.mae)} · bias ${n1(x.overall.bias)} · coverage ${pc(x.overall.coverage)} · by confidence ${esc(Object.entries(x.byConfidence).map(([c, y]) => `${c} ${pc(y.coverage)} (n${y.n})`).join(', '))}</p>`).join('')}<p class="small warn">${esc(bt.volume.passTd.note)}</p>
      <h3>Highest-chance misses</h3><ul class="small">${bt.td.highestMisses.map(r => `<li>${esc(r.name)} ${pc(r.chance)} — ${esc(r.reason)}</li>`).join('')}</ul>
      <h3>Lowest-chance scorers</h3><ul class="small">${bt.td.lowestScorers.map(r => `<li>${esc(r.name)} ${pc(r.chance)} (${r.td} TD)</li>`).join('')}</ul>
      <h3>Expected vs actual by yard-line spot</h3><p class="small">${bt.td.spots.agg.map(s => `${s.spot}: ${s.expected.toFixed(1)} exp / ${s.actual} act`).join(' · ')} (unknown-spot rows excluded: ${bt.td.spots.excludedUnknown})</p>
      <h3>Meaningful expected, zero confirmed</h3><ul class="small">${bt.td.spots.meaningfulZero.slice(0, 12).map(r => `<li>${esc(r.name)} ${r.spot} expected ${r.expected.toFixed(2)}</li>`).join('') || '<li>None</li>'}</ul>` : ''}
     ${blendMonitorHtml()}
     ${pickTrackerHtml()}`)}
   ${sect('learning', 'Learning', `${L?.describe?.length ? `<p class="small">${esc(L.describe[0])}</p><details class="sec"><summary>All learned scales (${L.describe.length - 1})</summary><div class="secbody"><p class="small">${L.describe.slice(1).map(esc).join(' · ')}</p><p class="small muted">Basis: ${(L?.active?.basis || []).map(b => `week ${b.week}: ${b.applied ? `${b.prospective} prospective / ${b.reconstructed} reconstructed` : 'none'}`).join(' · ')}</p></div></details>` : '<p class="small muted">No lesson yet.</p>'}
     <p class="small">${L?.inWeek?.applied ? `In-week nudge from ${L.inWeek.confirmed} completed results this week, damped (scale+2)/3, unplayed games only.` : 'No in-week nudge (needs 8 completed results this week).'}</p>${repoLearn}`)}
   ${sect('trends', 'Trends', labTrendsHtml())}
   ${sect('drives', 'Drive patterns: with vs without', drivesData() ? scoreboardHtml(drivesData(), 'lab') : '<p class="small muted">Drive file not loaded for this week.</p>')}
   ${sect('gates', 'Model gates', `${repoGates || '<p class="small muted">Gate decisions come from the shared archive (not loaded in this copy).</p>'}
     <h3>Champion / challenger</h3><p class="small">Challenger: ${esc(ch?.status || 'unknown')}${ch?.reason ? ' — ' + esc(ch.reason) : ''} · training rows ${ch?.trainingCount ?? 0}</p>
     ${R?.promotion ? `<p class="small">Promotion: <strong>${R.promotion.promote ? 'eligible' : 'withheld'}</strong>. ${esc(R.promotion.reasons.join(' '))} Paired ${R.promotion.metrics.paired} across ${R.promotion.metrics.games} games.</p>` : '<p class="small muted">No validation run yet.</p>'}
     ${R?.summary ? `<p class="small">Archive: ${R.summary.prospective} prospective / ${R.summary.reconstructed} reconstructed graded · missing excluded ${R.summary.missingExcluded}</p>` : ''}`)}
   ${sect('ai', 'AI analyst', aiSettingsHtml())}
   ${sect('sources', 'Sources & refresh', `<ul class="small">${Object.values(S.slate.sources).map(s => `<li>${s.ok ? '✓' : '✗'} ${esc(s.label)} ${s.fetchedAt ? `· ${new Date(s.fetchedAt).toLocaleString()}` : ''}${s.stale ? ' · stale' : ''}${s.error ? ` · <span class="warn">${esc(s.error)}</span>` : ''}</li>`).join('')}</ul><p class="small muted">Charting: FTN Data via nflverse, CC-BY-SA 4.0.</p>
     <p class="small">${esc(S.slate.repoArchive ? 'A scheduled GitHub Actions job captures pregame snapshots and grades finished games into the shared archive; this page loads it.' : 'This copy has no shared archive; it refreshes when you press Refresh.')} Archive job: ${S.slate.lastRun ? `last run ${esc(S.slate.lastRun.status)} at ${esc(S.slate.lastRun.finished_at || S.slate.lastRun.started_at)}` : 'never run'}.</p>
     <label class="small"><input type="checkbox" id="autoToggle" ${S.auto.enabled ? 'checked' : ''}> Auto-refresh every ${S.auto.minutes} minutes while open (off by default)</label>
     <div class="row"><button class="btn" data-act="job">Run archive refresh now</button></div><p id="jobOut" class="small" aria-live="polite"></p>`)}`;
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
  else if (a === 'gotab') document.getElementById('tab-' + t.dataset.tab)?.click();
  else if (a === 'dvmode') { S.dv.mode = t.dataset.mode; S.dv.who = ''; save(LS_DRIVES, S.dv); renderDrives(); }
  else if (a === 'dvn') { S.dv.n = t.dataset.n === 'season' ? 'season' : +t.dataset.n; save(LS_DRIVES, S.dv); renderDrives(); }
  else if (a === 'dvgt') { S.dv.gt = t.dataset.team; S.dv.who = ''; save(LS_DRIVES, S.dv); renderDrives(); }
  else if (a === 'dvst') { S.dv.st = t.dataset.st; if (S.dv.st === 'recYd' || S.dv.st === 'rushYd') { if (S.dv.th < 5) S.dv.th = S.dv.st === 'recYd' ? 20 : 10; } else if (S.dv.th > 6) S.dv.th = 1; save(LS_DRIVES, S.dv); renderDrives(); }
  else if (a === 'dvth') { S.dv.st = t.dataset.st; S.dv.th = +t.dataset.th; save(LS_DRIVES, S.dv); renderDrives(); }
  else if (a === 'dvpl') { S.dv.pl = t.dataset.pid; save(LS_DRIVES, S.dv); renderDrives(); $('#dvPbd')?.scrollIntoView({ block: 'start' }); }
  else if (a === 'simrun') runSimUi(!!t.dataset.new);
  else if (a === 'simmode') { S.sim.mode = t.dataset.mode === 'pbp' ? 'pbp' : 'drive'; save('endzone.simMode', S.sim.mode); paintSim(); }
  else if (a === 'simgame') { if (t.dataset.close) { S.sim.replay = null; S.sim.rg = null; paintSim(); } else simReplay(); }
  else if (a === 'simteam') { S.sim.team = t.dataset.team; paintSim(); }
  else if (a === 'simth') { S.sim.st = t.dataset.st; S.sim.th = +t.dataset.th; paintSim(); }
  else if (a === 'simdth') { S.sim.dst = t.dataset.st; S.sim.dth = +t.dataset.th; paintSim(); }
  else if (a === 'simdrv') { S.sim.ds = +t.dataset.s || 0; paintSim(); $('#simDrv')?.scrollIntoView({ block: 'nearest' }); }
  else if (a === 'simpl') { S.sim.pj = t.dataset.j === '' ? null : +t.dataset.j; paintSim(); if (S.sim.pj != null) $('#simPl')?.scrollIntoView({ block: 'start' }); }
  else if (a === 'dcell') { const o = $('#dcellOut'); if (o) o.innerHTML = dcellHtml(drivesData(), S.dv.gridTeam, t.dataset.w, t.dataset.n); }
  else if (a === 'close') closePanel();
  else if (a === 'ai') runAi();
  else if (a === 'aisave') { const cur = aiSettings(); const k = $('#aiKey').value.trim(); save(AI_LS, { provider: $('#aiProvider').value, baseUrl: $('#aiBase').value.trim(), model: $('#aiModel').value.trim(), key: k || cur.key }); $('#aiKey').value = ''; $('#aiState').textContent = aiSettings().key ? 'Key saved on this device.' : 'Settings saved (no key).'; }
  else if (a === 'aiclear') { save(AI_LS, { ...aiSettings(), key: '' }); $('#aiState').textContent = 'Key removed from this device.'; }
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
// Rotation / breakpoint changes re-render in place (no reload): selected game, open player, filters and scroll are kept.
let mqTimer = null;
const onLayoutChange = () => { clearTimeout(mqTimer); mqTimer = setTimeout(() => { if (!S.slate) return; const y = window.scrollY; const ps = $('#panel')?.scrollTop || 0; renderAll(); if (S.panel) { renderPanel(); $('#panel').scrollTop = ps; } window.scrollTo(0, y); }, 120); };
for (const q of ['(max-width:1023px)', '(orientation:landscape)', '(max-height:500px)', '(max-width:720px)']) window.matchMedia(q).addEventListener('change', onLayoutChange);
window.addEventListener('resize', () => { if (S.panel) renderPanel(); });
renderControls(); applyAuto(); startLoad(false); // initial load only; no background schedule unless the user opts in
