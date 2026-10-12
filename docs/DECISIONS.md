# Setup decisions

- The web workspace uses the npm workspace package entrypoint for `@flight-delay/shared`. Its `main`, `types`, and `exports` point directly to `src/index.ts`; `web/tsconfig.json` remains unchanged. A temporary type import verified both TypeScript and Vite resolution.
- The Vite dev server uses port 5173 so the proxied health endpoint is available at the URL requested; `/api` forwards to the API on port 3001.
- The base TypeScript config maps `@flight-delay/shared` for `server/` and `shared/`; the web workspace resolves the package through npm instead.
- The health route takes a `pingMongo` function in `createApp` options so its test can simulate MongoDB without a live database. The normal route uses the Mongo client helper, which catches ping failures and reports `mongo: "down"` with HTTP 200.
- Environment values are required and validated at startup. `.env.example` and the ignored local `.env` supply the local development values; invalid or missing values produce a readable error.
- The error middleware always responds with `{ error: { code, message } }`; unmatched routes use `NOT_FOUND` and unexpected errors use HTTP 500.
- Root `typecheck` checks server, shared, and web. ESLint is configured to lint server and shared only, as requested.
- The original `bun.lock` was deleted and the npm lockfile was regenerated for the three workspaces. No dependency install used Bun or Yarn.
- MongoDB has no authentication because this compose service is for local development, and binds only to loopback on port 27017.

## Phase 0 review (2026-10-11)

Fixes applied after re-running the SETUP_LOG checks and reviewing the scaffold against PROJECT_OVERVIEW sections 2, 4, 5, 9 and 13.

- **Logging uses pino everywhere (§5, §13).** `server.ts` used `console`. Added `server/src/logger.ts` (one pino instance, `silent` when `NODE_ENV=test`), passed it to `pino-http`, and registered `pino-http` first so body-parse failures are logged too. Startup failure now logs `fatal` and exits with code 1. Shutdown errors are logged.
- **Error middleware moved to `server/src/middleware/error.ts` (§4, §9).** Malformed JSON returned 500 and echoed the parser message. Body-parser errors keep their 4xx status and get a matching code (`400 BAD_REQUEST`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`; any other 4xx falls back to `BAD_REQUEST`) in the shape `{ error: { code, message } }`. Unexpected errors return a fixed `"Internal server error"` and log the real error, so internal messages (e.g. connection strings) never reach clients. `ErrorResponseSchema` (with optional `details`) is now in `shared/`.
- **Tests no longer need a local `.env` (§14 CI).** The test import chain reaches `config/env.ts`, which threw without `.env`. Root `vitest.config.ts` now supplies test env values. Verified by running `npm test` with `.env` moved away.
- **Env parsing is testable.** `config/env.ts` exports `parseEnv(record)`. `env` is still validated at import, so startup behaviour is unchanged. dotenv's banner is silenced with `quiet: true`.
- **The Mongo client singleton is race-free.** Concurrent `connectToMongo()` calls could each create a client. The in-flight connect promise is now cached and cleared on failure.
- **Web TypeScript is strict (CLAUDE.md "strict everywhere").** Added `"strict": true` to `web/tsconfig.json`. This is a config-only change: it produced 0 new errors, and the web build still passes. No web source was changed.
- **Prettier is runnable (§5).** Added the root `format` / `format:check` scripts. Set `endOfLine: "auto"`, because `core.autocrlf=true` on Windows makes every working-copy file CRLF.
- **Lint covers tests.** The lint script is now `eslint server shared` (it was `server/src shared/src`).
- **Node version is declared (§2).** Added `"engines": { "node": ">=20" }`.

### Phase 0 review, follow-up (approved)

The user approved keeping the out-of-scope fixes above: the Mongo race fix, `parseEnv`, the wider lint scope, Prettier `endOfLine`, and `web/tsconfig.json` strict. They also asked for the open items to be fixed:

- **`/health` reports degraded state.** When the Mongo ping fails it returns HTTP 503 `{ status: "degraded", mongo: "down", modelLoaded: false }`. That lets Docker and uptime checks detect it. The healthy response is unchanged. `HealthResponseSchema` now allows `status: "ok" | "degraded"`, and `modelLoaded` is widened to `boolean` ahead of Phase 5.
- **MongoDB fails fast.** The client uses `serverSelectionTimeoutMS: 5000`. With Mongo unreachable, startup now logs `fatal` and exits 1 after about 5 s instead of hanging for about 30 s, and `/health` answers within about 5 s.
- **CORS is restricted to one origin.** The new optional `CORS_ORIGIN` env var defaults to `http://localhost:5173` and is listed in `.env.example`. It replaces `cors()`, which allowed any origin. The Vite proxy is unaffected. It is optional, so the four required vars are unchanged.
- **Vitest upgraded to 5.0.3** (root and server). This clears the dev-only advisories (`tinypool` GHSA-5gmw-xhrv-c9v3 and GHSA-85c8-ppgw-ccpr; `@vitest/mocker` GHSA-82fw-gwwq-j7x9). `npm audit` (dev included) now finds 0 vulnerabilities. No test changes were needed.
- **`.claude/` is now tracked.** The session's permission check blocked the agent from un-ignoring it, so the user committed the project agents, skills, hooks and `.mcp.json` themselves (`3f94336`). Neither contains secrets. A follow-up commit ignores `.claude/settings.local.json` (personal permissions) and Python caches (`__pycache__/`, `*.pyc`), and untracks a committed `.pyc` file.

## Phase 1: ingestion

- **Numeric airport ids are kept and flagged.** In the full load, 486,165 rows use 5-digit BTS airport ids instead of IATA codes (§3), all of them in October, for both origin and destination. Ingest keeps these rows. It stores the raw id in `originAirportId` / `destAirportId` (null for IATA rows) and as the provisional `origin` / `dest`, sets `originIsIata` / `destIsIata: false`, and leaves city/state null, so the test split (Oct-Dec) is not hollowed out. They are then resolved offline by `resolve:airport-ids` (see "Airport id resolution" below).
- **Extra fields beyond §6.1:**
  - `originIsIata`, `destIsIata`, `originAirportId`, `destAirportId`, `originIataDerived`, `destIataDerived` (above);
  - `elapsedTime`, kept for analysis. Like the other post-departure fields, it is a forbidden model feature (§7).
- **`dayOfWeek` is derived from the UTC date** (1 = Monday ... 7 = Sunday), not copied from `DAY_OF_WEEK`, so it is always consistent with `date`.
- **`isDelayed` is null** when the flight was cancelled or diverted, or when `ARRIVAL_DELAY` is blank. Otherwise it is `arrDelay >= 15`.
- **`causes` is null when all five cause columns are blank.** Otherwise each cause is a number or null. Blanks are never stored as 0 (§3).
- **`2400` schedule times mean midnight:** `schedDepMin = 0`, `schedDepHour = 0`, the same calendar day.
- **Rejected rows** are counted by reason in `ingest_runs.rejectReasons` and never abort the load. The reasons are: missing columns, invalid date, unknown airline, bad flight number, bad airport code, bad scheduled departure/arrival, bad distance, a non-numeric value, a bad 0/1 flag, or a bad cancellation reason. Unknown IATA airports are kept with null city/state rather than rejected.
- **Reference data** (`airlines`, `airports`, `_id` = IATA) is re-read in full on every run and upserted by `_id`, so it is idempotent. The files are tiny (14 + 322 rows), so holding them in memory is fine. Each file also gets an `ingest_runs` record.
- **Modes:**
  - `--drop` drops `flights` once the reference files have loaded, before the flights load.
  - `--append` adds to it.
  - With neither flag the load refuses when `flights` is non-empty (§6.4).
  - `--limit N` (smoke runs) and `--dir PATH` were added for testing. They do not change these semantics.
- **`ingest_runs` documents** add `status`, `mode`, `peakRssMb` and `error` to the §6.1 fields. Peak RSS is sampled every second and after each batch, as evidence for the ~500 MB acceptance limit. A failed load is recorded with `status: "failed"` and the counts so far.
- **Indexes are not built by ingest.** §6.4 says to create them after the bulk load, and Phase 2 owns `build:indexes`.

## Airport id resolution (`npm run resolve:airport-ids`)

**Why.**
- 486,165 rows use 5-digit BTS airport ids instead of IATA codes (origin and destination), all in October.
- October is about a third of the Oct-Dec test split.
- Those rows would never match `delay_lookup` keys, which are built from IATA codes, so evaluation would be distorted.

**Method.** This is offline: no crosswalk file and no network.
1. Key a scheduled service as `(airline, flightNumber, schedDepMin, schedArrMin)`.
2. Build a reference from the **September and November** rows that have IATA codes on both ends: key -> (origin, dest). Keys seen with more than one origin/dest pair are discarded.
3. Every row with a numeric id whose key is in the reference votes "origin id -> reference origin" and "dest id -> reference dest". The origin and dest votes for an id are counted together, and each role's count is also reported.
4. Thresholds: an id is mapped only if it has **at least 20 votes** and its top IATA code has **at least 99%** of them. If two ids would map to the same IATA code, both are rejected (this did not happen).
5. Ids that fail stay as they are: the numeric code in `origin` / `dest`, `originIsIata` / `destIsIata: false`, null city/state.

**Applying.**
- The resolver sets `origin` / `dest` to the IATA code, sets `originIsIata` / `destIsIata: true` and `originIataDerived` / `destIataDerived: true`, fills city/state from `airports`, and recomputes `route`.
- `originAirportId` / `destAirportId` are never modified.
- It is dry-run by default and writes only with `--apply`.
- Every run rewrites the affected rows from their raw ids, so it is idempotent. The first `--apply` rewrote all 486,165 rows. A second `--apply` on the full data modified **0** documents and left `docs/airport-id-map.json` byte-identical; the integration test asserts the same thing.
- It streams through cursors and applies `_id`-targeted bulk updates in batches of 10,000. Peak RSS across the full-data runs was 364-455 MB. The reference index (127k keys) is the main consumer.
- It refuses to run on data ingested before raw ids were stored, and asks for a re-ingest.
- Each run is recorded in `resolve_runs`. The full mapping, with votes, top shares and candidates for every id, is in `docs/airport-id-map.json`.

**Results** (from the 2026-10-11 run on the full load):
- Reference: 932,918 Sept/Nov rows gave 127,099 schedule keys, of which 32 were ambiguous and dropped.
- 357,575 of the 486,165 numeric-id rows (73.5%) matched a reference key.
- 307 distinct numeric ids; **282 mapped**, 25 not mapped.
  - Every mapped id has at least 22 votes and at least 99.67% top share; the median is 392 votes. 274 ids are unanimous, and 8 have a few stray votes (e.g. 12889 -> LAS 21,212 / 21,233).
  - The 25 unmapped ids are small airports with 1-159 rows each. 18 had no matching schedule (`no_votes`) and 7 had fewer than 20 votes (`too_few_votes`); none was rejected for top share or a duplicate claim. They are 10141, 10146, 10165, 10333, 10577, 10581, 10666, 10731, 11013, 11150, 11315, 11503, 11587, 11898, 12129, 12335, 12343, 13360, 13502, 13795, 14098, 14150, 14222, 14520 and 15323.
- Sanity hints, checked before applying: 10397 -> ATL (17,176 votes, 100%), 13930 -> ORD (50,287, 100%), 12892 -> LAX (27,180, 99.996%).
- **Coverage:** 483,018 of 486,165 rows (**99.35%**) now have IATA codes on both ends. 1,632 rows still have a numeric origin and 1,630 a numeric destination, which is 0.34% of October each way. No other month has any.

**Limitations.**
- October airport codes are **derived, not original**. Use `originIataDerived` / `destIataDerived` to tell them apart.
- A wrong mapping is possible in principle, for example if an airline reused a flight number and schedule on another route in October only. The 99% / 20-vote thresholds and the per-id evidence in `docs/airport-id-map.json` make such errors unlikely and auditable, but this is not an official BTS crosswalk.
- Analytics and lookups (Phases 3-4) should still exclude the remaining 0.34% (`originIsIata` / `destIsIata: false`) from airport-keyed results.
- Re-running `ingest -- --drop` brings the numeric ids back, so `resolve:airport-ids -- --apply` must be re-run after every re-ingest (see the README order).

## Phase 2: indexes

**Index set: exactly PROJECT_OVERVIEW §6.2.** It is defined in `server/src/db/indexes.ts` and built by `npm run build:indexes` after the load (§6.4). Each index has an explicit name:

| Index | Key | Serves |
|---|---|---|
| `date_1` | `{ date: 1 }` | date ranges, daily/monthly trends, the stats_daily build |
| `airline_1_date_1` | `{ airline: 1, date: 1 }` | one airline over a date range (equality, then range) |
| `origin_1_schedDepHour_1` | `{ origin: 1, schedDepHour: 1 }` | one airport, optionally by hour |
| `route_1` | `{ route: 1 }` | one route |
| `isDelayed_1_month_1` | `{ isDelayed: 1, month: 1 }` | delayed/on-time counts by month (answered from the index alone with a COUNT_SCAN) |
| `month_1_airline_1_with_causes` | `{ month: 1, airline: 1 }`, partial on `{ causes: { $type: "object" } }` | cause analysis. It only holds flights with causes (1,063,439 of 5,819,079). Queries must repeat `causes: { $type: "object" }` to use it. |

**Idempotent, never destructive.**
- Every spec is checked before anything is built.
- An index that exists with the same key order and partial filter is skipped.
- A name or key clash with a different definition stops the run with an error. It is never dropped automatically.
- A second run on the full collection reported all six as `exists` in 5 ms.

**Build evidence.** `npm run build:indexes`, 2026-10-11, 5,819,079 documents, MongoDB 7.0.43 in Docker with 7.6 GiB available to the container. The container stayed healthy throughout.

| Index | Build time | Size |
|---|---|---|
| `date_1` | 13.8 s | 27.7 MB |
| `airline_1_date_1` | 13.8 s | 48.5 MB |
| `origin_1_schedDepHour_1` | 18.4 s | 37.9 MB |
| `route_1` | 16.1 s | 45.8 MB |
| `isDelayed_1_month_1` | 16.4 s | 26.8 MB |
| `month_1_airline_1_with_causes` | 8.4 s | 5.7 MB |
| **Total** | **86.9 s** | |

`db.flights.stats()` before and after (read with `$collStats`):

| | Data size | Storage size | Total index size |
|---|---|---|---|
| Before | 3,742.6 MB | 861.6 MB | 61.7 MB (`_id_` only) |
| After | 3,742.6 MB | 861.6 MB | 254.1 MB |

The six indexes add 192.4 MB, 29.5% of the compressed storage size.

**Indexes considered and not added** (based on the mongo-query-optimizer review, measured 2026-10-11):
- **`dest`:** not added. `{ dest: "ORD", destIsIata: true }` is a collection scan, about 4.6 s for 313,514 rows. But no §9 endpoint reads by destination: delay-rate is by airline, origin, route, dow or hour. Destination statistics and `delay_lookup` by dest (Phase 4) are built from one full `$group` pass, which an index would not speed up. Revisit only if a per-destination API read appears. `{ dest: 1, schedDepHour: 1 }` would cost about 38 MB.
- **`split`:** not added. It has two values, and `train` covers 4,385,712 rows (75%). `export:training` reads most of the collection anyway: `{ split: "train" }` scans in about 6.8 s, and the equivalent `date_1` range took about 6.3 s through an index while fetching the same 4.39M documents. The export will stream a projected cursor instead.
- **`originIsIata` in an index:** not added. Only 1,632 rows (0.03% of all flights) are `false`. Airport queries filter it after the `origin` index match at negligible cost: on Q2 and Q3, every fetched document passed the filter.
- **A covering index for airport-by-hour delay rates** (`{ origin, schedDepHour, isDelayed }`): not added. Q3 (ORD, 313,536 documents fetched) only improves 4.6 s -> 2.3 s, because `isDelayed` must be fetched. That workload is served by the Phase 3 pre-aggregation `stats_airport_hour`; a fourth wide index would cost RAM on every write.

**Explain evidence.** See `docs/EXPLAIN_RESULTS.md` (`npm run explain:report`). There are 8 queries. Q1-Q7 each use their intended index: 7 of 7 pass, with server-time speedups between 2.0x (Q3) and 147x (Q6). Q8 is a whole-collection ranking control with no index, and is a collection scan in both modes. The baseline uses `.hint({ $natural: 1 })`, so no index is dropped to get it.

**Representative queries live in TypeScript** (`server/src/db/representative-queries.ts`), not in a mongosh script, because CLAUDE.md allows no non-TS code besides `ml/train.py`. Phase 3 will add the real analytics pipelines to this set.

### Phase 2 follow-up fixes (2026-10-11)

- **`explain:report` proves that indexes change only the speed.** Each query also runs for real under the `$natural`-hinted plan and the default plan:
  - Find queries compare `countDocuments` with and without `hint: { $natural: 1 }`.
  - Aggregations compare their complete result arrays with a deep-equality check. Q8's sort gained an `_id` tiebreak so ties cannot reorder.
  - The report prints a per-query "Same result" column and a PASS/FAIL line, and the command exits non-zero on any mismatch.
  - On the full data, 8 of 8 queries are identical. For example, Q1 counts 45,966 under both plans, and Q3 returns 20 identical documents under both.
- **Query listings print dates as `ISODate("...")`**, so they can be pasted into mongosh (`server/src/db/shell-format.ts`).
- **Q1 sanity check:** the report now counts AA flights by month via a collection scan, independent of `airline_1_date_1`.
  - The monthly counts sum to 725,984, which equals `countDocuments({ airline: "AA" })`.
  - March is 45,966, exactly what Q1 returned.
  - AA's monthly volume roughly doubles from July (44,360 in June, 81,434 in July). That is consistent with US Airways flights being reported under AA after the 2015 merger. This is an observation, not something verified here.
- **`GET /api/flights` requires an index-backed filter.** The query must include at least one of `airline` (`airline_1_date_1`), `origin` (`origin_1_schedDepHour_1`), `route` (`route_1`), or a closed `from` + `to` date range (`date_1`). Otherwise it is rejected with 400.
  - Why: `dest` has no index (see "Indexes considered and not added"), so `dest` alone, or an open-ended date, would scan 5.8M documents. A `dest` filter is still allowed on top of a selective filter.
  - Codes must be IATA. A 5-digit unresolved BTS id is rejected, consistent with excluding unresolved airports from airport-keyed reads.
  - `limit` defaults to 20 and is capped at 100 (§9).
  - The rule lives in the shared zod schema `FlightsQuerySchema` (`shared/src/flights.ts`) and is unit-tested. The route itself does not exist yet: the user chose to add the rule now and have Phase 3's `/flights` route validate with this schema and return `400 { error: { code, message, details } }`.

## Phase 3: analytics

**Pre-aggregation (`npm run build:stats`).** These are pure builders in `server/src/stats/builders.ts`. Each one runs `$match` (where a subset is aggregated) → `$group` → `$set` → `$merge` (`on: _id`, `whenMatched: replace`) over `flights`, with `allowDiskUse: true`.

| Collection | Key | Docs | Build (2026-10-12) | Serves |
|---|---|---|---|---|
| `stats_daily` | date, airline (+ dayOfWeek, month, cause minutes, min/max `_id`) | 4,926 | 22.1 s | summary, trend (overall / airline), delay rate by airline and day of week, `/flights` date bounds |
| `stats_daily_origin` | date, origin, airline (IATA origins only) | 386,704 (was 110,522 before the review below) | 33.6 s | trend `?origin=` and `?airline=&origin=` |
| `stats_route` | route (both ends IATA) | 4,695 | 18.1 s | delay rate by route, worst routes |
| `stats_airport_hour` | origin airport, hour (IATA only, + cause minutes) | 4,259 | 21.2 s | delay rate by origin and by hour, causes by airport and by hour, the late-aircraft cascade |
| `stats_cause_monthly` | month, airline (flights with causes) | 162 | 8.4 s | causes overall, by airline, by month |
| `stats_cancellation` | month, airline, reason | 440 | 6.1 s | cancellation reasons |
| `stats_delay_buckets` | `$bucket` of arrival delay (completed flights) | 8 | 14.9 s | delay-severity histogram |

- **Run time:** 110.2 s in total. Node's peak RSS was 106 MB, since all the work runs in MongoDB. Every run is recorded in `stats_runs`.
- **Rebuilding is idempotent.** Every output document carries the run's `buildId`. After each `$merge`, documents with an older `buildId` are deleted, so keys that no longer exist (e.g. numeric origins before `resolve:airport-ids`) disappear, and no collection is ever empty mid-build. A second full build produced identical document counts and removed 0 stale documents.
- **Sums are stored, not just rates.** Each document stores `flights`, `completed`, `delayed`, `cancelled`, `diverted` and `arrDelaySum`, and derives `delayRate`, `cancelRate` and `avgArrDelay` from them. Re-aggregating at read time (e.g. per-day documents into months) therefore stays exact.
- **Definitions:**
  - `completed` = `isDelayed` is not null.
  - Delay rate = delayed / completed, so cancelled and diverted flights are excluded (§8).
  - Average arrival delay is over completed flights.
  - A null cause counts as 0 only inside these pipelines (`$ifNull`); the stored flights keep `null` (§3).
- **Unresolved airports:** airport-keyed collections (`stats_daily_origin`, `stats_route`, `stats_airport_hour`) exclude the 1,632 rows whose origin is still a numeric BTS id. Totals by airline or month (from `stats_daily` and `stats_cause_monthly`) include them. Cause totals by airport or hour can therefore be slightly smaller than the overall totals; this is intentional.
- **Additions beyond §6.1:**
  - `stats_daily_origin`: §6.1's `stats_daily` has no origin, and trend accepts `?origin=`.
  - `stats_cancellation` and `stats_delay_buckets`: §8.5 cancellation reasons and the §8 `$bucket` histogram.
  - `dayOfWeek` and min/max `_id` in `stats_daily`.
  - Small read indexes, created by `build:stats`: `stats_daily {airline, date}`, `stats_daily_origin {origin, date}` and `{airline, origin, date}`, `stats_route {flights: -1}`.

**API (`server/src/routes/api.ts`, contracts in `shared/src/analytics.ts`).**
- **Reads:** every analytics endpoint reads only `stats_*` collections, none scans `flights`. Pipeline builders are pure and live in `server/src/analytics/`. Responses are validated with the shared zod schemas before they are sent.
- **Validation:** invalid parameters return `400 { error: { code: "VALIDATION_ERROR", message, details } }`.
- **Cache:** responses go through an in-memory TTL cache (10 minutes; `cacheTtlMs: 0` disables it). There is no Redis, per §9.
- **Endpoints beyond the §9 table:** `/analytics/cancellations` (§8.5, Causes page) and `/analytics/delay-distribution` (§8 `$bucket`).
- **`delay-rate`:**
  - `minFlights` defaults to 500 and `limit` is capped at 100.
  - `order=worst|best`, with ties broken by key. This also serves the "worst N routes/airports" ranking of §8.6.
  - `by=dow` and `by=hour` return the full 7- or 24-point series in key order instead of a ranking.
- **`trend`:** `airline` and `origin` can be combined (§9). The first version returned 400 for this; see "Phase 3 review" below.
- **`cancellations`:** reasons are A-D plus `unknown`, so `total` always equals their sum. The full data has no unknown reasons: A 25,262 + B 48,851 + C 15,749 + D 22 = 89,884.
- **Cross-check against Phase 1:** `/analytics/summary` returns flights 5,819,079, delayed 1,063,439, cancelled 89,884 and diverted 15,187. These match the direct counts on `flights` from Phase 1.

**`/api/flights`.** It has keyset pagination on `_id`: `cursor` = the previous page's last `_id`, `limit` ≤ 100, and the response is `{ items, nextCursor }`. `_id` follows ingest (CSV) order, which is almost chronological. Three measured worst cases forced changes:
1. **Late date windows walked the `_id` index from the start:** December took 8.8 s and examined 5.3M documents.
   - Fix: `stats_daily` stores each day's min/max `_id`, and a date window adds `_id ∈ [lo, hi]`.
   - The bounds are the true min/max over the window's flights, so they can never exclude a match. That matters because the data has one day boundary (2015-10-17/18) where the `_id` ranges overlap.
   - The bounds are used only when the latest stats build started after the last completed ingest; otherwise the query runs unbounded (correct, just slower).
   - Result: December now takes 21 ms.
2. **`dest` has no index:** airline + dest with no matches took 1.3-1.5 s.
   - `origin + dest` is now rewritten to the indexed `route` key (`route` always equals `origin-dest`), so JFK→HNL takes 5 ms.
   - `dest` is otherwise only accepted with `route`. `airline` + `dest` and date + `dest` return 400 with "combine it with origin (or use route)".
3. **airline + origin with no matches:** HA + ATL fetched all 76,272 HA flights, about 2 s.
   - Added one index beyond §6.2. It was first `airline_1_origin_1` `{ airline: 1, origin: 1 }`, then replaced by `airline_1_origin_1__id_1` in the Phase 3 review below.
   - A planner hint was rejected: hinting the origin index for a dense pair like DL + ATL would fetch all of ATL's ~350k flights.
   - Result: HA + ATL now takes 4 ms.

Remaining known cost: pages of a busy route re-scan the route on every page. This is an accepted trade-off; see "Phase 3 close-out" below for measurements.

**Evidence.** These come from the "API endpoint timings (Phase 3)" section of `docs/EXPLAIN_RESULTS.md`. All 32 requests were made over HTTP with the cache off, and all returned 200 in under 1 s:
- analytics medians 7-51 ms (max 110 ms);
- `/flights` medians 4-68 ms (max 306 ms).

The query reviews behind the three fixes were done by the mongo-query-optimizer and ts-reviewer agents.

**Tests.**
- **Seeded fixture:** `server/tests/analytics/analytics.integration.test.ts` has 26 tests on a 9-flight fixture with hand-computed values. It covers null causes, cancelled and diverted flights, an unresolved origin, tiny groups under `minFlights`, the stale-key sweep, pagination and the 400 cases. It uses `flight_delay_analytics_test`, dropped in `afterAll`. A deliberate mutation of the "completed" definition failed 8 of these tests, so they detect logic changes.
- **Pipeline shapes:** `builders.test.ts` checks pipeline shapes and the `/flights` filter.

### Phase 3 review: final decisions (2026-10-12)

**1. Extra index: kept, but changed to `airline_1_origin_1__id_1` `{ airline: 1, origin: 1, _id: 1 }`.**
- **Why it is needed.** `/api/flights` with `airline` + `origin` has no fast §6.2 plan. These are measured explain plans on the full data, 8 airline-origin pairs, page size 21. Without an airline-origin index:

  | Plan | Range | Worst case |
  |---|---|---|
  | `airline_1_date_1` + in-memory sort | 0.9-3.0 s | WN+MDW sorted 1,261,855 docs |
  | origin index + sort | 1.3-2.0 s | |
  | `_id` walk | 2-378 ms for dense pairs | 7.5 s for an empty pair (HA+ATL scans all 5,819,079) |

- **Why not `{ airline, origin }` alone.** The version first shipped in Phase 3 fixed empty pairs (HA+ATL: 1 ms). But the planner sometimes picked it and then sorted a dense pair in memory: NK+FLL took 513 ms and VX+SFO 446 ms, where an `_id` walk took 10-20 ms.
- **What the trailing `_id` changes.** It returns a pair's flights already in page order, so every pair (empty, sparse or dense, and later pages) reads exactly ≤ 21 keys and ≤ 21 docs in 1-3 ms with no sort.
- **Cost:**
  - 96.3 MB versus 36.2 MB without `_id`; total index size 350.3 MB, 40.7% of the 861.6 MB compressed storage.
  - 15.5 s to build.
  - One more index to maintain on every insert. Ingest builds indexes after the load (§6.4), so the bulk load is unaffected; only appends pay this.
- **Verdict.** It is justified: it is the only way to make every airline + origin page constant-time, and 96 MB is small next to the 3.7 GB of data.
- **Retirement.** `build:indexes` retired the first version through `RETIRED_FLIGHT_INDEXES`. It drops an index only when both the name and the exact key match, logs it, and an integration test covers it. Unrelated indexes are never dropped.
- **Unaffected checks.** The Phase 2 explain checks still pass: 7/7 intended indexes and 8/8 identical results.

**2. `dest` rule: kept as is.** `dest` is accepted only with `origin` (served as the indexed `route`) or with `route`; otherwise the request returns 400 with guidance.
- No §10 page needs destination-only browsing. Arrival statistics are served from `stats_*`, and origin + dest covers "flights between two airports" in 5-8 ms.
- Allowing `dest` with `airline` or a date window would need another index of about 40-100 MB. Without one, the measured cost was 1.3-1.5 s with no matches, and an unbounded worst case for large airlines.
- The 400 message names the alternative, so clients are never left guessing.
- If a destination view is added later, add `{ dest: 1, _id: 1 }` using the same pattern as decision 1.

**3. Trend restriction: removed.** §9 lists `?airline=&origin=` together, so returning 400 deviated from the spec.
- `stats_daily_origin` is now keyed by (date, origin, airline): 386,704 docs, 25.3 MB, 33.6 s to build. It has an index `{ airline: 1, origin: 1, date: 1 }`.
- A combined series reads at most 365 documents: `trend?airline=DL&origin=ATL&granularity=day` takes 20 ms median.
- An origin-only series re-aggregates the airlines of that origin: ORD reads 4,196 docs in 33 ms.
- Rebuilding swept the 110,522 old-shape documents through the `buildId` mechanism. Total `build:stats` time went from 110 s to 127 s.

**4. The 1,632 unresolved-airport flights are now visible in results, not only in docs.**
- **Counts.** `build:stats` records them in `stats_runs.dataQuality` as exact differences of the stats totals: all flights minus origin-keyed flights, and all flights minus route-keyed flights. They agree with direct counts on `flights`:
  - 1,632 with an unresolved origin (0.028% of all flights);
  - 3,147 with an unresolved origin or destination (= 486,165 − 483,018 from the airport-id resolution).
- **Where they appear:**
  - `/api/meta` returns `dataQuality: { flights, unresolvedOriginFlights, unresolvedRouteFlights }`.
  - Airport-, hour- and route-keyed responses carry `coverage: { excludedUnresolvedFlights, note }`. That covers delay-rate by origin, hour and route; causes by airport and hour; cascade; and trend with `origin`.
  - `coverage` is null when the dimension counts every flight: airline, month, day of week and overall.
  - `docs/EXPLAIN_RESULTS.md` prints the same counts in its data-coverage line.

**Evidence (final run).** All 33 timed requests return 200 in under 1 s:
- analytics medians 5-50 ms (max 285 ms);
- `/flights` medians 5-350 ms (max 439 ms; busy-route pages are the tail, see "Phase 3 close-out").

Tests: 121 pass. They include new fixture tests for combined trends, coverage on every airport-keyed endpoint, `/meta` data quality, and index retirement.

### Phase 3 close-out: deferred items (2026-10-12)

**`$facet`: deferred to Phase 6, not needed yet.**
- §8 asks for `$facet` "where one request needs several slices" of a single scan. No Phase 3 request does: every analytics endpoint returns exactly one breakdown from one pre-aggregated collection.
- The multi-slice needs are on Phase 6 dashboard pages (§10). Most of them read *different* collections, which `$facet` cannot combine because it splits one input stream:
  - Causes page: cause minutes from `stats_cause_monthly`, cascade from `stats_airport_hour`, cancellations from `stats_cancellation`.
  - Explorer: worst airlines from `stats_daily`, worst airports from `stats_airport_hour`, worst routes from `stats_route`.
- The one real candidate is the Overview page: its KPI totals and its monthly trend both read `stats_daily`. If Phase 6 serves that page in one request, it will use `$facet` over `stats_daily` and record the measurement.
- Already in use from the §8 toolset: `$bucket` (delay histogram), `$group` + `$merge` (`build:stats`), `allowDiskUse` (stats builds), and `$match` first wherever a pipeline filters.

**Busy-route `/flights` pages: accepted trade-off, `route_1` (§6.2) unchanged.**
- **The cost.** `/flights` pages are returned in `_id` order. `route_1` yields a route's flights in key order, so the planner either walks `_id` and filters, or reads the whole route and sorts it. Either way a busy route's page examines many documents.
- **Who is affected.** Only 8 of the 4,695 routes have 10,000 or more flights. The busiest is SFO-LAX with 15,116, then LAX-SFO 14,799 and JFK-LAX 13,113.
- **Measured (2026-10-12, server side, warm cache, median of 3, page size 21):**

  | Route | First page | Last page |
  |---|---|---|
  | SFO-LAX | 14 ms, 9,131 docs examined | 10 ms, 8,484 docs |
  | JFK-LAX | 12 ms, 8,506 docs | 13 ms, 12,145 docs |
  | LAX-SFO | 13 ms, 10,097 docs | 11 ms, 8,551 docs |

- **Over HTTP.** In the `explain:report` run straight after a stats rebuild (cold cache), the same pages took 252-350 ms median and 439 ms max. That is still under the 1 s target.
- **The alternative and its cost.** A `{ route: 1, _id: 1 }` index (the pattern used for `airline_1_origin_1__id_1`) would make every route page read ≤ 21 documents. It would hold one entry per flight (5.8M), like `airline_1_origin_1__id_1`, which measured 96.3 MB. Every insert would maintain it, and it would duplicate the §6.2 `route_1`.
- **Decision.** Not worth it while the worst case is 10-14 ms warm and under 0.5 s cold. Revisit if `/flights` gains a route-heavy UI or `explain:report` shows a busy route over 1 s.

**`docs/SCHEMA.md`: deferred to Phase 7.** PROJECT_OVERVIEW §11 lists `SCHEMA.md` under Phase 7 (Hardening + docs). Until then, the schemas are documented in code and in this file:
- `FlightDoc` and the run documents: `server/src/db/collections.ts`;
- stats collection keys and fields: `server/src/stats/builders.ts`, and the Phase 3 table above;
- API contracts: `shared/src/analytics.ts` and `shared/src/flights.ts`.

**Phase 4 not started.**
