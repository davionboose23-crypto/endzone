// AI analysis agent (endzone-4.5). Builds a compact brief from fields the model already produced (nothing derived
// beyond simple copies/rounding), asks a user-configured provider for a written review, and falls back to a
// deterministic built-in review. Reviews never change the model's numbers. The API key lives only in the
// browser's localStorage and is sent only to the configured provider; it is never part of a brief, cache or snapshot.
const r3 = x => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const pct = x => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const has = v => v != null && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
const prune = o => Object.fromEntries(Object.entries(o).filter(([, v]) => has(v)));
export const BRIEF_FIELDS = ['player', 'model', 'confidence', 'volume', 'yardLinePies', 'matchup', 'trends', 'recentGames', 'headToHead', 'availability', 'result', 'modelMisses'];
const LOG = r => prune({ week: r.week, season: r.season, opp: r.opp, carries: r.carries, rushYd: r.rushYd, targets: r.targets, rec: r.rec, recYd: r.recYd, td: r.td });

export function buildBrief(p, d = null, ctx = {}) {
  const b = {
    player: prune({ name: p.name, pos: p.pos, team: p.team, opponent: ctx.opp, role: d?.role || p.role }),
    model: prune({ anytimeChance: r3(p.chance), band80: p.band?.map(r3), expectedTds: r3(p.lambda), firstTd: r3(p.firstTd), components: p.components ? prune(Object.fromEntries(Object.entries(p.components).filter(([, v]) => v > 0.0005).map(([k, v]) => [k, r3(v)]))) : null,
      publishedProbability: r3(p.published?.probability ?? (typeof p.published === 'number' ? p.published : null)), edgePts: r3(p.edge), fairAmerican: ctx.fair || null, snapshot: ctx.snapshotLabel || null }),
    confidence: prune({ td: p.tdConf ? prune({ level: p.tdConf.level, reasons: p.tdConf.reasons, blocks: p.tdConf.blocks }) : null, volume: p.volConf ? Object.fromEntries(Object.entries(p.volConf).map(([k, c]) => [k, c.level])) : null }),
    volume: p.volume ? Object.fromEntries(Object.entries(p.volume).map(([k, v]) => [k, prune({ mean: r3(v.mean), lo: r3(v.lo), hi: r3(v.hi) })])) : null,
    yardLinePies: d?.pies ? Object.fromEntries(Object.entries(d.pies).map(([k, x]) => [k, prune({ spot: x.label, playerLast3: x.player, teamLast3: x.team, playerSeason: x.seasonPlayer, teamSeason: x.seasonTeam })])) : null,
    matchup: prune({ sentence: d?.matchupLead?.sentence, evidence: d?.matchupLead?.evidence, positionFactor: r3(p.matchupFactor), liftBlocked: d?.matchupLead?.liftBlocked || null }),
    trends: (p.trendEffect?.items || []).map(t => prune({ family: t.family, text: t.text, weight: t.weight, pp: r3(t.pp) })).concat((p.trendTags || []).filter(t => !(p.trendEffect?.items || []).some(i => i.id === t.id)).map(t => prune({ family: t.family, direction: t.direction, status: t.status }))),
    recentGames: (d?.last5 || []).map(LOG),
    headToHead: (d?.h2h || []).map(LOG),
    availability: prune({ status: p.avail?.label, injury: p.injury, practice: p.practice, replacing: p.replacing?.name }),
    result: d?.actual && d.actual.status !== 'pending' ? prune({ status: d.actual.status, td: d.actual.td, rushYd: d.actual.rushYd, recYd: d.actual.recYd, rec: d.actual.rec }) : null,
    modelMisses: (ctx.misses || []).map(m => prune({ text: m.text, evidence: m.evidence })),
  };
  return prune(b);
}

// Deterministic rule-based review from the same brief.
export function builtinReview(b) {
  const m = b.model || {}; const c = m.anytimeChance ?? 0; const lvl = b.confidence?.td?.level || 'Low';
  const forL = [], against = [], risks = [];
  const gl = b.yardLinePies?.r1; if (gl && gl.teamLast3 > 0) { const s = gl.playerLast3 / gl.teamLast3; (s >= 0.4 ? forL : s < 0.15 ? against : forL).push(`Goal-line rushes (1–5): ${gl.playerLast3} of the team's ${gl.teamLast3} over the last three weeks.`); }
  const ez = b.yardLinePies?.t1; if (ez && ez.playerLast3 >= 2) forL.push(`Inside-5 targets: ${ez.playerLast3} of ${ez.teamLast3} over the last three weeks.`);
  const tdG = (b.recentGames || []).filter(g => g.td > 0).length; const nG = (b.recentGames || []).length;
  if (nG) (tdG >= 2 ? forL : tdG === 0 && nG >= 3 ? against : forL).push(`Scored in ${tdG} of his last ${nG} games.`);
  const f = b.matchup?.positionFactor; if (f != null) { if (f >= 1.03) forL.push(`Matchup lifts the position (factor ×${f.toFixed(2)}).`); else if (f <= 0.97) against.push(`Tough matchup for the position (factor ×${f.toFixed(2)}).`); }
  if (m.edgePts != null) { if (m.edgePts >= 2) forL.push(`Model is ${m.edgePts.toFixed(1)} pts above the published projection.`); else if (m.edgePts <= -2) against.push(`Model is ${Math.abs(m.edgePts).toFixed(1)} pts below the published projection.`); }
  for (const t of b.trends || []) if (t.text) ((/rose|up|soft|scored|more|Under/.test(t.text)) ? forL : (/fell|tight|down|Over/.test(t.text) ? against : forL)).push(`Trend (${t.family}, tracking only unless weighted): ${t.text}`);
  if (lvl !== 'High' && b.confidence?.td?.blocks?.length) against.push(`TD confidence ${lvl}: ${b.confidence.td.blocks[0]}`);
  if (m.band80) { const w = m.band80[1] - m.band80[0]; if (w >= 0.3) risks.push(`Wide 80% band (${pct(m.band80[0])}–${pct(m.band80[1])}): the probability itself is uncertain.`); }
  if (b.availability?.injury || (b.availability?.status && !/^Available|Active/i.test(b.availability.status))) risks.push(`Availability: ${[b.availability.status, b.availability.injury, b.availability.practice].filter(Boolean).join(' · ')}.`);
  if (nG && nG < 3) risks.push(`Thin sample: only ${nG} recent games in the brief.`);
  for (const x of b.modelMisses || []) risks.push(`Model history: ${x.text}`);
  if (!risks.length) risks.push('Touchdowns are high-variance: even a strong case misses often.');
  const verdict = c >= 0.4 && lvl === 'High' ? 'Strong play' : c >= 0.3 ? 'Solid option' : c >= 0.18 ? 'Speculative' : 'Long shot';
  const vs = `The model's number is ${pct(c)}${m.fairAmerican ? ` (fair ${m.fairAmerican})` : ''}${m.publishedProbability != null ? ` vs a published ${pct(m.publishedProbability)}` : ''}. This review uses only the model's own inputs, so it explains that number rather than second-guessing it.`;
  return { source: 'builtin', label: 'Built-in review (no AI key)', verdict: `${verdict}: ${pct(c)} anytime, TD confidence ${lvl}.`, caseFor: forL.slice(0, 5), caseAgainst: against.slice(0, 5), risks: risks.slice(0, 4), vsModel: vs };
}

export const PROVIDERS = { xai: { label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-4' }, openai: { label: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' } };
export const SYSTEM_PROMPT = 'You are an NFL anytime-touchdown analyst reviewing one player for a research model. Use ONLY the JSON brief you are given. Do not invent or recall statistics, injuries, news or numbers that are not in the brief; if something is missing, say it is not in the brief. Reply with JSON only: {"verdict": string (one sentence), "caseFor": string[], "caseAgainst": string[], "risks": string[], "vsModel": string (how your view compares with the model\'s anytimeChance)}. Keep each item under 30 words.';
export function requestBody(brief, model) { return { model, temperature: 0.2, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(brief) }] }; }
export function parseReply(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/); if (!m) throw new Error('no JSON in reply');
  const j = JSON.parse(m[0]); const arr = x => (Array.isArray(x) ? x.map(String).slice(0, 6) : []);
  if (!j.verdict) throw new Error('reply missing verdict');
  return { verdict: String(j.verdict), caseFor: arr(j.caseFor), caseAgainst: arr(j.caseAgainst), risks: arr(j.risks), vsModel: String(j.vsModel || '') };
}
// settings = { provider, baseUrl, model, key }. Falls back to the built-in review on no key or any failure.
export async function analyze(brief, settings, { fetchFn = globalThis.fetch, timeoutMs = 45000 } = {}) {
  const fallback = note => ({ ...builtinReview(brief), note });
  if (!settings?.key) return fallback(null);
  const P = PROVIDERS[settings.provider] || PROVIDERS.xai; const base = (settings.baseUrl || P.baseUrl).replace(/\/+$/, ''); const model = settings.model || P.model;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null; const t = ctl && setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.key}` }, body: JSON.stringify(requestBody(brief, model)), signal: ctl?.signal });
    if (!r.ok) throw new Error(`provider HTTP ${r.status}`);
    const j = await r.json(); const out = parseReply(j?.choices?.[0]?.message?.content);
    return { source: 'ai', label: `AI review · ${P.label} · ${model}`, ...out };
  } catch (e) { return fallback(`AI call failed (${String(e.message || e).replace(settings.key, '[key]')}); showing the built-in review.`); }
  finally { if (t) clearTimeout(t); }
}
