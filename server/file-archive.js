// Git-friendly JSON archive with the same interface as Archive (server/archive.js), used by the scheduled
// GitHub Actions job so the prospective record lives in the repo (archive/) and every device sees it.
// Deterministic output: rerunning with unchanged inputs rewrites identical bytes (idempotent commits).
//   archive/<season>/w<week>/<gameId>.json   { first, latest }  (frozen pregame snapshots, one file per game)
//   archive/<season>/outcomes-w<week>.json
//   archive/<season>/lessons.json   { <week>: lesson }  + lesson-history.json
//   archive/state.json              decisions, experiments (latest per kind), last change summary
//   archive/runs/last.json          last run log (excluded from the "anything changed?" commit test)
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint } from './archive.js';

export const stable = v => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
export const writeJson = (file, obj) => {
  const s = JSON.stringify(stable(obj), null, 1) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === s) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, s); fs.renameSync(tmp, file); return true;
};
export const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } };

export class FileArchive {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  static async open(dir) { return new FileArchive(dir); }
  wk(season, week) { return path.join(this.dir, String(season), `w${week}`); }
  gameFile(season, week, gameId) { return path.join(this.wk(season, week), `${gameId}.json`); }
  // Save ONLY strictly before kickoff. "first" is never replaced; "latest" is replaced only when the forecast content changes.
  saveSnapshot(snap, { now = new Date() } = {}) {
    const captured = new Date(now); if (!(captured < new Date(snap.kickoff))) return { saved: false, reason: 'at or after kickoff' };
    const f = this.gameFile(snap.season, snap.week, snap.gameId);
    const fp = fingerprint(stable({ ...snap, capturedAt: undefined, inputTimestamps: undefined, challenger: snap.challenger ? { ...snap.challenger, capturedCutoff: undefined } : null }));
    const rec = { capturedAt: captured.toISOString(), fingerprint: fp, payload: { ...snap, capturedAt: captured.toISOString() } };
    const g = readJson(f, {}); const first = !g.first;
    if (g.latest && Date.parse(g.latest.capturedAt) >= Date.parse(snap.kickoff)) return { saved: false, reason: 'frozen' };
    if (!first && g.latest?.fingerprint === fp) return { saved: false, reason: 'unchanged' };
    if (first) g.first = rec; g.latest = rec;
    writeJson(f, g); return { saved: true, first };
  }
  snapshots(season, week, kind = 'latest') {
    const dir = this.wk(season, week); if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort().map(x => readJson(path.join(dir, x), {})[kind]).filter(r => r && Date.parse(r.capturedAt) < Date.parse(r.payload.kickoff)).map(r => r.payload).sort((a, b) => a.gameId.localeCompare(b.gameId));
  }
  allSnapshots(kind = 'latest') { const out = []; for (const s of this.seasons()) for (const w of this.weeks(s)) out.push(...this.snapshots(s, w, kind)); return out; }
  seasons() { return fs.readdirSync(this.dir).filter(x => /^\d{4}$/.test(x)).map(Number).sort(); }
  weeks(season) { const p = path.join(this.dir, String(season)); return fs.existsSync(p) ? fs.readdirSync(p).map(x => /^w(\d+)$/.exec(x)).filter(Boolean).map(m => +m[1]).sort((a, b) => a - b) : []; }
  upsertOutcomes(list) {
    let inserted = 0, revised = 0, unchanged = 0; const byFile = new Map();
    for (const o of list) { const f = path.join(this.dir, String(o.season), `outcomes-w${o.week}.json`); if (!byFile.has(f)) byFile.set(f, readJson(f, {})); const d = byFile.get(f); const k = `${o.gameId}|${o.playerId}`; const fp = fingerprint(o.payload);
      if (!d[k]) { d[k] = { gameId: o.gameId, playerId: o.playerId, gsis: o.gsis || null, payload: o.payload, fingerprint: fp, version: 1, history: [] }; inserted++; }
      else if (d[k].fingerprint !== fp) { d[k].history.push({ version: d[k].version, fingerprint: d[k].fingerprint, payload: d[k].payload }); d[k].payload = o.payload; d[k].fingerprint = fp; d[k].version++; revised++; }
      else unchanged++; }
    for (const [f, d] of byFile) writeJson(f, d);
    return { inserted, revised, unchanged };
  }
  outcomes(season, week) { const out = []; for (const w of week ? [week] : this.weeks(season)) for (const o of Object.values(readJson(path.join(this.dir, String(season), `outcomes-w${w}.json`), {}))) out.push({ ...o, season, week: w }); return out; }
  saveLesson(season, week, lesson) {
    const f = path.join(this.dir, String(season), 'lessons.json'); const d = readJson(f, {}); const fp = fingerprint(lesson); const cur = d[week];
    if (cur && cur.fingerprint === fp) return 'unchanged';
    if (cur) { const hf = path.join(this.dir, String(season), 'lesson-history.json'); const h = readJson(hf, []); h.push({ week: +week, version: cur.version, fingerprint: cur.fingerprint, lesson: cur.lesson }); writeJson(hf, h); }
    d[week] = { lesson, fingerprint: fp, version: (cur?.version || 0) + 1 }; writeJson(f, d); return cur ? 'revised' : 'inserted';
  }
  lessons(season) { const d = readJson(path.join(this.dir, String(season), 'lessons.json'), {}); return Object.fromEntries(Object.entries(d).map(([w, v]) => [w, { ...v.lesson, version: v.version }])); }
  startRun(kind) { this.run = { kind, started_at: new Date().toISOString(), status: 'running' }; return 1; }
  finishRun(id, status, details) { this.run = { ...this.run, finished_at: new Date().toISOString(), status, details }; writeJson(path.join(this.dir, 'runs', 'last.json'), this.run); }
  lastRun() { return readJson(path.join(this.dir, 'runs', 'last.json'), null); }
  state() { return readJson(path.join(this.dir, 'state.json'), { experiments: {}, decisions: [], changes: [] }); }
  saveState(s) { return writeJson(path.join(this.dir, 'state.json'), s); }
  // Only the latest experiment per kind is kept; its timestamp is excluded so unchanged results do not churn.
  saveExperiment(e) { const s = this.state(); s.experiments[e.kind] = { season: e.season, week: e.week, modelVersion: e.modelVersion, trainingCutoff: e.trainingCutoff || null, payload: e.payload }; this.saveState(s); }
  latestExperiment(kind) { const e = this.state().experiments[kind]; return e ? { ...e } : null; }
}
