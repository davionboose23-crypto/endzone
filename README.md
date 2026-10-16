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

## endzone-4.2.0 — held-out calibration (walk-forward)

All numbers are from point-in-time reconstructions (nflverse weekly rosters, no Sleeper injuries/depth), walk-forward: each week is forecast using fits trained only on earlier weeks and seasons, with whole games kept together. Intervals are 95% game-level paired bootstrap (B=1000). Rows are only players with a published (Sleeper) projection.

| Held-out set | n | 4.1 Brier / LL | 4.2 Brier / LL | Published Brier / LL | 4.2 − 4.1 ΔBrier [CI] | ΔLL [CI] |
|---|---|---|---|---|---|---|
| 2025 wk1–18 | 5950 | .1316 / .4160 | .1312 / .4149 | .1313 / .4168 | −.0004 [−.0006, −.0001] | −.0011 [−.0018, −.0003] |
| 2026 wk1–5 | 1779 | .1304 / .4218 | .1301 / .4209 | .1296 / .4188 | −.0003 [−.0007, .0000] | −.0009 [−.0020, .0001] |

Adopted: team TD budget = a + b·implied points (least squares on earlier team-games, b ≈ .15/pt) instead of the spec's implied×0.7/6.9, which ran ~0.15 TD/team-game low (≈0.4 low for 25+ implied). This is a user-approved deviation from the spec budget formula. Safety caps unchanged.
Rejected: stacked logistic calibration on [model, published, role features] — no significant Brier gain over the budget fix in either season.
Volume: 80% bands recalibrated per metric × tier (mean ≥ 25 yds / 2 rec / 150 pass yds) on held-out errors. Meaningful-tier coverage moved from 73–79% (pass yds 87–92%) to 75–82%; MAE essentially unchanged. Applies only when the in-app held-out error model is not yet available.
vs published: 2025 the model ties published on Brier and is better on log loss (not significant); 2026 wk1–5 published is still slightly better (not significant). The model does not measurably beat Sleeper.
Reproduce: `node scripts/hist/build.mjs raw <season> '{"pubTdBlend":0}'`, `node scripts/hist/walk.mjs <season> budget '{"stack":false,"budget":true}'`, `node scripts/hist/brief.mjs base budget`, `node scripts/hist/volcal.mjs budget`, `node scripts/hist/ship-fits.mjs`.

## endzone-4.2.1 — candidate round (nothing new adopted)

Same harness (walk-forward, budget fit on, game bootstrap). Each knob's value was picked by log loss on earlier seasons only (2024 → tested on 2025; 2024+2025 → tested on 2026), then compared with 4.2.0. No candidate improved both Brier and log loss with intervals excluding zero on both held-out sets, so 4.2.1 forecasts are identical to 4.2.0; the knobs ship off (`exp` engine option) for future testing.
- Goal-line recency (inside-10 rush share weight), snap-informed goal-line prior, TE red-zone target prior, league conversion prior strength, spot shrinkage strength, defense trust (0–1.25), volume recency (0.25–0.7): all |ΔBrier| ≤ .0001–.0003, intervals include 0 on at least one held-out set. Defense trust .75 was closest (2025 ΔLL −.0003 [−.0006, .0000]; 2026 n.s.).
- QB rushing multiplier: no value beat baseline on earlier seasons.
- Combined (picked on earlier seasons): 2025 ΔBrier .0000 [−.0002, .0002]; 2026 −.0001 [−.0004, .0000], ΔLL −.0003 [−.0009, .0002]. Rejected.
- Safety caps (counterfactual only, not shipped): capped rows are ~9% of rows but half of the 25%+ bin. They are forecast at .37–.39 vs a .43–.46 hit rate (before caps: .47–.48; uncapped engine after team budget: .42–.44). Removing caps: 2026 ΔBrier −.0013 [−.0024, −.0003], ΔLL −.0026 [−.0050, −.0001]; 2025 and 2024 not significant. Caps are a spec invariant and stay; flagged for the user.
- Inactive (INA) players: only 27 rows over three seasons, none with a published projection, so the matched comparisons are identical with them dropped. Players with no stat or snap record are already excluded from grading.
Reproduce: `node scripts/hist/grid.mjs`, `node scripts/hist/select.mjs '<families>'`, `node scripts/hist/diff.mjs <tag> <season>`.

## endzone-4.2.2 — data-fit safety caps (user-approved override of spec §11; evaluated, left OFF)

The user approved replacing the fixed §11 cap values with values fit from past data. Implemented: `safetyCalibrate(p, ctx, caps)` keeps the same structure (role gating, cold-goal logic, applied after lessons/calibration, then team budget) with fittable values `pullT/pullS` (35–50% no-inside-10 pull), `ceil` (non-finisher ceiling, spec 50%), `cold` (cold-goal ceiling, 46%), `fin` (finisher ceiling, 62%), `floor` (second-option floor, 16%). Bounds: pull target .20–.45, ceilings ≤ .75, cold ≤ ceil ≤ fin, floor .10–.22. `fitCaps` (src/calibration.js) chooses values by log loss on earlier rows and shrinks each toward the fixed value by n/(n+K); K=100 was chosen on inner splits of earlier data only.

Walk-forward result (fit on 2024 → test 2025; fit on 2024–25 → test 2026), vs 4.2.1 (fixed caps):
| Held-out | ΔBrier [95% game CI] | ΔLogLoss | Team calls ΔBrier | Contributors ΔBrier |
|---|---|---|---|---|
| 2025 (K=100) | −.0002 [−.0005, .0002] | −.0003 [−.0011, .0005] | −.0012 [−.0038, .0012] | −.0003 [−.0008, .0003] |
| 2026 wk1–5 (K=100) | −.0009 [−.0016, −.0001] | −.0017 [−.0035, .0003] | −.0012 [−.0062, .0038] | −.0015 [−.0028, −.0002] |
Point estimates improve everywhere and nothing regresses, but log loss is not significant on either set and Brier only on 2026, so by the adoption rule the fitted caps are not shipped: production uses the fixed spec values (no `caps` entry in calibration-fits.json). Fitted values, 2024–25 data: pull target .41 (slope .22), ceiling .55, cold .50, finisher .60, floor .14.

## endzone-4.3.0 — results vs predicted, shared scheduled archive, auto-calibration gate

User-approved override of spec §23 (no background schedule): `.github/workflows/auto.yml` runs on a schedule (UTC, every 30 min Thu 23:00–05:30, Sun 16:00–05:30, Mon 23:00–05:30, plus Tue 12:00) and on manual dispatch. Each run, using only `GITHUB_TOKEN`:
1. `scripts/auto-run.mjs` — prepares live data, captures pregame snapshots for unplayed games of the current and next week strictly before kickoff (first kept forever; latest replaced only when the forecast content changes and never after kickoff), reconciles final results with revision history, grades, recomputes lessons (last-3-weeks rule, in-week (scale+2)/3 nudge for later games) and validation/challenger, and records what changed (`archive/state.json`).
2. Tuesday 12:00 (or dispatch with `gate`): `scripts/gate.mjs` re-runs the walk-forward evaluation of data-fit caps on the current season (caps fit only on earlier seasons + earlier weeks) and enables them only if Brier AND log loss improve with game-bootstrap 95% intervals below zero and team calls/contributors don't regress; the challenger is enabled only if the prospective promotion rule passes. It also refreshes the team-budget and volume-band fits for the next week. Decisions and reasons are logged and shown in the Lab.
3. Commits `archive/` (and `src/calibration-fits.json`) only when something other than the run log changed; then rebuilds and redeploys Pages. One concurrency group (`endzone-archive-pages`) serializes this job and `pages.yml`.

The Pages app loads `archive/<season>/w<week>.json`, so every device sees the same frozen predictions, grades, lessons and decisions (this browser's IndexedDB frames only fill gaps; the file:// copy has no shared archive). Finished games show **Results vs predicted** (frozen pregame anytime % vs TD, yardage vs prediction and 80% range, QB passing yards/TDs inline, per-game expected vs actual TDs, team calls, Brier) with Prospective/Reconstructed labels, and the Slate has a **Results** week view.
Limits: GitHub can delay or skip scheduled runs under load (snapshots are captured up to ~30 min before kickoff at best; London/early games before 16:00 UTC Sunday rely on earlier runs); public-repo Actions minutes are free; archive files are large (~250 KB per game snapshot) so the repo grows over the season.
