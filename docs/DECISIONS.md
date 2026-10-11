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
