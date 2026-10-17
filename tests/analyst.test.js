// endzone-4.5 AI analysis agent: brief has only real fields, fallback works, no key leaks anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeFixture } from './fixture.js';
import { runEngine } from '../src/engine.js';
import { snapshotFromGame } from '../src/grading.js';
import { buildBrief, builtinReview, analyze, BRIEF_FIELDS, requestBody, SYSTEM_PROMPT, parseReply } from '../src/analyst.js';
const KEY = 'xai-TEST-SECRET-123456';
const firstKick = prep => Math.min(...prep.games.filter(g => g.week === prep.week).map(g => Date.parse(g.kickoff)));
const setup = () => { const prep = makeFixture(); const res = runEngine(prep, { now: firstKick(prep) - 864e5 }); const G = res.games[0]; return { res, G, p: G.sides.home.players[0] }; };

test('brief contains only real fields copied from the prediction (no invented stats)', () => {
  const { p } = setup();
  const b = buildBrief(p, null, { opp: 'BUF', fair: '+150' });
  for (const k of Object.keys(b)) assert.ok(BRIEF_FIELDS.includes(k), `unexpected section ${k}`);
  assert.equal(b.model.anytimeChance, Math.round(p.chance * 1000) / 1000);
  assert.deepEqual(b.model.band80, p.band.map(x => Math.round(x * 1000) / 1000));
  for (const [k, v] of Object.entries(b.model.components || {})) assert.equal(v, Math.round(p.components[k] * 1000) / 1000);
  for (const [k, v] of Object.entries(b.volume || {})) assert.equal(v.mean, Math.round(p.volume[k].mean * 1000) / 1000);
  assert.equal(b.confidence.td.level, p.tdConf.level);
  assert.ok(!('yardLinePies' in b) && !('recentGames' in b) && !('result' in b), 'no detail fields without a detail object');
  const d = { pies: { r1: { label: 'Rush 1–5', player: 3, team: 5, seasonPlayer: 6, seasonTeam: 9 } }, last5: [{ week: 4, season: 2030, opp: 'MIA', carries: 12, rushYd: 50, targets: 2, rec: 1, recYd: 8, td: 1, secret: 'x' }], actual: { status: 'pending' } };
  const b2 = buildBrief(p, d, {}); assert.deepEqual(b2.yardLinePies.r1, { spot: 'Rush 1–5', playerLast3: 3, teamLast3: 5, playerSeason: 6, teamSeason: 9 });
  assert.ok(!('secret' in b2.recentGames[0])); assert.ok(!('result' in b2), 'pending result omitted');
  assert.match(SYSTEM_PROMPT, /Do not invent/);
});

test('built-in review is deterministic and used with no key or when the provider fails', async () => {
  const { p } = setup(); const b = buildBrief(p, null, { fair: '+150' });
  const a = builtinReview(b), a2 = builtinReview(b); assert.deepEqual(a, a2);
  assert.equal(a.label, 'Built-in review (no AI key)'); assert.ok(a.verdict && Array.isArray(a.caseFor) && a.risks.length);
  const none = await analyze(b, { key: '' }, { fetchFn: () => { throw new Error('must not call'); } }); assert.equal(none.source, 'builtin');
  const fail = await analyze(b, { provider: 'xai', key: KEY }, { fetchFn: async () => ({ ok: false, status: 401 }) });
  assert.equal(fail.source, 'builtin'); assert.match(fail.note, /AI call failed/); assert.ok(!JSON.stringify(fail).includes(KEY));
  const thrown = await analyze(b, { provider: 'xai', key: KEY }, { fetchFn: async () => { throw new Error(`bad ${KEY}`); } });
  assert.ok(!JSON.stringify(thrown).includes(KEY), 'key scrubbed from error notes');
});

test('AI path: request goes only to the configured provider with the key in the header, never in the body', async () => {
  const { p } = setup(); const b = buildBrief(p, null, {}); let call;
  const rv = await analyze(b, { provider: 'openai', baseUrl: 'https://example.test/v1/', model: 'm1', key: KEY }, { fetchFn: async (u, o) => { call = { u, o }; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"Lean yes","caseFor":["a"],"caseAgainst":["b"],"risks":["c"],"vsModel":"agrees"}' } }] }) }; } });
  assert.equal(call.u, 'https://example.test/v1/chat/completions'); assert.equal(call.o.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!call.o.body.includes(KEY)); assert.equal(rv.source, 'ai'); assert.equal(rv.verdict, 'Lean yes'); assert.ok(!JSON.stringify(rv).includes(KEY));
  assert.ok(!JSON.stringify(requestBody(b, 'm')).includes('key'));
  assert.throws(() => parseReply('no json'));
});

test('the review never changes model numbers, and no key or AI settings reach snapshots, builds or archives', async () => {
  const { res, G, p } = setup(); const before = JSON.stringify(G.sides.home.players);
  await analyze(buildBrief(p, null, {}), { key: '' }); assert.equal(JSON.stringify(G.sides.home.players), before);
  const snap = JSON.stringify(snapshotFromGame(G, { modelVersion: 'x', weights: {} })); assert.ok(!/endzone\.ai|apiKey|authorization/i.test(snap));
  const scan = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  for (const f of ['endzone-standalone.html']) { const t = scan(f); assert.ok(!/xai-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/.test(t), `${f} contains no API key`); }
  const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]) : [];
  for (const f of walk('archive').filter(f => f.endsWith('.json'))) assert.ok(!/endzone\.ai\.v1|apiKey|Bearer |xai-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/.test(scan(f)), `${f} has no AI settings`);
  void res;
});
