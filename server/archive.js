// Durable SQL archive (SQLite via sql.js, persisted atomically to disk) with
// versioned migrations: frozen pregame snapshots, outcomes with fingerprints and
// history, lessons with version history, refresh runs, and experiments.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import initSqlJs from 'sql.js';

export const MIGRATIONS = [
  { version: 1, name: 'initial schema', sql: `
    CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, season INTEGER NOT NULL, week INTEGER NOT NULL, game_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('first','latest')),
      captured_at TEXT NOT NULL, kickoff TEXT NOT NULL, model_version TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(game_id, kind));
    CREATE TABLE IF NOT EXISTS outcomes (season INTEGER NOT NULL, week INTEGER NOT NULL, game_id TEXT NOT NULL, player_id TEXT NOT NULL, gsis TEXT, status TEXT NOT NULL,
      payload TEXT NOT NULL, fingerprint TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(game_id, player_id));
    CREATE TABLE IF NOT EXISTS outcome_history (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT, player_id TEXT, version INTEGER, payload TEXT, fingerprint TEXT, replaced_at TEXT);
    CREATE TABLE IF NOT EXISTS lessons (season INTEGER NOT NULL, week INTEGER NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      prospective_n INTEGER NOT NULL DEFAULT 0, reconstructed_n INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(season, week));
    CREATE TABLE IF NOT EXISTS lesson_history (id INTEGER PRIMARY KEY AUTOINCREMENT, season INTEGER, week INTEGER, version INTEGER, payload TEXT, fingerprint TEXT, replaced_at TEXT);
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, details TEXT);
    CREATE TABLE IF NOT EXISTS experiments (id INTEGER PRIMARY KEY AUTOINCREMENT, season INTEGER, week INTEGER, kind TEXT NOT NULL, model_version TEXT, training_cutoff TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);` },
  { version: 2, name: 'indexes', sql: `
    CREATE INDEX IF NOT EXISTS idx_snap_week ON snapshots(season, week);
    CREATE INDEX IF NOT EXISTS idx_out_week ON outcomes(season, week);
    CREATE INDEX IF NOT EXISTS idx_exp_kind ON experiments(kind, season, week);` },
];
export const fingerprint = obj => crypto.createHash('sha256').update(typeof obj === 'string' ? obj : JSON.stringify(obj)).digest('hex').slice(0, 24);

export class Archive {
  static async open(file) {
    const SQL = await initSqlJs();
    const a = new Archive(); a.file = file;
    a.db = file && fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
    a.migrate(); return a;
  }
  migrate() {
    this.db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
    const have = new Set(this.all('SELECT version FROM schema_migrations').map(r => r.version));
    for (const m of MIGRATIONS) if (!have.has(m.version)) {
      this.db.run('BEGIN'); try { this.db.run(m.sql); this.db.run('INSERT INTO schema_migrations VALUES (?,?,?)', [m.version, m.name, new Date().toISOString()]); this.db.run('COMMIT'); } catch (e) { this.db.run('ROLLBACK'); throw e; }
    }
    this.persist();
  }
  schemaVersion() { return this.get('SELECT MAX(version) v FROM schema_migrations').v; }
  all(sql, params = []) { const st = this.db.prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
  get(sql, params = []) { return this.all(sql, params)[0] || null; }
  run(sql, params = []) { this.db.run(sql, params); }
  tx(fn) { this.db.run('BEGIN'); try { const r = fn(); this.db.run('COMMIT'); this.persist(); return r; } catch (e) { this.db.run('ROLLBACK'); throw e; } }
  persist() { if (!this.file) return; const tmp = `${this.file}.tmp`; fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(tmp, Buffer.from(this.db.export())); fs.renameSync(tmp, this.file); }

  // Save a pregame frame ONLY when captured strictly before kickoff. First capture is retained; latest replaced.
  saveSnapshot(snap, { now = new Date() } = {}) {
    const captured = new Date(now); const kick = new Date(snap.kickoff);
    if (!(captured < kick)) return { saved: false, reason: 'at or after kickoff' };
    const payload = JSON.stringify({ ...snap, capturedAt: captured.toISOString() }); const fp = fingerprint({ ...snap, capturedAt: undefined });
    return this.tx(() => {
      const first = this.get('SELECT id FROM snapshots WHERE game_id=? AND kind=?', [snap.gameId, 'first']);
      if (!first) this.run('INSERT INTO snapshots (season,week,game_id,kind,captured_at,kickoff,model_version,fingerprint,payload) VALUES (?,?,?,?,?,?,?,?,?)', [snap.season, snap.week, snap.gameId, 'first', captured.toISOString(), snap.kickoff, snap.modelVersion, fp, payload]);
      this.run(`INSERT INTO snapshots (season,week,game_id,kind,captured_at,kickoff,model_version,fingerprint,payload) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(game_id,kind) DO UPDATE SET captured_at=excluded.captured_at, model_version=excluded.model_version, fingerprint=excluded.fingerprint, payload=excluded.payload WHERE excluded.captured_at < snapshots.kickoff`,
      [snap.season, snap.week, snap.gameId, 'latest', captured.toISOString(), snap.kickoff, snap.modelVersion, fp, payload]);
      return { saved: true, first: !first };
    });
  }
  // Read only frames captured strictly before kickoff.
  snapshots(season, week, kind = 'latest') {
    return this.all('SELECT payload FROM snapshots WHERE season=? AND week=? AND kind=? AND captured_at < kickoff', [season, week, kind]).map(r => JSON.parse(r.payload));
  }
  allSnapshots(kind = 'latest') { return this.all('SELECT payload FROM snapshots WHERE kind=? AND captured_at < kickoff', [kind]).map(r => JSON.parse(r.payload)); }
  upsertOutcomes(list) {
    let inserted = 0, revised = 0, unchanged = 0; const now = new Date().toISOString();
    for (let i = 0; i < list.length; i += 200) { // chunk large writes
      const chunk = list.slice(i, i + 200);
      this.tx(() => { for (const o of chunk) {
        const fp = fingerprint(o.payload); const cur = this.get('SELECT fingerprint, version, payload FROM outcomes WHERE game_id=? AND player_id=?', [o.gameId, o.playerId]);
        if (!cur) { this.run('INSERT INTO outcomes VALUES (?,?,?,?,?,?,?,?,1,?)', [o.season, o.week, o.gameId, o.playerId, o.gsis || null, o.payload.status, JSON.stringify(o.payload), fp, now]); inserted++; }
        else if (cur.fingerprint !== fp) { this.run('INSERT INTO outcome_history (game_id,player_id,version,payload,fingerprint,replaced_at) VALUES (?,?,?,?,?,?)', [o.gameId, o.playerId, cur.version, cur.payload, cur.fingerprint, now]); this.run('UPDATE outcomes SET status=?, payload=?, fingerprint=?, version=version+1, updated_at=? WHERE game_id=? AND player_id=?', [o.payload.status, JSON.stringify(o.payload), fp, now, o.gameId, o.playerId]); revised++; }
        else unchanged++;
      } });
    }
    return { inserted, revised, unchanged };
  }
  outcomes(season, week) { return this.all('SELECT * FROM outcomes WHERE season=? AND (? IS NULL OR week=?)', [season, week ?? null, week ?? null]).map(r => ({ ...r, payload: JSON.parse(r.payload) })); }
  saveLesson(season, week, lesson) {
    const fp = fingerprint(lesson); const now = new Date().toISOString();
    return this.tx(() => {
      const cur = this.get('SELECT * FROM lessons WHERE season=? AND week=?', [season, week]);
      if (!cur) { this.run('INSERT INTO lessons VALUES (?,?,?,?,1,?,?,?)', [season, week, JSON.stringify(lesson), fp, lesson.prospective || 0, lesson.reconstructed || 0, now]); return 'inserted'; }
      if (cur.fingerprint === fp) return 'unchanged';
      this.run('INSERT INTO lesson_history (season,week,version,payload,fingerprint,replaced_at) VALUES (?,?,?,?,?,?)', [season, week, cur.version, cur.payload, cur.fingerprint, now]);
      this.run('UPDATE lessons SET payload=?, fingerprint=?, version=version+1, prospective_n=?, reconstructed_n=?, updated_at=? WHERE season=? AND week=?', [JSON.stringify(lesson), fp, lesson.prospective || 0, lesson.reconstructed || 0, now, season, week]);
      return 'revised';
    });
  }
  lessons(season) { const o = {}; for (const r of this.all('SELECT * FROM lessons WHERE season=?', [season])) o[r.week] = { ...JSON.parse(r.payload), version: r.version }; return o; }
  startRun(kind) { return this.tx(() => { this.run('INSERT INTO runs (kind, started_at, status) VALUES (?,?,?)', [kind, new Date().toISOString(), 'running']); return this.get('SELECT last_insert_rowid() id').id; }); }
  finishRun(id, status, details) { this.tx(() => this.run('UPDATE runs SET finished_at=?, status=?, details=? WHERE id=?', [new Date().toISOString(), status, JSON.stringify(details), id])); }
  // usage tables live in the repo archive (scripts/usage/build.mjs), not in SQLite
  simPriors(season) { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'archive', 'sim', `sim-priors-${season}.json`), 'utf8')); } catch { return null; } }
  simTop4(season) { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'archive', 'sim', `top4-backtest-${season}.json`), 'utf8')); } catch { return null; } }
  drives(season, week) { try { return JSON.parse(fs.readFileSync(path.join(process.env.ENDZONE_DRIVES_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'archive', 'drives'), String(season), `w${week}.json`), 'utf8')); } catch { return null; } }
  pbp(season, week) { try { return JSON.parse(fs.readFileSync(path.join(process.env.ENDZONE_PBP_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'archive', 'pbp'), String(season), `w${week}.json`), 'utf8')); } catch { return null; } }
  usage(season, week) { try { return JSON.parse(fs.readFileSync(path.join(process.env.ENDZONE_USAGE_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'archive', 'usage'), String(season), `w${week}.json`), 'utf8')); } catch { return null; } }
  lastRun() { const r = this.get('SELECT * FROM runs ORDER BY id DESC LIMIT 1'); return r ? { ...r, details: r.details ? JSON.parse(r.details) : null } : null; }
  saveExperiment(e) { this.tx(() => this.run('INSERT INTO experiments (season,week,kind,model_version,training_cutoff,payload,created_at) VALUES (?,?,?,?,?,?,?)', [e.season, e.week, e.kind, e.modelVersion, e.trainingCutoff || null, JSON.stringify(e.payload), new Date().toISOString()])); }
  latestExperiment(kind, season, week) { const r = this.get('SELECT * FROM experiments WHERE kind=? AND season=? AND (? IS NULL OR week=?) ORDER BY id DESC LIMIT 1', [kind, season, week ?? null, week ?? null]); return r ? { ...r, payload: JSON.parse(r.payload) } : null; }
}
