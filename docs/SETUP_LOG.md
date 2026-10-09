# Setup log

## Result

Created the Phase 0 monorepo scaffold on branch `setup/scaffold`. The frontend was moved without content changes in the first commit. Added npm workspaces, TypeScript and lint configuration, local MongoDB Compose service, validated server configuration, Mongo client helpers, the health endpoint and its test, shared health schema, environment example, and setup documentation. The local `.env` is ignored and remains untracked. No data, ingestion, analytics, machine-learning, feature, or mock-data code was added.

The web package was renamed to `@flight-delay/web`; `web/vite.config.ts` only gained the requested `/api` proxy. `web/tsconfig.json` and frontend source, pages, and styles remain unchanged.

The first commit was `71c8ba2 chore: move AI Studio frontend into web/`; its diff contained 26 renames and zero insertions/deletions. The second commit configures the npm workspaces and local tooling. The final server/shared implementation is committed separately.

## Setup commands

```text
COMMAND: git switch -c setup/scaffold
Switched to a new branch 'setup/scaffold'

COMMAND: npm run build --prefix web
✓ 2080 modules transformed.
✓ built in 12.42s
EXIT: 0

COMMAND: npm install
added 272 packages, changed 1 package, and audited 460 packages in 31s
3 vulnerabilities (1 moderate, 2 critical)

COMMAND: npm ls typescript --depth=0
Root typescript@5.9.3; server dedupes to 5.9.3; existing web dependency remains typescript@7.0.2.
```

The install audit summary is recorded as reported; dependencies were not changed in response because dependency auditing/upgrades were outside this scaffold request. Root and server use TypeScript 5 as requested.

## Shared workspace resolution check

Temporary `web/src/__shared_check.ts` imported `HealthResponse` from `@flight-delay/shared` and used it in an exported const. The file was deleted after the checks and is not committed.

```text
COMMAND: npx tsc --noEmit -p web/tsconfig.json
EXIT: 0

COMMAND: npm run build -w @flight-delay/web
> @flight-delay/web@0.0.0 build
> vite build
✓ 2080 modules transformed.
✓ built in 349ms
EXIT: 0
```

## Acceptance checks

### MongoDB

The first `docker compose up -d mongo` attempt failed because Docker Desktop was not running:

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running
```

Started Docker Desktop, then reran:

```text
COMMAND: docker compose up -d mongo
Container 2015flightdelaysandcancellations-mongo-1 Running

COMMAND: docker inspect --format "{{.State.Health.Status}}" 2015flightdelaysandcancellations-mongo-1
healthy
```

### Typecheck, lint, and tests

An initial `npm run typecheck` exposed that `shared/package.json` lacked a `typecheck` script. Added that script, then reran the root command successfully. It runs TypeScript checks for server, shared, and web.

An initial `npm run lint` found the unused Express error-handler `next` argument. Marked it as intentionally unused, then reran lint successfully. ESLint covers only `server/` and `shared/`.

Final results:

```text
COMMAND: npm run typecheck
EXIT: 0
Server, shared, and web TypeScript checks passed.

COMMAND: npm run lint
EXIT: 0

COMMAND: npm test
 ✓ server/tests/health.test.ts (1 test)
 Test Files  1 passed (1)
      Tests  1 passed (1)
EXIT: 0
```

### API and dev proxy

The first server start looked for `.env` relative to the `server/` workspace working directory and failed validation. Updated the loader to resolve the root `.env` from the module location and restarted:

```text
COMMAND: npm run dev -w @flight-delay/server
◇ injected env (4) from ..\.env
Flight delay API listening on port 3001

COMMAND: curl.exe -sS http://localhost:3001/api/health
{"status":"ok","mongo":"up","modelLoaded":false}

COMMAND: npm run dev
Both @flight-delay/server and @flight-delay/web started successfully.

COMMAND: curl.exe -sS http://localhost:3000/api/health
{"status":"ok","mongo":"up","modelLoaded":false}
```

### Web build

```text
COMMAND: npm run build -w @flight-delay/web
✓ 2080 modules transformed.
✓ built in 433ms
EXIT: 0
```

Vite printed its existing warning that `__dirname` in `web/vite.config.ts` will be unsupported by a future native config loader. The file was changed only to add the requested proxy.

### Ignore and repository state

```text
COMMAND: git check-ignore -v data/raw/flights.csv .env
.gitignore:7:data/    data/raw/flights.csv
.gitignore:4:.env     .env

COMMAND: git status --short
No `data/` or `.env` paths were staged or reported.
```

`bun.lock` was tracked and was deleted as requested. `dist/` was not tracked. The generated root `package-lock.json` is committed; no Bun or Yarn commands were used.

## Gemini and API-key occurrences in `web/`

Search command: `rg -n --hidden -i -g '!node_modules/**' -g '!dist/**' 'gemini|api.?key|@google/genai' web`

- `web/package.json:14` — dependency `"@google/genai": "^2.4.0"`
- `web/metadata.json:5` — `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API`

No `GEMINI_API_KEY` or other API-key occurrence was found under `web/`. Both occurrences above were left unchanged.

## Deviations and incomplete work

- No scope or layout deviations from the request. The workspace-resolution ambiguity was resolved as instructed: web uses npm workspace package resolution, while TypeScript `paths` applies to server/shared; `web/tsconfig.json` was not edited.
- The first Docker, typecheck, lint, and server-start attempts exposed environment/setup issues documented above. Each was corrected and the acceptance command then passed.
- Nothing remains incomplete.

## Follow-up: requested Vite URL

The initial scaffold kept the AI Studio dev port 3000. Changed only the `web` dev script to port 5173 so the supplied URL works directly; the server route and `/api` proxy were already implemented. Updated the README to match.

```text
COMMAND: npm run dev
VITE v8.3.3 ready
Local: http://localhost:5173/
Flight delay API listening on port 3001

COMMAND: curl.exe -sS -i http://localhost:5173/api/health
HTTP/1.1 200 OK
{"status":"ok","mongo":"up","modelLoaded":false}
```

The dev processes were left running after this successful check.
