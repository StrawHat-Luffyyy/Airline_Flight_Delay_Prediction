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

## Phase 4: features and training (2026-10-13)

**Feature contract.**
- The 13 features are defined in `server/src/features/feature-list.ts`, in order: `dayOfWeek, schedDepHour, isHolidayWeek, airline, origin, dest, distance, scheduledTime, airlineRate, originRate, destRate, originHourRate, routeRate`.
- `ml/train.py` must use the identical list. A test parses its `FEATURES` literal and compares.
- `ml:register` refuses a run whose `featureList` differs, so `/predict` (Phase 5) can always encode its inputs.

**Deviations from §7, each approved by the user:**
1. **Out-of-fold rate features.** `delay_lookup` is computed from the train split only, with m-estimate smoothing (m = 50) toward the scope's global rate.
   - Training rows use rates from the *other* train months, in 3 month-folds: Jan-Mar rows use Apr-Sep, Apr-Jun use Jan-Mar + Jul-Sep, Jul-Sep use Jan-Jun. No training row's rate includes its own label.
   - Test rows and `/predict` use the full Jan-Sep rates.
2. **airline × month rate dropped.** Under month-fold out-of-fold encoding, no evaluated row can have one without leakage. `month` and the airline rate cover the same ground.
3. **`month` dropped as a feature.** Training sees only months 1-9, so every Oct-Dec flight (the whole test set, and any `/predict` date in Oct-Dec) was treated like September. It also identified a row's out-of-fold rate set, which test rows never share.
   - The leakage-auditor ranked it as the top problem.
   - On September validation only, dropping it changed AUC 0.6478 → 0.6449 (noise), so the decision was made on validation evidence before any test result.
   - `month` is still exported, as an identifier column for the September carve-out and the split assertions.
4. **3,127 completed flights with unresolved airports excluded,** all of them October (test split). `/predict` only accepts IATA codes. The counts are in `metrics.json.excluded`.
5. **Model selected on validation, not on test AUC.** §7 says "picks the best by test ROC-AUC", but that would tune on the test set. September is held out from train for early stopping, the threshold (max F1 on the validation PR curve) and model selection. The final models are refit on Jan-Sep, and the test set is only scored.
6. **Python 3.12** instead of 3.11: the 3.11 install on this machine is broken. Dependencies are pinned in `ml/requirements.txt` and installed in `ml/.venv`.

**Other choices:**
- LightGBM uses the integer codes as numeric features, not `categorical_feature`, so the ONNX export is reliable; the rate features carry most of the categorical signal.
- Logistic regression uses only the scaled numeric features.
- The holiday flag means within ±3 days of a US federal holiday, computed by rule for any year, including adjacent years.

**Pipeline evidence (full data):**
- **`build:lookup`:** 32.7 s. It produced 249,130 (airline, origin, dest, hour, month) cells and 36,420 lookup entries over 4 scopes. The full scope covers 4,299,046 completed train flights, 836,017 delayed (19.45%).
- **`export:training`:**
  - 4,299,046 train rows and 1,411,835 test rows, exactly the completed IATA flights per split;
  - excluded: 3,127 with an unresolved airport and 105,071 cancelled or diverted;
  - final run 222 s, peak RSS 284 MB;
  - files are written to `.tmp` and renamed only on success, and the export refuses to run unless the last lookup build completed.
- **`ml/train.py`:** 89.5 s. ONNX matches the native model to within 2.0e-7 over all 1,411,835 test rows. `model.onnx` is 0.72 MB.
- **`ml:register`:** upserts by `modelVersion`. `model_runs` keeps both runs as history: `lightgbm-20261013093139-12f165c2` (final) and the earlier run with `month`.

**Results** (from `ml/artifacts/metrics.json`; chosen model LightGBM, 157 trees, threshold 0.2070):

| Model | Validation AUC | Test AUC | Test PR-AUC | Test precision | Test recall | Test F1 |
|---|---|---|---|---|---|---|
| Baseline (constant train rate) | 0.5000 | 0.5000 | 0.1608 | 0 | 0 | 0 |
| Logistic regression | 0.6287 | 0.6155 | 0.2218 | 0.216 | 0.531 | 0.307 |
| **LightGBM** | **0.6449** | **0.6276** | **0.2348** | **0.218** | **0.582** | **0.318** |

- **Confusion matrix** (test, n = 1,411,835): TN 711,981, FP 472,825, FN 94,948, TP 132,081.
- **Class balance:** 19.45% delayed in train and 16.08% in test, so the test period is easier on average.
- **Top features by gain:** originHourRate 34.4%, schedDepHour 13.8%, airlineRate 13.7%, airline 7.0%, routeRate 6.3%, originRate 6.1%, destRate 4.7%, dayOfWeek 4.2%, origin 2.5%, dest 2.5%.
- **Threshold transfer:** validation recall is 0.598 and test recall 0.582. The Jan-Aug model scored on test at the same threshold gives AUC 0.6250 and recall 0.601 (`testFitModel`). With `month` the transfer was broken: test recall fell to 0.240.

**Ceiling and caveats:**
- **Below §7's range.** Test AUC 0.628 sits under the 0.65-0.72 that §7 expects for pre-departure features. Nothing was added to raise it: the leakage-auditor found no leakage into test metrics, and the remaining signal (weather, upstream delays) only exists after departure.
- **Optimistic validation figure.** Validation AUC is a slight overestimate. The Jan-Aug rows the validation model is fitted on use out-of-fold rates whose folds include September labels; test metrics are unaffected.
- **Low precision is expected.** At the max-F1 threshold, about 1 in 5 flagged flights is delayed (precision 0.218 against a 16.1% base rate).
- **Not yet tested:** the TypeScript ONNX parity test over `ml/artifacts/parity_sample.json` (100 fixed-seed test rows) belongs to Phase 5.
- **Rate distributions differ between train and test.** Training rows carry out-of-fold rates computed from 6 months; test rows and `/predict` carry full-train rates computed from 9 months, which are slightly less noisy. That mismatch can only cost the model accuracy; it cannot inflate the test metrics.
- **Active model.** `model_runs` keeps every registered run as history; it currently holds 2: the final run and the earlier run that used `month`. Phase 5 must serve the run whose `modelVersion` equals `ml/artifacts/encoders.json.modelVersion` (the deployed `model.onnx`), not merely the newest document.
- **Final leakage-auditor result.** After these fixes the leakage-auditor reported PASS on all 7 items. The only item it could not check is cross-language encoder parity, which needs the Phase 5 `/predict` encoder.

## Phase 5: prediction API (2026-10-13)

**Serving.**
- `onnxruntime-node` 1.30.0 loads `ml/artifacts/model.onnx` once at startup (`server/src/ml/model.ts`) and reads output `probabilities`, column 1.
- `encoders.json` is validated on load and refused if its `featureOrder` is not exactly `FEATURE_COLUMNS` or lists a forbidden feature.
- If the artifacts cannot be loaded, the API still starts. `/api/predict` and `/api/model/*` then return 503 `MODEL_UNAVAILABLE`, and `/api/health` reports `modelLoaded: false`.
- A restart is needed after retraining. A restart is also needed after `npm run build:lookup`, because `delay_lookup` is read into memory once per process.
- **Active model:** `/api/model/metrics` and `/api/model/feature-importance` serve the `model_runs` document whose `modelVersion` equals the loaded `encoders.json.modelVersion`, not the newest run. They return 404 `MODEL_NOT_REGISTERED` if `ml:register` was not run. This is tested with a newer, non-served run present.

**Encoder parity (acceptance).**
- `server/tests/ml/parity.test.ts` runs the 100 fixed-seed test rows of `ml/artifacts/parity_sample.json` through the TypeScript encoder and onnxruntime-node.
  - Every encoded vector equals Python's exactly.
  - The max |p_ts − p_py| is **0.00e+0** (tolerance 1e-4).
- The artifacts are committed, so the test fails rather than skips when they are missing.
- The encoder mirrors `train.py encode()`:
  - unseen category → -1, using `Object.hasOwn` so inherited keys like `constructor` are also unknown;
  - null `scheduledTime` → train median (122);
  - all values float32.

**`/predict` feature derivation.**
- The client sends only `{date, airline, origin, dest, schedDepHour}`. The schema is strict, so any other field, including a post-departure one, is a 400.
- The server derives the rest:
  - `dayOfWeek` (1 = Mon) and `isHolidayWeek` from the UTC date;
  - the five rates from full-scope `delay_lookup`, the same as the test rows;
  - `distance` and `scheduledTime` from `stats_route`.
- An airline or airport not in MongoDB gets 422 `UNKNOWN_CODE`, with `details.field`.
- **Route schedule from `stats_route`.**
  - `npm run build:stats` now adds `distance` (`$max`) and `scheduledTime` (approximate `$median`) to each `stats_route` document: 4,695 routes, all with both fields.
  - These are published schedule data, known before departure, so using every split is not leakage. Only these two fields are read; the route's outcome rates are not.
  - A route with no 2015 flights gets 422 `UNKNOWN_ROUTE`. This is the simplest honest option, since its distance and schedule are unknown.
  - The route's airline is not checked: any known airline may be scored on any known route.
- **Measured skew** (leakage-auditor, all 1,411,835 test rows re-scored with the route-level values instead of each flight's own):
  - distance differs on 0.67% of rows, by at most 1 mile;
  - |Δ scheduledTime| has a median of 3 min and a p99 of 19 min;
  - mean |Δp| is 0.00033, and 0.11% of labels flip at the 0.207 threshold;
  - test AUC moves from 0.62759 to 0.62752.
  - These are the two least important features by gain, so the skew is accepted.
- **Dates outside 2015** are accepted and scored with the 2015 rates. This is extrapolation, not leakage.

**topFactors (occlusion, not SHAP).**
- Each of the five rate features is replaced in turn by the full-scope global train delay rate (0.1945), and the row is re-scored in the same batched ONNX call: 6 rows per request.
- `impact = p − p_without`, sorted by |impact|.
- This uses the real model and is cheap. SHAP-style explanations remain the Phase 7 stretch goal.

**Live check (full data, `npm run start`):**
- `/predict` takes 0.30 s for the first request (loading `delay_lookup`), then 0.012 s.
- `{date: 2015-12-21, AA, ORD→LAX, 17h}` → p = 0.3136, `delayed` (threshold 0.2070). The top factors are routeRate (+0.082) and originHourRate (+0.059).

**Deferred (from the leakage-auditor; none Must-fix):**
- The parity sample has no unseen-category or null-`scheduledTime` rows. Those paths are only unit-tested in TypeScript; adding them needs `train.py` to write targeted rows (and `null` instead of `NaN`) and a retrain.
- No end-to-end test compares `predictDelay`'s encoded row with the exported row for real test flights.
- `encoders.json` does not record the `delay_lookup` buildId it was trained against. The build is deterministic over the train split, so this only matters after re-ingestion.
- No rate limiting on `/predict`; that is Phase 7 scope.

## Phase 6: dashboard (2026-10-15)

**Product context and structure.**
- `web/PRODUCT.md` records the user's answers:
  - the primary audience is examiners at a viva/demo;
  - the cinematic landing is kept as a compact intro (`/`) only;
  - the plain name "Flight Delay Prediction" replaces "Holding Pattern".
- **Page structure.** The user chose it from three sketches built with real API numbers: "Departure board" (impeccable surface roll, seed `d59af782`). The direction contract is in `web/.impeccable/surfaces/src-app-tsx.md`; the sketches are in `web/.impeccable/mocks/decision/`.
  - Every ranking is a hairline-ruled board in tabular figures, with the delay rate as the one lit amber column.
  - The dusk palette encodes data: amber = delayed or delay rate, blue = on time, red = cancelled, and one hue per cause.
  - The Predict panel is the only glass surface.
- **Signature move.** When a ranking re-sorts or refilters, its rows glide to their new rank and changed rows hold an amber lamp for 1.2 s. Under `prefers-reduced-motion` nothing moves.
- The skill's decision page (`serve-question`) hung without output in this harness, so the choice was asked through the structured question tool instead.

**Stack** (§5, with deviations):
- React 19 is kept (the AI Studio scaffold shipped 19; §5 says 18; it is compatible and newer).
- `react-router` 7 in library mode, `@tanstack/react-query` 5 and `recharts` 3. `motion` is used only for the board re-rank.
- Pages are `React.lazy` chunks, so recharts (about 104 kB gzip) is not in the intro bundle.
- **Removed AI Studio leftovers:** `@google/genai`, `express`, `dotenv`, `framer-motion`, `lenis`, `tsx`, `esbuild`, `metadata.json`, the `index.html` fetch shim, `DISABLE_HMR`, the debug logs, the fake predictor and every unverifiable claim listed in FRONTEND_AUDIT §4 (FAA, NOAA, the contact address, expected delay minutes).
- **API client.**
  - `web/src/api/client.ts` validates every response with the `@flight-delay/shared` zod schemas.
  - Non-2xx responses become `ApiError {status, code, message, details}`; a response that does not match its schema is code `CONTRACT`.
  - Hooks never reuse previous rows across a change of entity (`by`), only across sort, minimum or limit changes.
- **Lint and tests.** `npm run lint` now also lints `web/src` (typescript-eslint plus `eslint-plugin-react-hooks` 7.1.1). The web unit tests (`web/src/**/*.test.ts`) run under the root `npm test`.

**New endpoint: `GET /api/analytics/heatmap`** (Explorer hour × weekday heatmap; added to §9).
- `build:stats` adds `stats_dow_hour`: one `$group` over all flights by `(dayOfWeek, schedDepHour)`, 168 documents, built in 13.0 s inside a 137.9 s full rebuild.
- Neither key depends on an airport, so no flight is excluded and `coverage` is always `null`.
- The read is a sort and projection of the 168 docs. `explain:report` measured 9 ms median and 12 ms max over HTTP.

**`$facet`: still not used (the Phase 3 deferral is resolved as "not needed").**
- Overview makes separate cached requests for summary, monthly trend, worst airlines, cause shares and the delay histogram.
- Each is a read of a small pre-aggregated collection (all under about 30 ms), and react-query fetches them in parallel.
- A single `$facet` request would only merge the two `stats_daily` reads, at the cost of a bespoke endpoint.

**Facts the UI states without reading them from an API field:**
- the train/test split (Jan-Sep train, Oct-Dec test, §7);
- the US DOT 15-minute delay definition;
- the note that cause minutes are reported only for flights 15+ minutes late (§3);
- the note that weather and upstream delays are known only after departure.

Every number shown comes from the API.

**Data quirk.** One airport name in `airports` (JFK) contains a U+FFFD replacement character from the source CSV. The Predict selects strip it for display only. A fix at ingest is left for Phase 7.

**Browser verification (Playwright, live API, full data).**
- All six routes were captured at 1440×900 and 390×844, plus the Predict result and the Explorer route-flights panel. The captures are in `docs/screenshots/`.
- There was no horizontal page overflow and no console errors after a favicon was added.
- The impeccable detector reported 0 findings.
- The finish review ran as a degraded substitute (the shipped reviewer agent is not installed) and returned `fix`.
- Fixed in the same batch:
  - the heatmap transposed for mobile, plus a screen-reader table;
  - the Predict select padding;
  - amber kept only for "delayed" on the Model page, with feature importance shown as a board;
  - mobile table columns;
  - the train/test chart labels;
  - glass kept only on Predict;
  - mono kept only for figures;
  - carrier codes on the airline boards and a live leading-cause heading;
  - Predict retry, validation and network errors.
- **The fix batch caused two regressions, both found in the recapture and fixed:**
  - an `sr-only` table widened the mobile page, so the wrapper is now `sr-only`;
  - the mobile importance bars disappeared, so `RateCell` gained `barOnMobile`.
- The reviewer's verdict pass scored all 8 fixes and the regression resolved: `ship`. That verdict covers the scored fixes only.
- **ts-reviewer must-fix items, both fixed:**
  - stale previous-entity rows rendered while a new `by` loaded;
  - `web/` was not linted.
- The re-rank lamp was verified live: 14 rows lit after Worst→Best on Explorer.
- **Screenshots.** 16 full-page PNGs: six pages plus the Predict result and the route-flights panel, each at desktop and mobile width. They are quantised to 256 colours (ffmpeg `palettegen` and `paletteuse`, no dither): 1.4 MB total, down from 2.9 MB.

## Phase 7: hardening and docs (2026-10-16)

**Hardening.** All changes were made test-first (`server/tests/hardening.test.ts`).
- **Rate limit on `POST /api/predict`.**
  - It uses `express-rate-limit` 8.7.0 with an in-memory store (one local process; §9 says no Redis).
  - The limit is per client IP: `PREDICT_RATE_LIMIT_PER_MIN` per minute, default 30. It is the only CPU-bound endpoint: 6 ONNX rows and 4 MongoDB reads per call.
  - Over the limit it answers `429 RATE_LIMITED` in the usual error shape, with RFC draft-7 `RateLimit` / `RateLimit-Policy` headers and the library's `Retry-After` (time left in the window).
  - Read endpoints are not limited: they are cached reads of small stats collections.
- **MongoDB outage → `503 DATABASE_UNAVAILABLE`,** not a generic 500. This covers `MongoServerSelectionError` and `MongoNetworkError`. The driver message (which can name hosts) is logged, not returned.
- **JSON body limit 10 kB** (was the 100 kB default). A `/predict` body is about 100 bytes.
- **Loopback by default.** The API binds to `HOST`, default `127.0.0.1`; set `0.0.0.0` to expose it. `vite` no longer runs with `--host=0.0.0.0`. Before this change the API, and through the Vite proxy the whole app, was reachable from any machine on the local network, although §2 says everything runs locally.
- **Secrets scan.** No secret is tracked. `.env` and `atlas-credentials.env` are git-ignored and have never been committed.
- **Live checks** against the running API on the full data:
  - it listens on `127.0.0.1:3001` only;
  - requests 1-30 return 200 and request 31 returns 429 (`RateLimit: limit=30, remaining=0, reset=55`), while `/api/meta` stays 200;
  - with the MongoDB container stopped, data endpoints return 503 after about 5 s (the driver's server-selection timeout) and `/health` returns `degraded`;
  - after `docker compose start mongo` the API recovered without a restart.

**Airport names: the Phase 6 "data quirk" is fixed at ingest.**
- 36 airport names in `airports.csv` contain a non-breaking space (bytes `C2 A0`, e.g. JFK), not a U+FFFD replacement character as Phase 6 assumed.
- `transformAirportRow` / `transformAirlineRow` now collapse whitespace runs, including NBSP, to one space.
- **New flag:** `npm run ingest -- --reference-only` reloads `airlines` and `airports` (upsert by code, logged in `ingest_runs` with mode `reference`) and never touches `flights`. Airport names are not denormalised into flights; only city and state are, and those had no NBSP.
- After the reload, 0 of 322 airports had an NBSP or a double space. The dashboard's display-side workaround was removed.

**CI.** `.github/workflows/ci.yml` (§14) runs on pushes to `main` and on pull requests, on Node 22 with a `mongo:7` service:
- `npm ci`, typecheck, lint, format check;
- `npm test`, where the integration tests run against the service instead of skipping;
- the web build.

`npm ci --dry-run` resolves cleanly from the lockfile. The workflow has not run on GitHub yet: nothing has been pushed in this session.

**The README run steps were reproduced from scratch** on the full dataset, run in order exactly as the README documents them:

| Step | Command | Exit | Time (s) |
|---|---|---|---|
| 1 | `ingest -- --drop` | 0 | 429 |
| 2 | `resolve:airport-ids -- --apply` | 0 | 128 |
| 3 | `build:indexes` | 0 | 155 |
| 4 | `build:stats` | 0 | 220 |
| 5 | `build:lookup` | 0 | 70 |
| 6 | `ml:register` | 0 | 5 |

- These times are slower than the earlier measurements because other jobs were sharing the machine (296 s for the earlier ingest).
- The rebuilt database matches the one before the drop exactly:
  - 5,819,079 flights, 8 indexes, 903.3 MB storage;
  - every `stats_*` count, 36,420 `delay_lookup` entries and 249,130 cells;
  - 3,147 flights with an unresolved airport.
- `/api/predict` for ORD→LAX 17:00 on 2015-12-21 returned the same probability as in Phase 5 (0.3136).
- Model training (`export:training`, `ml/train.py`) was not re-run: the committed artifacts are the deployed model.

**Docs.**
- **README:** exact run steps from a fresh clone, the full API table (now with `/analytics/heatmap`, `/predict` and `/model/*`), configuration and troubleshooting.
- **`docs/BIGDATA_JUSTIFICATION.md`** covers §12 point by point. It was written by the `report-writer` agent from measured evidence.
  - **Velocity** is described as supported by the design but **not demonstrated**: the optional `simulate:stream` was not built.
  - **Sharding** is design only: the optional sharded compose file was not built.
- **`docs/SCHEMA.md`:** all 19 collections, the fields, and each index with the query it serves.
- **Size correction.** Phase 3 gave `stats_daily_origin` as "25.3 MB". It now measures 117.53 MB uncompressed (`collStats.size`) and 39.9 MB on disk (`storageSize`). Which size metric produced the Phase 3 figure was not recorded, so it is superseded by these two measurements. Units: the new docs use MB = 10^6 bytes, while EXPLAIN_RESULTS uses MiB.

**Stretch goals not done (§11 Phase 7, optional):**
- the sharded compose file;
- scheduled `build:stats`;
- SHAP-style per-prediction explanations. `/predict` keeps the occlusion factors from Phase 5.

The §12 `simulate:stream` is also not built.

**Phase 7 review (ts-reviewer: no must-fix items). Follow-ups applied:**
- The `/predict` limiter now runs **before** JSON parsing, so malformed or oversized bodies count against the limit (tested). `trust proxy` stays unset on purpose: the app has no proxy in front of it.
- The Vite proxy targets `http://127.0.0.1:3001`, matching the loopback-only API, so there is no `localhost` → `::1` ambiguity.
- CI has a step that fails when the MongoDB service cannot be pinged, so integration tests can no longer pass by skipping. It also cancels superseded runs (`concurrency`).
- `--reference-only` resolves `flights.csv` only after its early return.
- A new test checks that an outage gives a 503 through the full `createApp` stack, not only through the error handler.
- **Doc figures unified:**
  - flights storage 903.3 MB, measured after the rebuild;
  - analytics medians 5-39 ms, `/api/meta` 53 ms (EXPLAIN_RESULTS);
  - both `--drop` ingest runs cited (296 s and 421 s);
  - the partial-index comparison names its five indexes;
  - the host specs and the data-directory size cite how they were read.
- **Not run:**
  - The `security-review` skill: it diffs against `origin/HEAD`, which is not set in this clone. The `vibe-security` audit above covered the same scope.
  - A test with `MongoServerSelectionError`: its constructor needs a topology description, so the test uses `MongoNetworkError`. Both classes go through the same branch.

## Post-Phase 7 fix: Predict offered routes that cannot be scored (2026-10-16)

**Problem (user report).** Many flights scored on the Predict page failed with "No 2015 flights on UST-SMX; distance and schedule are unknown" (422 `UNKNOWN_ROUTE`).
- **Cause.** The form let any of the 322 origins be paired with any of 321 destinations. Only 4,695 routes were flown in 2015, and `/predict` needs a flown route for its distance and scheduled-time inputs (Phase 5). An origin averages 14.6 destinations (min 1, max 169), so roughly 95% of the pairs the form allowed could never be scored. UST, for example, only flew to TTN and IAD.
- **The API was behaving as designed;** the form was offering invalid input.

**Fix.**
- **New endpoint** `GET /api/routes?origin=XXX`, which returns `{ origin, destinations: [{ dest, flights }] }` busiest first from `stats_route`.
  - It reads a stats collection (4,695 docs): 13-17 ms cold over HTTP.
  - It is validated with zod (bad code → 400), and an origin with no departures gives an empty list.
  - It is added to the `explain:report` endpoint list.
- **Predict form.** The Destination select now lists only those destinations, with flight counts. A destination the new origin never flew to falls back to its busiest route. That value is derived, not synced in an effect.
- **Form states.** It shows a loading state, an error state with Retry, and an empty state. Submit is disabled until the routes have loaded.
- **Not filtered:** the airline is still any of the 14. `stats_route` has no airline key, and the model scores airline and route independently.

**Verified.**
- A builder test, plus an integration test covering two origins, an origin with no departures, an invalid code and a missing code.
- In the browser (Playwright, live API, desktop and mobile), the user's case scores:
  - US, UST, 2015-12-22, 20:00 offers only TTN (166 flights) and IAD (3);
  - UST→TTN scores 33.1%, "Likely delayed";
  - ORD keeps LAX as its default among its 162 destinations.
- `docs/screenshots/predict-*.png` were recaptured.

## Intro hero upgrade (2026-10-16)

The user asked for this. The scope is the `/` hero only; it keeps the incumbent identity and its copy and numbers.
- **Background.** It is a living dusk background: footage, two drifting cloud bands, a breathing sun, grain, and a flight-path arc with a looping plane on the right. Mouse parallax applies on desktop only.
- **Entrance.** A single entrance sequence finishes by 1.7 s, with count-ups that cannot cause layout jitter.
- **Interactions.** These are the magnetic primary action, the underline and plane on the secondary one, and stat tooltips. The tooltips are worded from the backend formulas (`DERIVED_RATES`) and show real counts from `/api/analytics/summary`.
- **Scroll stage.** The scroll-linked exit runs on a 180dvh sticky stage and ends in a "Continue to the dashboard" hand-off. The user chose this when asked, because the intro has nothing below the hero to scroll into.
- **Hero video.** There is no `/public/media/hero.mp4`. The existing `/videos/airplane-dusk.*` footage is used as the far layer: the poster paints first and the video is created when the browser is idle.

**Measured.**
- **Verified in Playwright** at 1440×900, 768×1024 and 390×844 on the live API: no horizontal overflow, CTAs inside the first viewport, no console errors.
- **Scroll stage.** Content opacity was 1.00 at 0, 0.00 at the midpoint and 0.00 at the end, with the hand-off at 0.00 → 1.00, and the `inert` states swapped accordingly.
- **Reduced motion.** Final values show at once, the page is one viewport tall, and no video is loaded.
- **LCP.** The element is the headline span "Flight Delay", at 152-188 ms on the dev server.
- **Bundle.** The eager entry chunk grew from 85.0 KB to 174.7 KB gzip. Before the change, Motion only loaded with the lazy dashboard pages; now the hero needs Motion's core at first load.
- **Chunk-splitting experiment.** I tried a rolldown chunk group to move Motion's layout and drag features out of the entry. It saved about 20 KB, but the entry still imports Motion's projection core through the `m` components, so I reverted it.

**Not done.** Reaching a small hero bundle would need a different split: a CSS-only entrance in the eager chunk, plus a lazily loaded Motion layer for parallax, the scroll stage and the magnetic button. That is offered to the user as a follow-up.

**Bug found and fixed during the build.** Motion moves array-mapped `useTransform(scrollYProgress, …)` opacity onto a native ViewTimeline. On the sticky stage its range was wrong: the content faded and then snapped back to opacity 1, and the hand-off never appeared. Function transforms keep these values on Motion's JS path. The hero also uses `m` components under `LazyMotion` with `domAnimation`.

### Intro hero: CSS entrance and a lazy Motion layer (2026-10-16, follow-up)

**The user asked for this after the first hero commit.** The split is:
- **Eager path, with no animation library:**
  - CSS keyframes play the headline mask, the path draw and the background loops;
  - the Web Animations API plays the rise and hairline entrances;
  - requestAnimationFrame drives the count-ups and the plane loop.
- **Lazy chunk:** `web/src/components/hero/enhance.ts` (4.4 KB gzip plus a shared 9.5 KB Motion core) loads once the browser is idle after first paint. It adds mouse parallax, the scroll stage with its hand-off, and the magnetic primary action, using Motion's framework-free API (`motionValue`, `springValue`, `styleEffect`, `scroll`).
- **Reduced motion:** the Motion chunk is never requested; verified in Playwright, 0 requests.

**Bundle sizes, corrected.** Eager JS = the entry chunk plus the chunks `index.html` preloads, gzip:

| Build | Eager JS (gzip) |
|---|---|
| Before the hero work | 124.8 KB (84.1 KB entry + a preloaded 40.7 KB chunk) |
| First hero commit (`f64f4b0`) | 172.7 KB |
| Now | 128.2 KB |

The earlier entry for this upgrade quoted 85.0 KB → 174.7 KB. That compared the entry chunk alone and missed the preloaded chunk, so the real first-commit increase was +47.9 KB, not +90 KB. After this change the hero costs +3.3 KB eager.

**Bug found while verifying.** Motion's framework-free `scroll(cb, { target, offset })` is driven by a native ViewTimeline that mis-ranges this sticky stage: progress stalled at 0.5 at the bottom of the scroll. A two-argument callback stays on Motion's JS path, and progress is now computed from `info.y.current` and the stage's offset and height.

**Verified** in Playwright with the tab in front. A backgrounded Playwright tab is throttled to 1-3 fps, which first looked like a page performance problem; the unchanged Overview page measured the same.
- **Entrance:** all stats in by +1.5 s.
- **Scroll stage:** content opacity 1.00 at 0, 0.00 at 360 px, and 0.00 at 720 px with `inert`. The hand-off is at 0.67 at 540 px and 1.00 at 720 px. The background reaches scale 1.08 and blur 6px. The cue hides while scrolling and returns at the top.
- **Parallax and magnet:** transforms apply.
- **Layout:** no overflow and CTAs inside the first viewport at 1440, 768 and 390 px; no console errors.

**LCP.** The headline paints first, at about 310-400 ms on the dev server. Chrome's final LCP element is now the subline paragraph, at about 760-880 ms: it is a larger text block, and it becomes visible at its scheduled 0.45 s entrance. Neither waits on the video, which is created on idle. Making the headline the LCP element again would mean one text block for the headline, which loses the line-by-line mask. That trade-off was left to the user.

### Landing redesign: night-orbit globe and scroll story (2026-10-17)

**Asked for:** a cinematic, aviation-themed landing page with a 3D globe of flight routes, scroll transitions and parallax, inspired by motionsites.ai. The user picked three options in a question round:
- a hero plus a scroll story;
- the most and least delay-prone routes as the globe's arcs;
- a night orbit that replaces the dusk video.

**What was built:**
- **Globe.** `web/src/components/globe/` uses React Three Fiber and three.js. It draws 110m Natural Earth coastlines (`world-atlas`), airports at their real coordinates, and 20 route arcs: the 10 worst and 10 best routes with at least 1,000 flights, from `/api/analytics/delay-rate?by=route`.
- **Chapters.** `web/src/components/landing/` holds six full-viewport chapters, each re-framing the globe.
- **Geometry.** The pure geometry (`geo.ts`) covers lat/lon to vector, great-circle arcs, chapter-from-scroll and aspect-aware framing. It is unit-tested without WebGL (20 tests).

**API change (additive).** `/api/meta` airports now carry `latitude` and `longitude`, from airports.csv; they are null where the file has none (3 of 322). The integration test asserts both cases. No consumer breaks; Predict ignores the new fields.

**Removed:**
- `HeroSection.tsx`, `hero/HeroBackground.tsx` and `hero/enhance.ts`;
- the dusk video and poster (`web/public/videos/`, 7.5 MB);
- the scroll cue.

`hero/HeroStats`, `hero/HeroActions` and `hero/entrance` are kept: the headline mask, count-ups, stat captions and magnetic action carry over unchanged.

**Bundle (gzip):**

| Chunk | Size | Loaded |
|---|---|---|
| Eager JS | 129.6 KB before, 131.7 KB now | at first paint |
| Globe | 258 KB (three.js, R3F, coastlines) | lazily, once the browser is idle |
| Motion layer | 7.4 KB | lazily, once the browser is idle |

**Simplest options taken:**
- **No new endpoint.** Two calls to the existing delay-rate ranking (`order=worst` and `order=best`) instead of a "busiest routes" endpoint.
- **No drei.** Everything is drawn with plain three.js and R3F.
- **Readout wording.** The delay rate is stated as a share of completed flights, matching the API formula, with the scheduled count beside it.

**Dev note.** `optimizeDeps.include` in `web/vite.config.ts` pre-bundles three, R3F, topojson-client and motion. Without it, Vite discovered them when the lazy chunk first loaded and re-bundled React mid-session, which put two React copies on the page and gave an "Invalid hook call" in the canvas.

### Landing globe: interaction, motion and material pass (2026-10-17)

**Asked for:** a more immersive and interactive globe. The request listed:
- auto-rotation, mouse rotation and zoom;
- glowing animated paths and moving aircraft, pulsing airports;
- hover tooltips, atmosphere and realistic lighting;
- a cinematic camera, scroll-linked motion, and route details on selection;
- all without breaking reduced motion or performance.

**Built** (`web/src/components/globe/`, split into `Earth`, `Airports`, `Routes`, `shaders`, `store` and the `GlobeScene` rig):
- **Lighting and atmosphere:** a view-space sun with a terminator, a glint and a warm sunrise rim, plus an inner haze and an outer halo.
- **Arcs:** a comet trail with a halo tube; glow without post-processing, so no extra dependency.
- **Aircraft and airports:** instanced aircraft synced to the pulse; endpoint rings; tooltips on airport and route hover.
- **Selection:** a selected-route panel, and a fly-to that zooms by route length.
- **Controls:** drag, Ctrl/Cmd + wheel and double-click zoom, plus an accessible zoom/reset button group.
- **Motion:** the establishing shot, idle auto-rotation in the later chapters, sway in the story chapters, and a cursor bank.

**Decisions:**
- **Zoom needs a modifier.** Plain wheel zoom would trap page scroll on a full-viewport globe. Ctrl/Cmd + wheel, double-click and the buttons cover zoom; the plain wheel still scrolls the page (verified).
- **Auto-rotation is chapter-dependent.** Continuous spin in the hero would turn the only data (US routes) away half the time. The hero to Predict chapters sway around the US; the model and hand-off chapters spin, settling on a whole turn when they leave.
- **Selection-only figures.** The panel shows only values the ranking row already carries (rate, completed, scheduled, average arrival delay) and a great-circle distance computed from airports.csv coordinates. That distance is labelled as such, not presented as flown distance.
- **Predict accepts `?origin=&dest=`.** `seedForm` moved to `web/src/lib/predictForm.ts` with tests. Unknown airports or a same-airport route fall back to the defaults. Existing behaviour without params is unchanged.

**Bugs found while verifying:**
- **`<main>` swallowed pointer events.** It was hit-testable although its sections were `pointer-events-none`, so the canvas never received a pointer event; hover had silently never worked. `<main>` is now `pointer-events-none` too, with interactive copy opted back in.
- **Steered routes landed off-centre.** With the globe off-centre and the camera close, the camera-facing point projects well outside the middle of the visible disc. An outer group now aims the faced point at the camera while steering.

**Verified** in Playwright at 1440×900 with the tab in front: hover on arcs and airports, click to select, Escape, Ctrl + wheel zoom, drag, and plain-wheel page scroll all work, at 61 fps. At 390 px there is no overflow and the controls are hidden. Under reduced motion the still frame updates on selection, no Motion chunk loads, and the console is clean.

**Bundle (gzip):** the globe chunk is 261.1 KB (was 258 KB); eager JS is 133.7 KB (was 131.7 KB; the HUD and store are eager).

### Landing globe: US-focused composition (2026-10-18)

**Asked for:** a globe framed on the United States (the dataset is US domestic only), with:
- richer interactive airport markers;
- animated routes and glowing aircraft particles driven by real values;
- route selection, smooth camera moves and cinematic lighting;
- other continents dimmed, Alaska and Hawaii shown only where useful;
- no fabricated data, and good on desktop and mobile.

**Built:**
- **Camera:**
  - a 16-degree lens;
  - chapter poses over the lower 48, with Alaska and Hawaii only in the volume chapter;
  - a lean (tilt about the framed point) so data columns stand up;
  - an establishing shot that descends from the whole planet;
  - fly-to framing for a selected route (by length) and a selected airport (its network's extent).
- **Geography:** US coast, borders and state lines from `us-atlas` (1:10M Census). There is a land fill texture with the US lifted. Other coasts, land and the graticule fade with distance from the US.
- **Airport columns:** height is 2015 departures (linear); colour is the delay rate against the national rate. Hover shows departures and rate; click selects.
- **Airport selection:** the 12 busiest destinations from `/api/routes` as arcs; a details panel with a destination board linking to Predict prefilled.
- **Moving lights** on every arc, one per 1,000 scheduled flights.
- **Map key** with the real thresholds.

**Decisions:**
- **Airport figures from two existing calls, not a new endpoint.** `/api/analytics/delay-rate?by=origin` caps at 100 rows, so the worst and best ends are fetched at `minFlights=2000`. At 2,000 the two ends overlap (193 airports; measured: 7 in both), which proves the merged list is complete. At 1,000 they would not overlap (exactly 200, no proof). `mergeAirportRankings` reports `complete`, and the key says "partial list" if it ever is not. 192 of the 193 have coordinates and get a column; the key counts those.
- **Colour encodes the gap to the national rate**, with full amber or blue at ±8 points, so the Paired Encoding Rule holds (amber = more delay). Near the national rate a column is warm ink, not a data colour.
- **Linear column height.** A square-root scale would flatter small airports; the column is a bar chart on the map, so it stays linear.
- **Network arcs are warm ink.** `/api/routes` gives flights per destination but no delay rate, so these arcs carry no delay colour. Their ids are prefixed `net:` so they never collide with a ranked route.
- **Moving-light density is stated in the key** (one per 1,000 flights, 1 to 14 per route) so it is an encoding, not decoration.
- **New dependency `us-atlas` 3.0.1** (ISC, Census data), loaded only in the lazy globe chunk. The `world-atlas` source moved from `land-110m` to `countries-110m`, so US coasts can be left to the finer outline.
- **Eager bundle stays three-free.** The map key's colours come from `globe/palette.ts` (plain hex), not from the three.js colour objects.

**Bug found while verifying (pre-existing):** React Three Fiber 9 copies every uniform object passed in `uniforms` (`events-*.esm.js`, "ShaderMaterial uniforms must keep a stable target reference"). The shared `LIVE` uniforms were therefore frozen at their first value in every material:
- the arc comet pulses never moved (the CPU-driven aircraft did);
- airport twinkle and ring pulses were still;
- per-chapter arc and airport dimming never applied.

It showed up because the new columns read `uTime` for their grow-in and stayed flat. `shaders.linkLive` now re-links the shared uniforms onto each material in its ref callback.

**Verified** in Playwright with the dev server and live API:
- **Desktop (1440×900):** all six chapters; hover and click on an ATL column (379,424 departures, 15.8% late, 169 destinations, 12 drawn); DCA→JFK selection from the board; Escape.
- **Mobile (390×844):** hero, volume and routes chapters, no horizontal overflow.
- **Reduced motion:** a still frame with full-height columns and no moving lights.
- **Console:** clean.

Screenshots: `docs/screenshots/landing-us-focus-desktop.png`, `landing-us-focus-mobile.png`, `landing-airport-network.png`.

**Bundle (gzip):** the globe chunk is 320.6 KB (was 261.1 KB; us-atlas states and the countries topology account for most of it); eager JS is 135.7 KB (was 133.7 KB), still with no three.js.

### Predict form, landing hand-off and globe lighting (2026-10-18)

**Asked for:**
- a premium redesign of the Score a flight card and the landing's last section;
- a fix for the globe going almost black as it rotated (the hand-off chapter showed the Indian Ocean with barely visible coasts);
- the US kept in view during auto-rotation.

**Globe:**
- **Rotation:** the model and hand-off chapters no longer spin freely. Every chapter now sways around the US (`sway` in the pose table: 3 to 5 degrees close up, 14 in the model chapter, 22 in the hand-off), so North America never leaves the visible face. `geo.nearestTurn` and its test went with the spin.
- **Lighting:**
  - a hemisphere ambient floor;
  - an emissive coast glow baked into the land texture's blue channel (cut edges along the antimeridian and the pole are skipped, so they never glow);
  - fine grain on land;
  - a rim, halo and haze that keep a floor on the night side;
  - line work that keeps at least 72% of its alpha on the night side and 60% away from the US.

  Values stay low: verified not overexposed in the hero.

**Predict form:**
- **Rich fields over real selects, not a custom listbox.** A custom dropdown would have to re-implement keyboard handling, type-to-jump, screen-reader semantics and phone pickers. The native select sits invisibly over a drawn face instead, which fixes the truncated "LAX Los Angeles International Airport · 8,7..." by moving the flight count to its own line.
- **Layout and labels:**
  - The order is now route, airline, then date and hour. All five fields, validation, the `?origin=&dest=` seeding and the destination-follows-origin logic are unchanged.
  - The submit button names the route.
  - The weekday beside the date comes from `weekdayOf` in `lib/format.ts`, which is tested and computed in UTC.
- **Design rules:**
  - Amber is used only for interaction (focus halo, hover edge on submit) and the panel's faint evening light, which keeps the Colour Is Data rule for content.
  - The panel stays the one glass surface. It has no drop shadow, so the flat system holds; the only new glow is the submit's hover.

**Hand-off:** each page link shows one live figure:
- the delay rate (`/api/analytics/summary`);
- the largest cause share of delay minutes (`/api/analytics/causes`);
- the flight count (`/api/meta`);
- the tuned threshold and the served model's test ROC-AUC (`/api/model/metrics`).

A loading figure shows a skeleton; a failed one is omitted, so the link still works. Below lg it is a two-column board, which keeps the stack short enough on phones that it no longer runs under the map key.

**Verified** in Playwright against the running dev servers:
- **Predict:** 1440 and 390 px. The amber focus halo appears on keyboard focus, and ORD→LAX scored end to end ("Likely delayed, 31.4%").
- **Under reduced motion:** the card shows at full opacity.
- **Hand-off:** 1440, 1024 and 390 px, with no horizontal overflow.
- **Globe:** model and hand-off chapters after 3 s and 18 s of idle, with the US in view both times.

Screenshots: `docs/screenshots/predict-form.png`, `predict-form-mobile.png`, `landing-handoff.png`, `landing-lighting-hero.png`.

### Predict: custom dropdowns and calendar (2026-10-18)

**Asked for:**
- consistent custom dark dropdowns (airline, origin, destination, hour) and a custom calendar;
- search where it helps, month/year navigation, selected and disabled date styling, no clipping;
- keyboard and screen-reader support;
- existing data, validation, the 2015 date range and scoring logic unchanged.

**Built** in `web/src/components/predict/`:
- `FlightSelect` (listbox, searchable for origin, destination and airline);
- `DatePicker` (date-picker dialog with day and month views);
- `usePopover` (portal placement);
- pure logic in `web/src/lib/picker.ts` with 13 tests (search ranking, type-ahead, UTC date arithmetic, month grid).

**Decisions:**
- **No new dependency.** No headless UI library is installed, and adding one for four fields was not worth it. The components follow the WAI-ARIA listbox and date-picker dialog patterns directly.
- **Portal and fixed positioning.** Each field group animates in with a transform, which creates a stacking context, so an absolutely positioned popover in one group would sit under the next group. A portal avoids that, plus any future clipping. The popover flips above when there is more room there and follows the field on scroll.
- **Search ranking:** exact code, then code prefix, then word start, then contains. Within a rank the API order holds, so destinations stay busiest-first. This keeps the old "type a code to jump" behaviour and adds city and name search.
- **Bounds:** the calendar is limited to `MIN_DATE`..`MAX_DATE` (2015). Navigation clamps, and out-of-range days and months are disabled. `validate()` still checks the date on submit.
- **Focus moves in a layout effect**, not on the next frame. In a background tab a frame can take hundreds of milliseconds, and the first keystrokes then landed on the field instead of the search box.
- **Accessible names.** A `<label>` alone names a button by the label only, so the triggers use `aria-labelledby` for the label plus a comma-separated spoken value.

**Verified** in Playwright against the running dev servers:
- **Desktop (1440×900):**
  - search and Enter (DEN, SEA), mouse selection, and arrow keys on destination;
  - type-ahead on hour (21:00);
  - calendar PageUp/arrows/Enter (22 Nov), clamping at December with "Next month" disabled, and the month view;
  - Escape, Tab, click outside;
  - a successful score (SEA→ANC, 22.4%).
- **Mobile (390×844):** the dropdown and calendar fit the viewport (calendar 304px wide at x=40).
- **Reduced motion:** the popover is fully visible at once.
- **Console:** no errors.

Screenshots: `docs/screenshots/predict-dropdown.png`, `predict-calendar.png`.
