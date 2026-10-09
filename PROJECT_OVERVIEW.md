# Airline Flight Delay Prediction — Big Data Project

> Audience: Claude Code. Read this whole file before writing code. Build in the phase order in section 11. Do not skip acceptance criteria. When a decision is not specified here, choose the simplest option that satisfies the constraints in section 2 and record the decision in `docs/DECISIONS.md`.

---

## 1. Goal

Use a large historical flight dataset (millions of rows) to:

1. **Predict** whether a flight will arrive late (binary classification, delay >= 15 min per the US DOT definition).
2. **Explain** delays: identify the major causes and where/when they concentrate (airline, airport, route, month, hour).
3. **Expose** both through a REST API and a dashboard.

This is a college Big Data subject project. The grading story is: *large volume data, ingested at scale, stored and queried efficiently in MongoDB, analysed with aggregation pipelines, used to train and serve a predictive model.* Every design choice should make that story easy to demonstrate and document.

## 2. Hard constraints

| Constraint | Detail |
|---|---|
| Database | **MongoDB is mandatory** and must be the system of record for flights and all analytics results. |
| Language | **TypeScript everywhere** in the app (strict mode). The only allowed non-TS code is one offline Python training script (section 7). |
| Backend | Node.js 20+, Express.js |
| Frontend | React + Vite + TypeScript |
| Data scale | Must handle >= 5 million flight records. Never load the full dataset into memory. |
| Runtime | Everything runs locally via Docker Compose. No paid services. |

Do not use Mongoose. Use the **official `mongodb` Node driver** (aggregation pipelines and bulk writes are central to the project and are cleaner without an ODM). Use **zod** for validation of env, request params and CSV rows.

## 3. Dataset

**Primary: Kaggle "2015 Flight Delays and Cancellations"** (derived from the US BTS On-Time Performance data). About 5.8M rows in `flights.csv`, plus `airlines.csv` and `airports.csv`.

Relevant `flights.csv` columns (UPPER_SNAKE_CASE in the source):

- Time: `YEAR, MONTH, DAY, DAY_OF_WEEK`
- Carrier/route: `AIRLINE` (IATA code), `FLIGHT_NUMBER, TAIL_NUMBER, ORIGIN_AIRPORT, DESTINATION_AIRPORT`
- Schedule vs actual: `SCHEDULED_DEPARTURE, DEPARTURE_TIME, DEPARTURE_DELAY, SCHEDULED_ARRIVAL, ARRIVAL_TIME, ARRIVAL_DELAY, SCHEDULED_TIME, ELAPSED_TIME, AIR_TIME, DISTANCE, TAXI_OUT, TAXI_IN`
- Status: `CANCELLED, CANCELLATION_REASON, DIVERTED`
- **Cause columns (minutes)**: `AIR_SYSTEM_DELAY, SECURITY_DELAY, AIRLINE_DELAY, LATE_AIRCRAFT_DELAY, WEATHER_DELAY` (only populated when the flight arrived 15+ min late)

Gotchas the ingestion code must handle:
- Times are `HHMM` integers (e.g. `5` = 00:05, `2400` can occur). Convert to minutes-from-midnight and an hour-of-day.
- Many airport codes in the source are numeric (5-digit) for a subset of rows; drop or flag them (`originIsIata: false`) rather than crash.
- Empty strings for nulls. Cancelled/diverted flights have no arrival delay.
- Cause columns are blank when not applicable: store as `null`, not `0`, then treat `null` as 0 only inside the cause-analysis pipelines.

Put the files in `data/raw/` (git-ignored). Include `scripts/download-data.md` explaining the manual Kaggle download (no API key assumptions).

## 4. Architecture

```
            +-----------------------+
 CSV files  |  Ingestion pipeline   |   stream parse -> validate -> transform -> bulk insert
 (data/raw) |  (TS CLI, streaming)  |
            +-----------+-----------+
                        v
                +---------------+      aggregation pipelines
                |   MongoDB     | <---------------------------+
                |  flights      |                             |
                |  airlines     |   +-------------------+     |
                |  airports     |   | Analytics service |-----+
                |  *_stats      |   +-------------------+
                |  model_runs   |            ^
                +-------+-------+            |
                        |             +------+--------+      +----------------+
   export training set  |             |  Express API  | <--- |  React dashboard|
                        v             |  (TypeScript) |      +----------------+
              +--------------------+  +------+--------+
              | Python train script|         | inference
              | (offline, 1 file)  |         v
              +---------+----------+   onnxruntime-node loads model.onnx
                        | model.onnx + metrics.json
                        +--------------------------------------^
```

Monorepo layout (npm workspaces):

```
flight-delay/
  docker-compose.yml
  package.json                # workspaces: server, web, shared
  tsconfig.base.json
  .env.example
  README.md
  PROJECT_OVERVIEW.md         # this file
  docs/
    DECISIONS.md
    BIGDATA_JUSTIFICATION.md  # report material (section 10)
    SCHEMA.md
  data/raw/                   # git-ignored
  data/export/                # git-ignored (training CSV)
  shared/                     # shared TS types + zod schemas
  server/
    src/
      config/                 # env (zod), mongo client singleton
      db/                     # collection accessors, index creation, migrations
      ingest/                 # CLI: parse, transform, load
      analytics/              # aggregation pipeline builders (one file per analysis)
      features/               # feature engineering + lookup-table builder
      ml/                     # onnx loader, predictor, feature encoder
      routes/                 # express routers
      middleware/             # error handler, validation, request logging
      app.ts / server.ts
    tests/
  ml/
    train.py                  # the only Python file
    requirements.txt
    artifacts/                # model.onnx, encoders.json, metrics.json (committed, small)
  web/
    src/ (pages, components, api client, charts)
```

## 5. Tech stack

- **Server:** Node 20, TypeScript (strict), Express 4/5, `mongodb` driver, `zod`, `pino` + `pino-http`, `csv-parse` (streaming), `onnxruntime-node`, `helmet`, `cors`, `express-rate-limit`, `dotenv`
- **Tooling:** `tsx` for dev, `vitest` + `supertest` for tests, ESLint + Prettier
- **Web:** React 18, Vite, TypeScript, `@tanstack/react-query`, `recharts`, Tailwind CSS
- **Data/ML:** MongoDB 7 (Docker), Python 3.11 with `pandas`, `scikit-learn`, `lightgbm`, `skl2onnx` / `onnxmltools` (offline only)
- **Infra:** Docker Compose (`mongo`, optional `mongo-express` for inspection)

Atlas free tier (512 MB) will not hold the full dataset. Use the local Docker MongoDB.

## 6. MongoDB design (this is the core of the grade)

### 6.1 Collections

**`flights`** — one document per flight, **denormalized** so analytics never need `$lookup` on the hot path.

```ts
interface FlightDoc {
  _id: ObjectId;
  date: Date;                  // UTC midnight of flight date
  year: number; month: number; day: number; dayOfWeek: number; // 1=Mon..7=Sun
  airline: string;             // IATA, e.g. "AA"
  airlineName: string;         // denormalized from airlines
  flightNumber: number;
  tailNumber: string | null;
  origin: string;              // IATA
  originCity: string | null; originState: string | null;   // denormalized
  dest: string;
  destCity: string | null; destState: string | null;
  route: string;               // `${origin}-${dest}`
  schedDepMin: number;         // minutes from midnight
  schedDepHour: number;        // 0-23
  schedArrMin: number;
  distance: number;
  scheduledTime: number | null;
  depDelay: number | null;     // minutes, negative = early
  arrDelay: number | null;
  taxiOut: number | null; taxiIn: number | null; airTime: number | null;
  cancelled: boolean; cancellationReason: "A"|"B"|"C"|"D"|null;
  diverted: boolean;
  isDelayed: boolean | null;   // arrDelay >= 15 (null if cancelled/diverted)
  causes: {                    // minutes, null when not reported
    carrier: number | null; weather: number | null; nas: number | null;
    security: number | null; lateAircraft: number | null;
  } | null;
  split: "train" | "test";     // time-based split tag, see section 7
}
```

**`airlines`**, **`airports`** — small reference collections (`_id` = IATA code).

**Pre-aggregated "computed pattern" collections** (built by a `npm run build:stats` job using `$group` + `$merge`, so dashboards read small documents instead of scanning 5.8M rows):

- `stats_daily` — `{date, airline, flights, delayed, avgArrDelay, causeMinutes{...}}`
- `stats_route` — `{origin, dest, flights, delayRate, avgArrDelay}`
- `stats_airport_hour` — `{airport, hour, flights, delayRate}`
- `stats_cause_monthly` — `{month, airline, carrier, weather, nas, security, lateAircraft}` (minutes)

**`delay_lookup`** — historical delay rates used as model features (section 7), computed on **train split only**: keyed by `(airline)`, `(origin)`, `(dest)`, `(origin, hour)`, `(route)`, `(airline, month)`.

**`model_runs`** — `{createdAt, modelVersion, algorithm, featureList, trainRange, testRange, metrics{auc, f1, precision, recall, confusion}, featureImportance[]}`

**`ingest_runs`** — `{startedAt, finishedAt, file, rowsRead, rowsInserted, rowsRejected, rejectReasons{}}`

### 6.2 Indexes (create in `db/indexes.ts`, idempotent)

On `flights`:
- `{ date: 1 }`
- `{ airline: 1, date: 1 }`
- `{ origin: 1, schedDepHour: 1 }`
- `{ route: 1 }`
- `{ isDelayed: 1, month: 1 }`
- Partial index on delayed flights with causes: `{ month: 1, airline: 1 }` with `partialFilterExpression: { "causes": { $type: "object" } }`

Every analytics endpoint must be verified with `.explain("executionStats")`. Save the outputs (before/after indexing) in `docs/EXPLAIN_RESULTS.md`. This is report material.

### 6.3 Sharding (design + optional demo)

Single-node is fine for running the app. In `docs/BIGDATA_JUSTIFICATION.md` document the sharding strategy: shard key candidate `{ origin: 1, date: 1 }` (compound; avoids monotonic-key hotspotting on `date` alone while keeping range queries per airport efficient). Optionally provide `docker-compose.sharded.yml` (config servers, 2 shards, mongos) as a stretch goal. Do not make the main app depend on it.

### 6.4 Write path

- Stream CSV -> transform -> batch of **10,000** docs -> `insertMany({ ordered: false })`.
- Respect backpressure (use `for await` over the parser stream; never accumulate unbounded arrays).
- Record rejected rows with reason counters; do not abort on bad rows.
- Ingestion must be **idempotent per run**: support `--drop` to rebuild, otherwise refuse if `flights` is non-empty unless `--append`.
- Create indexes **after** the bulk load (faster).

## 7. Prediction model

**Target:** `isDelayed` (arrival delay >= 15 min). Exclude cancelled and diverted flights from training.

**Split:** time-based, not random. Train = Jan-Sep, test = Oct-Dec (tag in `flights.split`). A random split leaks seasonality and overstates performance.

**Features available at prediction time (no leakage):**
- Calendar: `month, dayOfWeek, schedDepHour`, is-holiday-week flag (simple US holiday list is enough)
- Flight: `airline, origin, dest, distance, scheduledTime`
- Historical rates from `delay_lookup` (train split only): airline delay rate, origin delay rate, dest delay rate, origin x hour delay rate, route delay rate, airline x month delay rate

**Forbidden features (leakage — post-departure information):** `depDelay, taxiOut, taxiIn, airTime, arrDelay, elapsedTime, any causes.*, cancelled, diverted`. If you add a `depDelay`-based "in-flight update" model, make it a clearly separate second model and label it as such. Do not mix.

**Pipeline:**
1. `npm run export:training` (TS) streams flights from MongoDB with the features above into `data/export/train.csv` and `test.csv` using a cursor (no full in-memory load).
2. `python ml/train.py` trains: baseline (majority class), logistic regression, LightGBM. Picks the best by test ROC-AUC. Writes `ml/artifacts/model.onnx`, `encoders.json` (categorical -> integer maps, feature order), `metrics.json`.
3. `npm run ml:register` (TS) inserts `metrics.json` into `model_runs`.
4. Server loads `model.onnx` once at startup via `onnxruntime-node` and serves `/api/predict`.

**Metrics to report:** ROC-AUC, precision, recall, F1, confusion matrix, delay-rate baseline, and feature importance. The class is imbalanced (~18-20% delayed); report that, and choose a decision threshold from the PR curve instead of defaulting to 0.5. Expect realistic AUC around 0.65-0.72 with pre-departure features only. Do not "improve" it by leaking; explain the ceiling in the report.

**Fallback if ONNX conversion blocks you:** implement logistic regression training in TS (mini-batch gradient descent over a Mongo cursor) and store the weights in `model_runs`. Record this in `DECISIONS.md`.

## 8. Cause analysis (the "identify major causes" requirement)

Implement these as aggregation pipeline builders in `server/src/analytics/`, each with a unit test on a tiny seeded fixture:

1. **Cause breakdown overall:** total delay minutes by cause (carrier, weather, NAS, security, late aircraft) and share of total.
2. **Cause by airline / airport / month / hour-of-day.**
3. **Delay rate by dimension:** airline, origin airport, route, day of week, hour (with minimum-sample filter, e.g. `flights >= 500`, to avoid noisy tiny groups).
4. **Cascade analysis:** share of delay minutes attributed to `lateAircraft` by hour. Expected to rise through the day; this demonstrates delay propagation.
5. **Cancellation reasons** breakdown.
6. **Worst N routes/airports** with the filter above.

Use `$facet` where one request needs several slices, `$bucket` for delay-severity histograms, `$group`/`$merge` for pre-aggregation, and `allowDiskUse: true` on heavy pipelines. Always `$match` first so indexes are used.

## 9. API spec (Express, JSON, all under `/api`)

All query/params validated with zod; errors in the shape `{ error: { code, message, details? } }`. Add pagination (`limit` capped at 100, `cursor` or `page`) on list endpoints.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Mongo ping + model loaded flag |
| GET | `/meta` | Row count, date range, airlines, airports (cached) |
| GET | `/analytics/summary` | Total flights, delay rate, avg arrival delay, cancel rate |
| GET | `/analytics/causes?by=overall\|airline\|airport\|month\|hour` | Cause breakdown |
| GET | `/analytics/delay-rate?by=airline\|origin\|route\|dow\|hour&minFlights=500&limit=20` | Delay rate ranking |
| GET | `/analytics/trend?airline=&origin=&granularity=day\|month` | Time series from `stats_daily` |
| GET | `/analytics/cascade` | Late-aircraft share by hour |
| GET | `/flights?airline=&origin=&dest=&from=&to=&limit=&cursor=` | Browse raw flights (index-backed) |
| POST | `/predict` | Body: `{date, airline, origin, dest, schedDepHour}` -> `{probability, label, threshold, topFactors[]}` |
| GET | `/model/metrics` | Latest `model_runs` document |
| GET | `/model/feature-importance` | From latest run |

`/predict` derives `distance`, `scheduledTime` and lookup rates server-side from MongoDB (`airports`, `delay_lookup`, a small `route_stats` lookup), so the client sends only the five fields above. Reject unknown airline/airport codes with 422. Cache `/meta` and the heavy analytics responses in memory (simple TTL map is enough; do not add Redis).

## 10. Dashboard (web)

Pages:
1. **Overview** — KPI cards (flights, delay rate, avg delay, cancel rate), monthly trend line.
2. **Causes** — stacked bar of cause minutes by month/airline; cascade-by-hour line; cancellation reasons.
3. **Explorer** — worst airlines/airports/routes tables with filters, hour x day-of-week delay-rate heatmap (CSS grid is fine).
4. **Predict** — form (date, airline, origin, destination, scheduled hour) -> probability gauge + top contributing factors.
5. **Model** — metrics table, confusion matrix, feature-importance bar chart.

Keep it clean and functional. Loading and error states are required on every data-fetching component. All API types come from `shared/`.

## 11. Build phases (do them in order; stop and verify after each)

**Phase 0 — Scaffold.** Monorepo, tsconfig strict, ESLint/Prettier, `docker-compose.yml` (mongo 7 + volume), `.env.example`, config module (zod-validated env), Mongo client singleton, `/health`. *Accept:* `docker compose up -d mongo && npm run dev -w server` returns healthy.

**Phase 1 — Ingestion.** CSV streaming loader, reference-data loader (airlines, airports), transformer with the gotchas in section 3, `ingest_runs` logging, `--drop/--append` flags. *Accept:* full 5.8M rows loaded without exceeding ~500 MB Node RSS; `ingest_runs` shows rows read/inserted/rejected; unit tests for the HHMM and null handling.

**Phase 2 — Indexes + denormalization checks.** Index creation script; `docs/EXPLAIN_RESULTS.md` with explain output for 4 representative queries before/after indexes. *Accept:* each representative query uses an `IXSCAN`.

**Phase 3 — Analytics.** All pipelines in section 8, `build:stats` job producing the `stats_*` collections, the analytics routes. *Accept:* pipeline tests pass on a seeded fixture; each endpoint responds < 1 s on the full dataset (stats collections or indexed `$match`).

**Phase 4 — Feature export + training.** `delay_lookup` builder (train split only), `export:training`, `ml/train.py`, artifacts, `ml:register`. *Accept:* `metrics.json` produced, test AUC beats the baseline, no forbidden feature in the feature list (add an automated test asserting this).

**Phase 5 — Prediction API.** onnxruntime-node loader, feature encoder identical to training (share the `encoders.json` contract), `/predict`, `/model/*`. *Accept:* a parity test: for 100 sampled test rows, TS inference probabilities match Python's within 1e-4.

**Phase 6 — Dashboard.** Pages in section 10.

**Phase 7 — Hardening + docs.** Error handling, rate limiting on `/predict`, README with exact run steps, `BIGDATA_JUSTIFICATION.md`, `SCHEMA.md`, final `DECISIONS.md`. Optional stretch: sharded compose file, scheduled `build:stats`, SHAP-style per-prediction explanations.

## 12. Big Data justification (write into `docs/BIGDATA_JUSTIFICATION.md`)

Cover this explicitly because the subject is graded on it:
- **Volume:** ~5.8M rows, multi-GB raw; why a document store with indexes and pre-aggregation is chosen over scanning CSVs.
- **Variety:** structured flight records + semi-structured cause sub-documents + reference data; schema flexibility of documents (nullable `causes`).
- **Velocity (simulated):** optional `npm run simulate:stream` that replays Dec flights into MongoDB in small batches to demonstrate incremental ingestion and incremental stats updates.
- **Schema design trade-offs:** denormalization vs `$lookup`, computed pattern, partial indexes, `$merge` for materialized views.
- **Scalability:** sharding strategy (6.3), index selectivity, `allowDiskUse`, cursor streaming instead of in-memory loads.
- **MongoDB vs alternatives:** brief comparison with Hadoop/Spark/SQL, and an honest note on where Spark would be better (heavy iterative ML), which is why training is offline.

## 13. Code conventions

- TypeScript `strict: true`, no `any` (use `unknown` + zod), ESM modules.
- One responsibility per module; routes thin, logic in services/analytics builders.
- Pipeline builders are pure functions returning `Document[]`, so they can be unit-tested without a DB. Integration tests may use `mongodb-memory-server` or the Docker instance with a separate `flights_test` database.
- No hard-coded connection strings; everything from env. `.env.example` is complete.
- Conventional commits; commit at the end of each phase.
- Every script is exposed through an npm script and documented in the README: `ingest`, `build:indexes`, `build:stats`, `build:lookup`, `export:training`, `ml:register`, `dev`, `test`.
- Log with pino; never log full documents.

## 14. Definition of done

- [ ] `docker compose up` + documented commands reproduce the full pipeline from raw CSV to a running dashboard
- [ ] >= 5M rows in MongoDB, ingest run recorded
- [ ] Explain-plan evidence for index usage
- [ ] All analytics endpoints implemented and < 1 s on full data
- [ ] Model trained with time-based split, no leakage, metrics stored in `model_runs`
- [ ] TS inference parity with Python verified by test
- [ ] Dashboard has all five pages with loading/error states
- [ ] Docs: README, SCHEMA, DECISIONS, BIGDATA_JUSTIFICATION, EXPLAIN_RESULTS
- [ ] Tests pass in CI (GitHub Actions: lint, typecheck, vitest)
