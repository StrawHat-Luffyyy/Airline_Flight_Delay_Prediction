# Flight Delay Prediction

College Big Data project scaffold for the 2015 Flight Delays and Cancellations dataset.

## Prerequisites

- Node.js 20 or newer and npm
- Docker Desktop with Docker Compose

## Setup

From the repository root, create the local environment file and install the workspaces:

```powershell
Copy-Item .env.example .env
npm install
```

Start the local MongoDB service:

```sh
docker compose up -d mongo
```

Download the dataset into `data/raw/` (see [scripts/download-data.md](scripts/download-data.md)), then load it into MongoDB:

```sh
npm run ingest            # first load; refuses if flights already has data
npm run ingest -- --drop  # rebuild from scratch
```

Other flags: `--append` adds to existing data, `--limit N` loads only the first N flight rows, and `--dir PATH` reads the CSVs from another folder. Each run is recorded in the `ingest_runs` collection.

### Data pipeline order

Run these in order after downloading the data (later steps arrive with later phases):

1. `npm run ingest -- --drop`: load the CSVs.
2. `npm run resolve:airport-ids -- --apply`: map October's numeric BTS airport ids to IATA codes. Without `--apply` it only reports. The raw ids are kept in `originAirportId` / `destAirportId`. The mapping and its evidence are written to `docs/airport-id-map.json` and the `resolve_runs` collection.
3. `npm run build:indexes`: create the PROJECT_OVERVIEW §6.2 indexes on `flights`. This is idempotent: existing indexes are skipped and none is ever dropped. It logs the build time per index and the collection sizes before and after.
4. `npm run build:stats`: rebuild the pre-aggregated `stats_*` collections from `flights` with `$group` + `$merge`. This is idempotent: documents from older builds are deleted after each merge. Each run is recorded in `stats_runs`. The API's analytics endpoints read only these collections.
5. `npm run build:lookup`

Re-running `ingest -- --drop` drops `flights` along with its indexes and brings back the numeric ids, so run steps 2-4 again after every re-ingest.

`npm run explain:report` runs the representative queries with `explain("executionStats")`, once as a forced collection scan and once with the default plan. It also times every API endpoint with the cache off, then rewrites `docs/EXPLAIN_RESULTS.md` from the measured numbers. Run it after `build:indexes` and `build:stats`.

### API

All endpoints are `GET` under `/api`. Errors use the shape `{ error: { code, message, details? } }`, and invalid query parameters return `400 VALIDATION_ERROR`. Analytics responses are cached in memory for 10 minutes.

| Endpoint | Parameters |
|---|---|
| `/health` | none |
| `/meta` | none: row count, date range, airlines, airports |
| `/analytics/summary` | none: flights, delay rate, average arrival delay, cancel rate |
| `/analytics/causes` | `by=overall\|airline\|airport\|month\|hour`, `limit` (≤ 100) |
| `/analytics/delay-rate` | `by=airline\|origin\|route\|dow\|hour`, `minFlights` (default 500), `limit` (≤ 100), `order=worst\|best` |
| `/analytics/trend` | `airline` or `origin` (not both), `granularity=day\|month` |
| `/analytics/cascade` | none: late-aircraft share of delay minutes by hour |
| `/analytics/cancellations` | `by=overall\|airline\|month` |
| `/analytics/delay-distribution` | none: arrival-delay histogram |
| `/flights` | `airline`, `origin`, `route`, or `from` + `to` (YYYY-MM-DD) required; `dest` only together with `origin` or `route`; `limit` (≤ 100), `cursor` (the previous page's `nextCursor`) |

Start the Express API and Vite frontend together:

```sh
npm run dev
```

The API listens on `http://localhost:3001`; the frontend listens on `http://localhost:5173` and proxies `/api` requests to the API.

## Useful commands

```sh
npm run typecheck
npm run lint
npm run format:check   # npm run format to fix
npm test
npm run build:web
```

The dataset is kept under `data/` and is not tracked by Git.
