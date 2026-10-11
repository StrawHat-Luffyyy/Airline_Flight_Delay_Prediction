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

- **Numeric airport ids are kept and flagged.** In the full load, 486,165 rows use 5-digit BTS airport ids instead of IATA codes (§3), all of them in October, for both origin and destination. Rows are kept with `originIsIata` / `destIsIata: false`, the code stored as-is, and null city/state, so the test split (Oct-Dec) is not hollowed out. Airport-level analytics and lookups (Phases 3-4) must filter `originIsIata: true` / `destIsIata: true` or treat these as unknown. No offline id-to-IATA mapping is available, so none is invented.
- **Extra fields beyond §6.1:** `originIsIata`, `destIsIata` (above) and `elapsedTime` (kept for analysis; it is a forbidden model feature per §7, like the other post-departure fields).
- **`dayOfWeek` is derived from the UTC date** (1 = Monday ... 7 = Sunday), not copied from `DAY_OF_WEEK`, so it is always consistent with `date`.
- **`isDelayed` is null** when the flight was cancelled or diverted, or when `ARRIVAL_DELAY` is blank. Otherwise it is `arrDelay >= 15`.
- **`causes` is null when all five cause columns are blank.** Otherwise each cause is a number or null. Blanks are never stored as 0 (§3).
- **`2400` schedule times mean midnight:** `schedDepMin = 0`, `schedDepHour = 0`, the same calendar day.
- **Rejected rows** are counted by reason in `ingest_runs.rejectReasons` and never abort the load. The reasons are: missing columns, invalid date, unknown airline, bad flight number, bad airport code, bad scheduled departure/arrival, bad distance, a non-numeric value, a bad 0/1 flag, or a bad cancellation reason. Unknown IATA airports are kept with null city/state rather than rejected.
- **Reference data** (`airlines`, `airports`, `_id` = IATA) is re-read in full on every run and upserted by `_id`, so it is idempotent. The files are tiny (14 + 322 rows), so holding them in memory is fine. Each file also gets an `ingest_runs` record.
- **Modes:**
  - `--drop` drops `flights` before loading.
  - `--append` adds to it.
  - With neither flag the load refuses when `flights` is non-empty (§6.4).
  - `--limit N` (smoke runs) and `--dir PATH` were added for testing. They do not change these semantics.
- **`ingest_runs` documents** add `status`, `mode`, `peakRssMb` and `error` to the §6.1 fields. Peak RSS is sampled every second and after each batch, as evidence for the ~500 MB acceptance limit. A failed load is recorded with `status: "failed"` and the counts so far.
- **Indexes are not built by ingest.** §6.4 says to create them after the bulk load, and Phase 2 owns `build:indexes`.
