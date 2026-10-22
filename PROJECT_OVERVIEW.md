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
- **Infra:** Docker Compose (`mongo`, `kafka` for the Phase 8 streaming layer, optional `mongo-express` for inspection)
- **Streaming (Phase 8):** Apache Kafka (KRaft, single node), `@confluentinc/kafka-javascript` (section 15)

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
| GET | `/analytics/heatmap` | Delay rate per (day of week × scheduled hour) cell, from `stats_dow_hour` (added in Phase 6 for the Explorer heatmap) |
| GET | `/routes?origin=` | Destinations flown from an origin in 2015, from `stats_route` (added after Phase 7 so the Predict form only offers scorable routes) |
| GET | `/flights?airline=&origin=&dest=&from=&to=&limit=&cursor=` | Browse raw flights (index-backed) |
| POST | `/predict` | Body: `{date, airline, origin, dest, schedDepHour}` -> `{probability, label, threshold, topFactors[]}` |
| GET | `/model/metrics` | Latest `model_runs` document |
| GET | `/model/feature-importance` | From latest run |
| GET | `/stream/status` | Live replay state, throughput, lag, DLQ count and rolling live-prediction metrics with sample sizes (Phase 8, section 15.8) |

`/predict` derives `distance`, `scheduledTime` and lookup rates server-side from MongoDB (`airports`, `delay_lookup`, a small `route_stats` lookup), so the client sends only the five fields above. Reject unknown airline/airport codes with 422. Cache `/meta` and the heavy analytics responses in memory (simple TTL map is enough; do not add Redis).

## 10. Dashboard (web)

Pages:
1. **Overview** — KPI cards (flights, delay rate, avg delay, cancel rate), monthly trend line.
2. **Causes** — stacked bar of cause minutes by month/airline; cascade-by-hour line; cancellation reasons.
3. **Explorer** — worst airlines/airports/routes tables with filters, hour x day-of-week delay-rate heatmap (CSS grid is fine).
4. **Predict** — form (date, airline, origin, destination, scheduled hour) -> probability gauge + top contributing factors.
5. **Model** — metrics table, confusion matrix, feature-importance bar chart.
6. **Live** (Phase 8) — streaming status and rolling live-prediction metrics, polled from `/stream/status`.

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

**Phase 8 — Streaming layer (Kafka).** Added after Phase 7 because the college now requires one big data tool besides MongoDB. A speed layer next to the batch layer: replay December 2015 flights from `data/raw/flights.csv` into Kafka, consume them into new MongoDB collections, score each with the existing predictor, and compare predictions with actual outcomes. Full specification in section 15. Built as separately committed sub-steps 8a to 8g (section 15.10). *Accept:* every measurement in section 15.9 recorded in `docs/STREAMING.md`; the rest of the app and `/api/health` keep working with Kafka stopped.

## 12. Big Data justification (write into `docs/BIGDATA_JUSTIFICATION.md`)

Cover this explicitly because the subject is graded on it:
- **Volume:** ~5.8M rows, multi-GB raw; why a document store with indexes and pre-aggregation is chosen over scanning CSVs.
- **Variety:** structured flight records + semi-structured cause sub-documents + reference data; schema flexibility of documents (nullable `causes`).
- **Velocity (simulated):** the Phase 8 Kafka speed layer (section 15) replays December flights through Kafka into MongoDB and scores them live; state its single-broker limits honestly.
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
- [ ] Phase 8: Kafka streaming layer measured and documented in `docs/STREAMING.md` (section 15.9)

## 15. Streaming layer (Phase 8): Kafka speed layer

### 15.1 Goal and scope

A **speed layer** beside the existing **batch layer** (sections 6 to 8): December 2015 flights are replayed from `data/raw/flights.csv` into Kafka at a configurable rate, and a TypeScript consumer:
1. writes each event to MongoDB;
2. scores it with the existing predictor;
3. compares the prediction with the flight's actual outcome.

The replay simulates velocity; there is no live feed, and the docs say so. December is held-out test data (the model and `delay_lookup` use January to September only), so live scores are genuine out-of-sample predictions.

Hard boundaries:
- **Existing collections untouched:** `flights`, `stats_*`, `delay_lookup` and `model_runs` are never written by Phase 8 code. It writes only `stream_flights` and `stream_stats`.
- **App independent of Kafka:** with Kafka stopped, every existing page and endpoint works unchanged, and `/api/health` stays healthy. Its Kafka status is informational only.
- **Same rules as the batch layer:** never load the CSV fully into memory; no `any`; zod at every boundary; pino logging without full documents.

### 15.2 Infrastructure

- **Service:** a `kafka` service in `docker-compose.yml` using the **official Apache Kafka image**, pinned to an exact tag (proposed `apache/kafka:4.3.1`, the newest stable tag at time of writing; re-checked in 8a). Never `latest`.
- **Mode:** single node in **KRaft mode** (combined broker and controller, no ZooKeeper), with `KAFKA_NODE_ID`, `KAFKA_PROCESS_ROLES=broker,controller`, explicit listeners and `KAFKA_CONTROLLER_QUORUM_VOTERS`. Internal topic replication factors are set to 1. Overriding any setting drops the image defaults, so the full set is declared.
- **Network:** the port is bound to `127.0.0.1` only, as `mongo` is. The data volume is named.
- **Memory and health:** a modest JVM heap (`KAFKA_HEAP_OPTS`, proposed `-Xms256m -Xmx512m`) so Kafka fits Docker Desktop alongside MongoDB. 8a records the Docker memory allocation and the broker's observed memory use. A healthcheck runs the broker's API-versions or topics tool.
- **Client:** `@confluentinc/kafka-javascript`, an exact version in `server/package.json` (proposed 1.11.0), through its KafkaJS-compatible API. The kafkajs vs Confluent comparison and the reason for the choice are recorded in `docs/DECISIONS.md`.
- **Config:** `KAFKA_BROKERS`, `KAFKA_CLIENT_ID` and the topic names come from env (zod-validated) and appear in `.env.example`. Nothing is hard-coded.

### 15.3 Topics (`npm run kafka:init`)

| Topic | Partitions | Replication | Key | Purpose |
|---|---|---|---|---|
| `flights.raw` | 3 | 1 | `origin` | Replayed flight events. Keying by origin keeps one airport's events in order on one partition. |
| `flights.dlq` | 1 | 1 | flight key, or none | Malformed or unprocessable events, each with a reason. |

`kafka:init` is an idempotent TypeScript admin script: it creates missing topics, leaves existing ones alone ("already exists" is success), and fails loudly if an existing topic has the wrong partition count.

### 15.4 Event contract (shared zod schema, versioned)

```ts
interface FlightEvent {
  v: 1;
  key: string;          // deterministic flight key, 15.6
  runId: string;        // one replay invocation
  producedAt: number;   // epoch ms, set by the producer at send time
  pre: {                // strict pre-departure fields only
    date: string;       // YYYY-MM-DD
    airline: string; flightNumber: number;
    origin: string; dest: string;
    schedDepMin: number; schedDepHour: number;
  };
  outcome: {            // what actually happened; never given to the scorer
    depDelay: number | null; arrDelay: number | null;
    isDelayed: boolean | null; cancelled: boolean; diverted: boolean;
  };
}
```

Keeping `pre` and `outcome` in separate sub-objects makes the leakage boundary structural (15.7).

### 15.5 Producer (`npm run stream:replay`)

- **Flags:** `--month 12` (default 12), `--rate <events/sec>` (token-bucket pacing; `0` = as fast as possible), `--limit <n>`.
- **Bounded memory:** streams `flights.csv` with the existing `csv-parse` pipeline and never holds more than one send batch. December sits at the end of the file, so earlier months are read and skipped without being kept.
- **Parsing:** reuses `transformFlightRow` from `server/src/ingest/transform.ts` (with the same airline and airport reference data as ingestion); no parsing logic is duplicated. Rows the transformer rejects go to `flights.dlq` with `{source: "producer", reason}`, so nothing is silently dropped.
- **Delivery:** an **idempotent producer** (librdkafka `enable.idempotence`, `acks=all`). The `producedAt` timestamp is set at send.
- **Run summary:** a log line and a `stream_stats` run document: rows read, events sent to `flights.raw`, events sent to `flights.dlq`, elapsed time, achieved rate.

### 15.6 Consumer and storage (`npm run stream:consume`)

- **Group:** a consumer group (`flight-stream`) on `flights.raw`.
- **At-least-once:** auto-commit is off. For each batch the consumer validates, scores, writes to MongoDB and only then commits the batch's offsets.
- **Effectively-once results:** each event is an idempotent upsert keyed by `_id = key`, where `key = date|airline|flightNumber|origin|schedDepMin` (deterministic and pure, unit-tested). Re-delivered or re-replayed events never create a second document. A `deliveries` counter records re-deliveries as evidence.
- **Dead-letter queue:** events that fail schema validation go to `flights.dlq` with `{source: "consumer", reason, topic, partition, offset, value}` *before* the offset is committed; nothing is dropped. A scoring failure on a valid event (such as an unknown route) is not malformed: the event is stored with `prediction: null` and `scoreError`, and counted as unscored.
- **Graceful shutdown:** on SIGINT or SIGTERM it finishes the in-flight batch, commits, disconnects from Kafka and closes MongoDB.
- **`stream_flights`:** one document per flight with `{_id: key, runId, lastRunId, pre, outcome, prediction: {probability, label, threshold, modelVersion} | null, scoreError, correct, producedAt, firstWrittenAt, lastWrittenAt, deliveries}`. `runId` is the first run that delivered the flight and `lastRunId` the latest; `correct` is null when there is no prediction or no arrival outcome. Indexes: `{firstWrittenAt: -1, _id: -1}`, `{runId: 1}` and `stream_totals` `{prediction.modelVersion: 1, prediction.threshold: 1, prediction.label: 1, outcome.isDelayed: 1, scoreError: 1}`.
- **`stream_stats`:** run and consumer bookkeeping:
  - producer-run documents (`kind: "producer-run"`), one per replay;
  - one heartbeat document per consumer process (`kind: "consumer"`, `_id: "consumer:<group>:<host>-<pid>"`): `groupId`, `instanceId`, `status`, `startedAt`, `lastSeenAt` (every 2 s), `consumed`, `inserted`, `redelivered`, `dlq`, `batches`, `throughput`, and `error` while batches are failing;
  - a TTL index on `lastSeenAt` (6 h), so old heartbeats expire and producer runs (no `lastSeenAt`) are kept.

  Live metrics are not stored as running counters, which at-least-once delivery could double-count; they are computed from `stream_flights` (15.8).

### 15.7 Live scoring (no leakage)

- **Same code path:** the consumer scores with **`predictDelay` from `server/src/ml/predict.ts`**, using the same `loadModel` and `mongoReferenceData` as `POST /api/predict`. There is no second encoder or feature builder.
- **Strict input:** the scorer's input type is the strict pre-departure request `{date, airline, origin, dest, schedDepHour}`, built only from `event.pre` by one mapping function whose zod schema is `.strict()`.
- **Outcomes afterwards:** `outcome` fields are read only after scoring, to mark whether the prediction was right.
- **Proof:** a test shows the scorer cannot receive outcome fields. It is a compile-time `@ts-expect-error` plus a runtime rejection of any extra key, such as `arrDelay`, `depDelay`, `cancelled` or `isDelayed`.
- **Stored:** the predicted probability, label, threshold and model version, with each event.

### 15.8 API and dashboard

- **`GET /api/stream/status`** returns `{state: "live" | "idle" | "degraded", reason?}` plus:
  - events consumed;
  - DLQ count (from the DLQ topic's offsets, or `stream_stats` when Kafka is down);
  - throughput (events/s over the last interval);
  - consumer lag per partition, if the admin API provides it (otherwise `null` with a reason);
  - the rolling delay rate;
  - rolling precision, recall and accuracy of live predictions against outcomes.

  Every rate states its sample size `n`. Rolling means the last N completed, scored flights (N configurable, default 2,000), with whole-run totals beside it. Metrics are computed from `stream_flights` and cached for a few seconds.
- **Degraded behaviour:** if Kafka or the consumer is down, the status endpoint returns a clear degraded state with a reason, never a 500. `/api/health` gains an informational `kafka: "up" | "down"` field that never changes its overall status.
- **Kafka admin calls run in a forked probe process,** so a native crash of the Kafka client on a broker restart cannot take down the API (`docs/DECISIONS.md`, Phase 8e).
- **Live page (lowest priority):** one new dashboard page in the existing visual style. It polls the status endpoint, has loading, error and degraded states, invents no numbers, and shows the sample size next to every live metric.

### 15.9 Acceptance (all measured, recorded in `docs/STREAMING.md`)

1. **Conservation:** for one run, rows read for the month = events to `flights.raw` + producer DLQ events, and events on `flights.raw` = documents upserted + consumer DLQ events.
2. **Unique keys:** the `stream_flights` count equals the number of distinct keys produced (any duplicate key in the source is reported, not hidden).
3. **Idempotent replay:** re-running the same replay changes no document counts (only `deliveries`).
4. **Crash recovery:** killing the consumer mid-run (hard kill) and restarting it loses nothing and duplicates nothing; the counts from item 1 still hold.
5. **Throughput** at three replay rates.
6. **Latency:** end-to-end p50 and p95, from `producedAt` to the MongoDB write (`firstWrittenAt`).
7. **Metrics check:** the status endpoint's live metrics match an independent recomputation from `stream_flights` in MongoDB.

### 15.10 Sub-steps (each committed separately; plan approved before building)

8a Kafka infrastructure and topics · 8b producer · 8c consumer and storage · 8d live scoring · 8e status endpoint · 8f Live page (lowest priority) · 8g docs and measurements.

### 15.11 Tests

- **Unit:** flight-key determinism, event validation, idempotent consumer logic (batch, upsert, commit order, DLQ routing, with fakes), and the no-outcome-fields scorer test.
- **Smoke:** `npm run stream:smoke` runs against the real Kafka container: init topics, produce a small replay, consume, assert the conservation and idempotency counts.
- **Isolation:** test databases use a `_test` suffix and are dropped in `afterAll`. Test topics use a test prefix.

### 15.12 Docs

- **README:** run order (`docker compose up -d mongo kafka`, `kafka:init`, `stream:consume`, `stream:replay`).
- **`docs/DECISIONS.md`:** entries for the client choice, image tag, heap, keying, delivery semantics and the metrics design.
- **`docs/BIGDATA_JUSTIFICATION.md`:** where Kafka sits (the velocity layer of a batch plus speed architecture) and its honest limits. A single broker with replication factor 1 has **no fault tolerance**: losing the broker or its volume loses unconsumed events. The replay is simulated velocity; production would need at least 3 brokers, `min.insync.replicas = 2` and monitoring.
