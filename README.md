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

## endzone-4.4.0 — Trends agent (seen, and wired into predictions)
- `src/trends.js` detects trends from information before the forecast week only: snap share, touch share (carries+targets), red-zone looks, QB rushing, scoring streaks across separate games, defenses trending soft/tight vs RB/WR/TE (last 3 vs earlier), team volume, role vacuums, and model miss patterns from graded results. Each trend has type, entity, evidence with sample sizes, strength, status (new / continuing / faded) and first-detected week. Status is recomputed from strictly earlier data (the same detector on the logs before each earlier game), so it is reproducible without stored state.
- Effects: bounded, shrunk multipliers (×0.85–1.15 per trend, ×0.80–1.25 per player) on opportunity shares, spot conversion and the defense factor, applied before the safety caps and the team TD budget. Snapshots store `trendTags` and `trendEffect` (before → after, ±pp per trend).
- Validation (scripts/hist grid, walk-forward 2024–25, held-out 2026 wk1–5, game bootstrap): no family met the enable rule, so all weights are 0 and every trend is shown as "tracking, not yet proven" with ±0.0 pp. Table in `src/trend-weights.json` and in the Lab.
- Tuesday gate (`scripts/trend-gate.mjs`, called by `scripts/gate.mjs`): re-evaluates every family on the current season walk-forward. Each week's weight is chosen only from the 2024–25 training table plus earlier current-season weeks (never the test week). A family turns on for the next week only if it isn't harmful beyond noise, improves Brier or log loss, and team calls and contributors don't regress (≥40 games). The weight is written per week into `src/calibration-fits.json`, so there's no leakage in reconstructions.
- UI: Trends tab (cards, evidence, affected players with ±pp, filters by type / team / status), trend tags on player rows, "Trends that moved his chance" in the player panel, trend validation and gate status in the Lab.

## endzone-4.5.0 — UX cleanup and AI analysis agent
- Cleanup (audited with headless screenshots at 390 px and 1280 px, `node scripts/ux-shots.mjs <dir>`):
  - spacing and type scale tokens;
  - two-row mobile header (Focus/Refresh top-right, season ‹ week › on one line);
  - Focus view rows show only the name, chance, one TD-confidence chip and the primary yardage number;
  - the player panel opens with a summary (chance, fair price, edge, TD confidence, main yardage line, one-sentence why), and everything else is in collapsible sections;
  - the Lab is grouped into Weights, Results & calibration, Learning, Trends, Model gates, AI analyst and Sources, with a jump bar;
  - compact trend cards (evidence in a disclosure);
  - debug-ish text removed (raw cutoff JSON, retained-default notes);
  - dead code and unused scratch scripts removed;
  - `npm run lint` (syntax check plus unused-definition check).
- AI analysis (`src/analyst.js`): every player panel has an **AI analysis** button.
  - **Brief:** a compact JSON brief built only from fields the model produced (chance, band, components, yard-line pies, volume, confidence reasons, matchup, trends, recent/H2H logs, availability, result, model-miss trends).
  - **AI review:** with a key (Lab → AI analyst: xAI Grok or any OpenAI-compatible endpoint, with configurable base URL and model), the browser sends the brief directly to the provider. The prompt forbids inventing stats beyond the brief, and the reply is a verdict, case for, case against, key risks and a comparison with the model's number.
  - **Key storage:** the key lives only in this device's localStorage and is never sent to ENDZONE, the repo, snapshots or logs.
  - **Built-in review:** without a key, or if the call fails, a deterministic rule-based review labeled "Built-in review (no AI key)" is shown.
  - **Caching:** reviews are cached per player per snapshot and never change the model's numbers.

## endzone-4.6.0 — 3-way blend challenger, nflverse usage leg, slice monitoring

**Challenger (shadow).** Each player gets a blended number: the equal-weight mean, on the cloglog (log-intensity) scale, of
(1) the model's final chance *after* the safety caps, (2) Sleeper's published probability, (3) the new usage leg.
Fallbacks: no usage row → 50/50 model + Sleeper; no Sleeper number → model + usage (or the model alone). Hard ceiling .62; no
team-budget re-scaling. The board (under Anytime), the mobile cards and the player panel (Probability details) show the blended
number and which legs went in. The headline number stays the model's: the blend goes through the existing prospective gate
(≥500 paired players / ≥40 games, Brier CI, log loss, ECE, protected cohorts) and is **not** promoted.

**Usage leg.** `scripts/usage/build.mjs` (npm run usage:build) fits a ridge cloglog model of P(≥1 TD) on nflverse pre-game usage
only — trailing snap share, targets/carries, red-zone/end-zone/inside-10 looks, QB designed runs and sneaks, defense vs position,
plus the game's implied total/spread/home (applied engine-side from frozen lines). Training rows are player-games strictly
before the target week (seasons S−2..S); no in-game data, no post-forecast inactives or weather, and never our model's output.
Output: `archive/usage/<season>/w<week>.json` (base η per gsis id, line coefficients, Sleeper→gsis map), which the server,
the auto-run, and the Pages export (`/api/archive` body `usage`) load. auto.yml runs it as a free step ("Usage model leg",
continue-on-error) before the archive run: full rebuild on the Tuesday schedule and on manual dispatch, `--if-missing` otherwise.

**Walk-forward verification** (`npm run usage:verify`; 2025 + 2026 w1–5 replay + w6 prospective, n 8023 players / 364 games,
×1000, 95% game-bootstrap): 3-way vs model Brier −1.03 [−1.75, −0.41], log loss −3.31 [−5.21, −1.37]; vs Sleeper −1.07 / −4.46;
2-way (model+Sleeper) vs model −0.89 / −1.98; usage leg alone vs model +1.85 / +7.06 (worse alone, useful in the blend).
The .62 ceiling costs +0.02 (n.s.). Baseline saved to `src/blend-baseline.json`.

**pubBlend kept.** Blending with the pubBlend-pulled model vs a no-pull model: Brier −0.85 [−1.34, −0.42], log loss −2.74
[−4.58, −1.06] in favour of keeping pubBlend, so the engine needs no second pass.

**MODEL_VERSION → endzone-4.6.0.** The challenger gate counts prospective pairs for the current version only; 4.5.2 snapshots
carry the retired logistic challenger, so bumping the version makes the gate count from this week's 4.6.0 snapshots. As a second
check the gate also filters on `challengerKind === 'blend3'`. The fitted-caps gate is walk-forward (not version-keyed), so it is
unaffected and the fitted caps stay off until it passes.

**Monitoring.** Lab → Results & calibration → "Blend challenger vs model vs Sleeper": model, blend and Sleeper on all players,
implied team total 27.5+, favored by 7+, goal-line share 15–35%, TE1s and running QBs (3.5+ projected carries), with paired
blend-minus deltas and game-bootstrap intervals. "Live" = prospective 4.6.0 snapshots (what the gate counts); a second table adds
earlier frozen weeks scored with a walk-forward backfilled blend; the walk-forward baseline is in a collapsible. Updated by each
auto run. The TE gap is flagged when the blended TE1 forecast is still ≥2 pts under the actual TE1 rate and has not closed at least
half of the model's gap — the baseline flags it (blend −3.58 pts, model −4.40, Sleeper −2.31, n 682).

## endzone-4.5.2 — sort the board by model confidence

Board → Sort now has three groups. **Touchdown**: *Model confidence (High › Med › Low)* orders by TD confidence, ties by chance (the default still only lifts High names). **Other stats by model confidence**: *Rush yards / Receiving yards / Receptions / QB pass yards — confidence* order by the model's own confidence for that projection (`volConf`), ties by the projected mean; players without that projection go last. The choice persists like the other board settings, and in the phone focus list the last column switches to the sorted stat with its confidence chip. QB passing stays inline under QB names (no new columns).

## endzone-4.5.1 — phone and tablet landscape
- Short landscape (`(orientation: landscape) and (max-height: 500px)`, e.g. 844×390, 932×430, 740×360, 667×375):
  - **Header and tabs:** one-row, non-sticky header (about 53 px instead of 94–146 px); status line hidden; compact tabs that still meet 44 px.
  - **Standalone notice:** collapses to one line (tap to expand).
  - **Player sheet:** two columns. Name, Close and summary on the left (sticky, scrolls on its own); disclosures on the right.
  - **Tables:** landscape phones get the full table (inside its own sideways scroller) instead of the portrait card list. Focus defaults on only for portrait phones.
- Safe areas: `viewport-fit=cover` plus `env(safe-area-inset-*)` padding on header, tabs, main, footer and panel. No web manifest exists, so there is no orientation lock.
- Rotation re-renders in place on breakpoint changes (no reload), keeping the selected game, open player, panel scroll, filters and page scroll.
- `tests/landscape.test.js` covers five landscape sizes: header under 25% of the height, no page-level horizontal overflow, panel scrollable, Close visible and at least 44 px, plus a rotation round-trip.
- Screenshots: `SIZES=844x390,932x430 MOBILE=1 node scripts/ux-shots.mjs <dir> [url]` (`shots/` is git-ignored).

## App 4.9.1 — Simulator: Drive 1 card and touchdown-scorer patterns (research / UI only, model stays endzone-4.6.0)
- **Drive 1 card** (per team, plain sentences first): how the opening drive ends (TD / FG / missed FG / punt / turnover / downs / end of half as a stacked bar + %), average plays and yards, P(team scores first), the opening-kickoff coin flip (the other team gets the ball to start the 2nd half) and TD rate when receiving vs kicking. Per player: P(≥1 catch), P(2+ catches), P(10+ rec yds), P(a carry), P(10+ rush yds), median catches / yards *when he gets it*, and P(he scores this drive's TD); top scorers and "if X scores here" links. A drive selector (1 by default, then 2, 3 …) re-reads the same 10,000 games for later drives. Note: drive rates mostly reflect volume and game state.
- **Touchdown scorer patterns**: ranked key patterns at the top; first TD scorer of the game and each team's first TD; anytime / 2+ / 3+; when TDs come (1st half, the team's drives 1–3) and rushing vs receiving split; ranked conditional links — scorer pairs, opening-drive TD → a player's anytime TD, scorer → win and total, both-score combos — labeled as **sim structure** (one scorer per TD drive, higher-scoring games lift both sides), not real-life correlations.
- Engine: `simulate()` now also records the opening-kickoff receiver, each drive's result per game, each team's first TD scorer, plays/yards per drive slot and per-player TD type/quarter counts; no extra random draws, so seeds reproduce the same games as 4.9.0. New `driveCard()` / `tdPatterns()` in `src/sim.js`.
- **Test fix**: `tests/sim.test.js` rebuilt its inputs from `archive/2026/w8/*.json` + `archive/drives/2026/w8.json`, which the scheduled data refresh rewrites, so its calibration tolerances depended on whichever refresh last ran (e.g. the 2026-10-27T09:59Z snapshot of the same game fails the team-TD-vs-λ check at 2.50 vs 2.37). The tolerances now run on a frozen fixture (`tests/fixtures/sim-inputs-2026w8-CAR-GB.json`); the live archive is only smoke-tested. The seed test compares a whole-run fingerprint instead of the 5 most common scores. 3 new tests (drive card, TD patterns, archive smoke).

## App 4.9.0 — Game simulator (Drives → Simulator; research / UI only, model stays endzone-4.6.0)
- Drives → **Simulator** plays this week's game (or any two teams) 10,000 times drive by drive in a Web Worker (`src/sim.js`, `src/sim-worker.js`): possession alternation, score, quarter and clock, two-minute drives, overtime; every drive ends TD / FG / missed FG / punt / turnover / downs / end of half, with plays, targets, carries, catches, yards and the scorer.
- Inputs are pre-game only: the model's per-player λ, projected targets/carries/catches/yards with lead/behind scenarios, the team TD budgets, real 2026 drive-result mixes by game state for each offense and defense (weekly drive file), and validated drive patterns (strong ×1, moderate ×½, clamped 0.4–2.5) as touch-share multipliers. Three 1,200-game pilots calibrate team TDs to λ, touches/pass split/volume to the projections and drive pace to history.
- Shows win %, score/total/margin distributions, most common finals, per-player anytime / 2+ TD / receptions / yards (median, 80% range, thresholds with presets + custom), drive-by-drive patterns, first TD scorer, scoring by drive number, correlations (player → player, player → total/win) and game scripts; tapping a player opens his per-drive table.
- **Not wired into predictions and not a shadow challenger**: the sim is calibrated to the model's own λ, so its anytime TD equals the model's by construction — scoring it against the model would be circular. No MODEL_VERSION bump; the challenger gate is untouched.
- Calibration (`npm run sim:calibrate` → `archive/sim/calibration-2026.json`, 43 archived snapshots, 10k sims each): anytime |sim − model| mean 0.5pp, max 3.1pp (809 players ≥5%); team TDs / λ 1.003 (0.96–1.04); volume means within 1.2–1.9%; drives/team 10.85 (history 10.78); points/team 22.3 (history 23.0); within-game SD total 12.4 / margin 12.9 (history vs-line residual 13.1 / 12.2); sim totals average 1.2 below the betting total.

## App 4.8.1 — Drive log and player-by-drive table (display only; model stays endzone-4.6.0)

- **Drive log** (Drives → Team, and each team in Matchup): pick a game; every drive shows drive #, quarter, start yard line, plays, result, and one line per player who got the ball, e.g. `St. Brown 2 rec (3 tgt), 24 yds · Gibbs 3 car, 18 yds, TD`. QB pass stats are never listed as columns. Cards in portrait, a table in landscape.
- **Player by drive**: choose a player from the dropdown or tap a name in the log. Rows are games in the window (last 3 / last 6 / season); columns are drives 1…N; cells read `2 rec / 24 yds` or `3 car / 18 yds`. Stat toggle: Receptions, Rec yds, Carries, Rush yds, Touches. Threshold presets (1+ rec, 2+ rec, 20+ rec yds, 10+ rush yds, 20+ rush yds) or a custom value; cells that meet it are highlighted.
- **By drive number**: hit rate per drive ("Drive 3: 1+ rec in 4 of 6 games"), average yards, and a reliability label from the existing drive-number tests: "pattern" only if it survives BH q ≤ 0.10 and out-of-sample persistence, otherwise "small sample / likely chance". An "Any drive" row gives the baseline.
- Data: the team drive tuple now also carries quarter and start yard line (`scripts/drives/profile.mjs`); week files are pre-game only, as before.

## App 4.8.0 — Drives section and drive-pattern adjustment (challenger; model stays endzone-4.6.0)

- **Drives tab** (top level, between Trends and Lab; the Trends block links to it). Picker: *Team* (any of 32) or *Matchup* (this week's games, or "Any two teams"); window Last 3 / Last 6 / Season. The choice is saved on the device (`localStorage endzone.drives.v1`).
- **Team view:** drive-by-drive grid (team or per-player; targets/carries per drive, gold = TD, outlined = reached red zone; tap a cell for the drive), tendencies by phase (opening script, red zone, goal to go, leading, trailing, two-minute: plays/drive, run/pass, TD rate, who gets the ball), player patterns with n and reliability.
- **Matchup view:** both offenses side by side, each defense's allowed drive profile (red-zone trips/drive, TDs/drive, TDs per red-zone trip and goal-to-go drive, rank, BH-tested against the league; which positions score red-zone / goal-to-go TDs against them), and **What the model sees** in plain words. Only findings that pass BH q ≤ .10 and hold up out of sample are called *patterns*; q ≤ .20 items are *worth watching* and never move a number.
- **Adjustment** (`src/drive-adjust.js`): per player, raw = Σ reliability-weight × log(lift) × TD-share × this-week context (spread → P(leading), opponent's allowed drive profile, expected drives); log-multiplier = clamp(w × raw, ±log 1.1), applied to λ before the safety caps. A note on every player shows the full-weight signal and what is applied now.
- **Weight fitted walk-forward** (`scripts/drives/adjust-fit.mjs`, `archive/drives/fit.json`; 7,559 player-games / 345 games, 788 with patterns). ΔBrier ×1e-3 (with − without, lower is better): blend+drives vs blend +0.025 [−0.071, 0.120]; model+drives vs model +0.032 [−0.028, 0.099]; Δlog loss +0.094 / +0.106 (CIs span 0). Fitted weight **0 / 0** → moves numbers by 0 today.
- **Challenger** `blend3+drives` is snapshotted every run and gated by the same prospective promotion rules (`drivesPromotion` in the Lab); `components.drives` is enabled by gate.mjs only if that decision passes and the fitted weight is > 0. auto.yml re-fits every Tuesday (and on gate dispatches).
- **Scoreboard:** "with vs without drive patterns" in the Lab and in Drives (paired bootstrap, `src/drive-score.js`).

## App 4.7.0 — drive patterns (display-only; model stays endzone-4.6.0)

**What it is.** `scripts/drives/lib.mjs` turns nflverse play-by-play (last season + this season to date) into a per
team-game-drive table: for every player on every drive, targets, receptions, receiving yards, carries, rushing yards,
red-zone and inside-10 touches, and TDs (`archive/drives/<season>/table.json`). `scripts/drives/build.mjs` writes a
weekly pre-game file `archive/drives/<season>/w<week>.json` (games before that week only) with each player's last six
games drive by drive, a descriptive phase profile, and the patterns that survive the checks. auto.yml rebuilds it on
Tuesdays and manual runs, otherwise only when a week's file is missing (continue-on-error).

**Pattern test.** For every player with 4+ games, each drive number (1st…10th) and each phase (opening script = drives
1–2, first-half drives 3+, first drive after halftime, second-half leading / trailing, two-minute drives, red-zone and
goal-to-go drives) × touch / target / carry SHARE of his team's volume on those drives vs his share on the team's
other drives in the same games (exact two-sided binomial). Benjamini–Hochberg FDR q ≤ 0.10 across all ~15,000 tests,
displayed shares shrunk toward his overall share (10 pseudo-opportunities), reliability from walk-forward persistence
(found through week N, scored on week N+1; `scripts/drives/research.mjs`, 2025 w5–18 + 2026 w2–7). Raw per-drive
rates are shown but not tested: they mostly rediscover that some drives are longer than others (a team effect).

**What survived (2026 week 8).** Exact drive-number claims ("2 catches on the 3rd drive"): 431 of 8,314 tests hit
p < 0.05 against 416 expected by pure chance; 18 survive FDR (8 strong, 8 moderate), almost all RB series rotations
(e.g. Blake Corum 4% of the 1st-drive touches vs 18% otherwise). Those FDR survivors kept 50% [29–70%] of their edge
the following week; unfiltered p < 0.05 drive-number hits kept 22%. Phase patterns are more real: 655 vs 337 by chance,
77 survive FDR (47 strong), out-of-sample retention 61% [49–74%].

**Predictions.** `scripts/drives/verify.mjs` adds red-zone, goal-to-go and opening-script share plus a game-script lean
to the usage leg and runs the same walk-forward / prospective game-bootstrap as 4.6.0 (ΔBrier, Δlog loss ×1e-3,
negative = better). Usage leg with drive features vs without: 2025 −0.25 [−0.41, −0.08] Brier, log loss −0.64
[−1.36, 0.17]; 2026 held-out −0.17 [−0.42, 0.08], log loss −0.18 [−1.38, 1.10]; prospective −0.30 [−0.81, 0.15].
Blend with vs without: −0.06 [−0.12, −0.01] in 2025, −0.04 [−0.12, 0.04] in 2026. The 2026 / prospective intervals
include zero and log loss is never significant, so the features are **not adopted**: the drive section is display-only,
MODEL_VERSION stays endzone-4.6.0 (so the 4.6.0 prospective gate keeps counting), and only the app version moves to
4.7.0. The decision and numbers live in `src/drive-baseline.json` and are shown in the app.

npm: `drives:build` (`--weeks 7,8`, `--season`, `--if-missing`), `drives:research`, `drives:verify`.
