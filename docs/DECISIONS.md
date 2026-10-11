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
