# ENDZONE — Anytime TD research model

Built fresh on 2026-10-15. Node 20 server, browser ES modules + a Web Worker for the UI, and SQLite storage (sql.js, written atomically to `data/endzone.sqlite`, versioned migrations in `server/archive.js`).

## Run
```
cd /workspace/endzone
npm install            # sql.js (+ playwright-core, dev only, for the UI test)
npm start              # PORT=8787 by default -> http://localhost:8787
npm test               # node:test: 18 acceptance items + CSV test + live-data browser test
npm run smoke          # real-data smoke test against live feeds -> SMOKE_RESULTS.json
```
Optional: set `ENDZONE_TOKEN=...` to require `Authorization: Bearer` (or `OAI-Sites-Authorization: Bearer`) on `/api/*`. The token lives only in server memory and is never logged or sent to the browser.

There is no background refresh schedule. The app loads once, then refreshes only when you press Refresh. The Lab tab has an auto-refresh option; it is off by default and states its interval. To archive pregame frames and grade results, run `POST /api/jobs/refresh` with body `{}` (or use the Lab button).

## API
- `GET /api/data?season=&week=&force=1` streams NDJSON stage events, then the prepared feed payload.
- `GET /api/feed?url=` relays only allowlisted sources (exact Sleeper and nflverse URL shapes).
- `POST /api/jobs/refresh` with `{}` refreshes feeds, saves frames for unplayed games (strictly pregame), reconciles outcomes, revises lessons, updates validation, and logs the run. It is idempotent: concurrent calls share one run.
- `GET /api/archive?season=&week=` returns snapshots, lessons, active calibration, uncertainty model, challenger status, research status, and the last run.

## Layout
- `server/`: `server.js` (routes), `live-feeds.js` (allowlist, retries, gzip detection, HTML rejection, streaming CSV), `feed-cache.js` (5-minute cache with stale recovery), `prepare.js` (projects feeds), `archive.js` (SQL + migrations), `jobs.js` (refresh job), `csv.js`
- `src/` (shared by the worker and the server):
  - `model.js`, `pipeline.js`, `engine.js`, `feeds.js`, `roster.js`, `stats-index.js`
  - `opportunity.js`, `spots.js`, `matchups.js`, `confidence.js`, `passing-touchdowns.js`, `ranking.js`
  - `forecast-details.js`, `advanced.js`, `player-research.js`
  - `evaluation.js`, `research.js` (lessons), `validation.js` (challenger and promotion gates), `grading.js`, `worker.js`
- `public/`: `index.html`, `styles.css`, `app.js`
- `tests/`: `acceptance.test.js`, `e2e-ui.test.js`, `smoke-live.mjs`, `fixture.js` (synthetic data, tests only), `helpers.js`

## Standalone single file (no server)
`endzone-standalone.html` is one self-contained file you can open on a phone or laptop.
- Sleeper and the nflverse schedule are fetched live in the browser.
- nflverse GitHub release files are blocked by browser CORS. The file uses the real rows captured at build time and labels them stale in Lab → Sources.
- Settings live in localStorage; pregame frames live in IndexedDB.
- Rebuild with fresh nflverse rows: `npm run bundle:nflverse && npm run build:standalone`.

## Optional: protect only the refresh job
`ENDZONE_WRITE_TOKEN=... npm start` keeps reads public and requires `Authorization: Bearer <token>` for POST /api/jobs/refresh. `ENDZONE_TOKEN` still protects every /api route.

## Deploy (Docker / Render)
- `docker build -t endzone . && docker run -p 8787:8787 -v endzone-data:/data endzone`
- Render: push this repo and create a Blueprint from `render.yaml`. It uses a paid instance with a 1 GB disk at /data.
- Storage: `ENDZONE_DATA_DIR` (directory) or `ENDZONE_DB` (file).
- Tokens: optional `ENDZONE_TOKEN` (private site) and `ENDZONE_WRITE_TOKEN` (protects the refresh job only).

## Scripts
- `npm run blend-folds`: held-out fold validation of the adaptive published blend. Writes data/blend-folds.json.
- `npm run watch-alerts [-- --watch=id1,id2 --min=0.35]`: JSON status changes against the latest pregame snapshot. Read-only.
