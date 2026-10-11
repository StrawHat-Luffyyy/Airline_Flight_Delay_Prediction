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
- **Error middleware moved to `server/src/middleware/error.ts` (§4, §9).** Malformed JSON returned 500 and echoed the parser message. 4xx errors from the body parser now return `400 { error: { code: "BAD_REQUEST", message } }`. Unexpected errors return a fixed `"Internal server error"` and log the real error, so internal messages (e.g. connection strings) never reach clients. `ErrorResponseSchema` (with optional `details`) is now in `shared/`.
- **Tests no longer need a local `.env` (§14 CI).** The test import chain reaches `config/env.ts`, which threw without `.env`. Root `vitest.config.ts` now supplies test env values. Verified by running `npm test` with `.env` moved away.
- **Env parsing is testable.** `config/env.ts` exports `parseEnv(record)`. `env` is still validated at import, so startup behaviour is unchanged. dotenv's banner is silenced with `quiet: true`.
- **The Mongo client singleton is race-free.** Concurrent `connectToMongo()` calls could each create a client. The in-flight connect promise is now cached and cleared on failure.
- **Web TypeScript is strict (CLAUDE.md "strict everywhere").** Added `"strict": true` to `web/tsconfig.json`. This is a config-only change: it produced 0 new errors, and the web build still passes. No web source was changed.
- **Prettier is runnable (§5).** Added the root `format` / `format:check` scripts. Set `endOfLine: "auto"`, because `core.autocrlf=true` on Windows makes every working-copy file CRLF.
- **Lint covers tests.** The lint script is now `eslint server shared` (it was `server/src shared/src`).
- **Node version is declared (§2).** Added `"engines": { "node": ">=20" }`.
