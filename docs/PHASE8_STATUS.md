# Phase 8 status: Kafka streaming layer

Read this first if you are a new session resuming Phase 8. The specification is `PROJECT_OVERVIEW.md` §15 (Phase 8 entry in §11). The detailed reasoning and evidence for each sub-step is in `docs/DECISIONS.md`, under the headings "Phase 8a" to "Phase 8d".

**State on 2026-10-22:**
- **Phase 8 is complete:** sub-steps 8a to 8g are committed on `main`; nothing is pushed.
- **The acceptance record is `docs/STREAMING.md`:** all seven §15.9 items pass, with evidence in `docs/measurements/`.

Every number below was measured in this project during 8a to 8g. Nothing is estimated.

---

## 1. Done: sub-steps 8a to 8g

### 8a: Kafka infrastructure and topics, commit `65463b6`

**Built:**
- **Broker:** a `kafka` service in `docker-compose.yml`, image `apache/kafka:4.3.1`, single node in KRaft mode (combined broker and controller, no ZooKeeper). The full single-node configuration is declared, because overriding any setting drops the image defaults.
- **Network:** port bound to `127.0.0.1:9092` only. The advertised listener and controller voter are `127.0.0.1`, not `localhost`.
- **Storage:** named volume `kafka_data` at `/var/lib/kafka/data`.
- **Broker settings:** `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`; `KAFKA_HEAP_OPTS=-Xms256m -Xmx512m`; a healthcheck using `kafka-broker-api-versions.sh`.
- **Client:** `@confluentinc/kafka-javascript` pinned to exactly `1.11.0` in `server/package.json`.
- **Env vars:** optional `KAFKA_*` variables, zod-validated in `server/src/config/env.ts` and listed in `.env.example`.
- **Topics:** `server/src/stream/topics.ts` holds a pure topic spec plus `initTopics`, which creates missing topics, retries while new topics propagate, and fails on a partition-count mismatch. `server/src/stream/kafka-init-cli.ts` exposes it as `npm run kafka:init`.

**Measured:**
- **Docker Desktop:** 8,175,534,080 bytes (7.61 GiB) and 12 CPUs (`docker info`, engine 29.8.2).
- **Broker memory:** 282 to 375 MiB (`docker stats`), beside MongoDB at 290 MiB.
- **Heap:** `-Xms256m -Xmx512m` confirmed on the broker's Java process.
- **`kafka:init`:** after deleting both topics, the first run created `flights.raw` (3 partitions, replication factor 1) and `flights.dlq` (1 partition, replication factor 1), confirmed with `kafka-topics.sh --describe`. Later runs created nothing.
- **Broker config:** `auto.create.topics.enable=false` is a static broker config, and `log.retention.hours=168` (the default).
- **No Kafka dependency:** with Kafka stopped, `/api/health` returned `{"status":"ok","mongo":"up","modelLoaded":true}`, and `/api/meta` and `/api/predict` returned 200.

### 8b: replay producer, commit `518ba32`

**Built:**
- **Event contract:** `shared/src/stream.ts` defines the strict zod schemas `FlightEventSchema`, `PreDepartureSchema`, `FlightOutcomeSchema` and `DlqMessageSchema`, plus `flightKey()`.
- **Producer:** `server/src/stream/replay.ts`, `replay-cli.ts`, `replay-args.ts`, `pacer.ts` and `event.ts`.
- **Shared parsing:** the ingest's `csvRows`, `requireFile` and `DEFAULT_DATA_DIR` are now exported from `server/src/ingest/run.ts`. The producer parses rows with `transformFlightRow`; there is no second parser.
- **Producer settings:** idempotent, with `acks: -1` and `maxInFlightRequests: 5`.
- **DLQ:** rows the transformer rejects go to `flights.dlq` with `source: "producer"`, the reason and the raw row. Records `csv-parse` cannot read are counted (`malformedCsv`) but not dead-lettered, because their month is unknown.
- **Run record:** one `stream_stats` document per run (`kind: "producer-run"`, `_id: "producer-run:<runId>"`).

**Measured** against the real broker. The source facts, read-only from `flights`: December has **479,230** flights, **479,230 distinct flight keys**, 0 non-IATA airports, and ingestion rejected 0 of 5,819,079 rows.

| Run | Sent to `flights.raw` | DLQ | Send phase | Achieved rate | Peak RSS |
|---|---|---|---|---|---|
| `--limit 1000 --rate 500` | 1,000 (322 + 356 + 322 by partition) | 0 | 1.94 s | 516/s | 131 MB |
| `--rate 0` (all of December) | 479,230 | 0 | 47.99 s | 9,987/s | 290 MB |
| `--limit 200 --rate 0` | 200 (stopped after 5,340,049 rows read) | 0 | — | 4,244/s | 131 MB |

- **Offsets:** the topic offsets matched the reported counts exactly in every run.
- **Reading time:** reaching December means reading about 5.34M earlier rows, which takes about 93 to 95 s per run.
- **Old record:** the first producer-run document in `stream_stats` shows `achievedRate: 11`. It was written before the send-phase timing fix and is kept as-is.

### 8c: consumer and storage, commit `5b7495b`

**Built:**
- **Batch logic:** `server/src/stream/consume.ts` (pure `decodeBatch` and `handleBatch`).
- **Storage:** `server/src/stream/store.ts` (`stream_flights`, its upserts and indexes).
- **Consumer:** `server/src/stream/consumer.ts` (`startConsumer`, the heartbeat, backoff and graceful stop).
- **CLIs:** `server/src/stream/consume-cli.ts` (`npm run stream:consume`) and `server/src/stream/smoke-cli.ts` (`npm run stream:smoke`).
- **Env var:** `KAFKA_CONSUMER_GROUP`, default `flight-stream`.
- **Delivery order per batch:** auto-commit is off and `eachBatchAutoResolve` is false. Each batch is decoded, upserted, its malformed messages are dead-lettered, then `last + 1` is committed and only then resolved. A failure before the commit makes the client seek back and redeliver, after a backoff of 1 s doubling to 30 s.
- **Batches:** at most 500 messages each (`js.consumer.max.batch.size`), with 3 partitions consumed concurrently.

**Measured:**
- **Full consume:** 481,430 messages in 976 batches. **479,230 inserted** (equal to December in `flights`), 2,200 redelivered (from earlier test replays), 0 dead-lettered. **Lag was 0** on all three partitions. Insert rate was **10,904 flights/s** (first to last write, 43.9 s).
- **Idempotent re-replay** of 5,000 events: 5,000 consumed, 0 inserted. `stream_flights` stayed at 479,230.
- **Crash recovery,** isolated in database `flight_delay_crash_test` with consumer group `crash-test`:
  - The consumer was hard-killed (`Stop-Process -Force`) after storing 316,598 flights, with 318,598 offsets committed.
  - The restart consumed exactly the 167,832 unread messages and inserted 162,632, giving 479,230 flights in total.
  - Deliveries summed to 486,430, the number of messages then on the topic. Lag was 0.
  - The `crash-test` group was deleted afterwards. The database is still there (see §5).
- **Batch collections unchanged** before and after: `flights` 5,819,079, `delay_lookup` 36,420, `model_runs` 2, and every `stats_*` count identical.
- **Topic state at the last check (8c re-verification):**
  - `flights.raw` end offsets were 176,248 / 185,939 / 125,243 (**487,430 messages**), with lag 0 for group `flight-stream`.
  - Deliveries in `stream_flights` summed to 487,430.
  - `flights.dlq` was empty.

### 8d: live scoring, commit `ac37355`

**Built:**
- **Scorer:** `server/src/stream/score.ts` (a branded `ScoringRequest`, `toScoringRequest`, `scoreRequest` and `scoreEvents`).
- **Model and reference data:** `server/src/stream/predictor.ts` (`createPredictor`: `loadModel` + `predictDelay` + a cached `mongoReferenceData`) and `server/src/stream/reference-cache.ts`.
- **Backfill:** `server/src/stream/score-missing.ts` and `score-missing-cli.ts` (`npm run stream:score-missing`).
- **Consumer change:** the consumer scores flights not yet stored and writes the score in the same insert. Redeliveries are never re-scored.

**Measured:**
- **Backfill:** **479,230 scored, 0 refused**, in 171 s (**2,807 flights/s**), with model `lightgbm-20261013093139-12f165c2`. A second run scanned 0.
- **Verdicts:** 469,717 flights have a non-null `correct`, exactly the number of completed December flights. 282,618 of them are `correct: true`.
- **Parity:** 20 random stored scores were re-scored through a running `POST /api/predict`. All 20 matched exactly (maximum absolute difference 0), with the same label, threshold and model version.
- **Smoke:** `stream:smoke` passes all 5 checks, including "every stored flight was scored live".
- **Leakage audit** (`leakage-auditor`): no leakage, the same code path as `/api/predict`, and December out-of-sample (`lookupScope: "full"` = train months January to September).

**Tests at the 8d commit:** 39 test files and 322 tests pass. Lint, typecheck and Prettier are clean.

### 8e: status endpoint, commit `dbd1952`

**Built:**
- **Endpoint:** `GET /api/stream/status`, with the shared `StreamStatusResponseSchema` (`shared/src/stream-status.ts`).
- **Code:**
  - `server/src/stream/status/`: `metrics.ts`, `queries.ts`, `state.ts`, `kafka-probe.ts`, `isolated-probe.ts`, `probe-worker.ts` and `service.ts`;
  - the route, `server/src/routes/stream.ts`.
- **Health:** an informational `kafka: "up" | "down"` field in `/api/health`.
- **CLIs:** `npm run stream:indexes`, `npm run stream:verify-status` and `npm run stream:reset`. The reset was **not run**.
- **Config:** `STREAM_WINDOW_SIZE`, default 2,000.

**Measured** (details in `docs/PERF.md`; decisions in `docs/DECISIONS.md`, "Phase 8e"):
- **Kafka up:** uncached status took **158.6 ms** (median of 3) with the full replay loaded, and health 6.8 ms. Every query is IXSCAN, COUNT_SCAN or DISTINCT_SCAN; there is no COLLSCAN.
- **Kafka stopped (real `docker compose stop kafka`):**
  - status answered **200 degraded in about 1,022 ms**, with lag null and a reason;
  - health answered **200 in about 13 ms** with `status: "ok"` and `kafka: "down"`;
  - after `docker compose start kafka`, the API recovered in **4.7 s** without a restart.
- **Native crash:** `admin.fetchOffsets` in the Kafka client crashes its process natively (0xC0000005) when the broker restarts. The admin calls therefore run in a forked probe process. The child crashes, and the API keeps serving and starts a new child.
- **§15.9 item 7:** `stream:verify-status` matched **35 of 35** checks against an independent recomputation.
- **Rolling window:** the 2,000 latest-departing flights of 2015-12-31 (departure hours 13 to 23). It is a slice of the schedule, not "recent performance", and the response says so.
- **Tests at the 8e commit:** 46 test files and 382 tests pass; lint, typecheck, Prettier and the web build are clean.
- **Totals:**
  - n = 469,717;
  - precision 0.278, recall 0.584;
  - accuracy 0.602 against a majority baseline of 0.794.

### 8f: Live page, commit `bf9beea`

**Built:**
- **Page:** the **Live** tab (`/live`, `web/src/pages/Live.tsx`), polling `/api/stream/status` every 5 s. It shows:
  - the state with its reason;
  - a pipeline row (flights stored, consumer throughput, lag, DLQ size);
  - a metric board, with the rolling window beside the whole replay. Every value carries its own sample size, and accuracy sits next to its majority baseline;
  - what the window covers;
  - Kafka partitions and the consumer heartbeat.
- **View model:** `web/src/lib/live.ts`, with tests.
- **Design record:** `web/DESIGN.md` ("Live page").

**Verified** in the browser at 1440x900 and 390x844, in four states, with screenshots in `docs/screenshots/live-*.png`:
- live, with a real consumer;
- degraded, after a real `docker compose stop kafka`;
- stale, with the API stopped while the page was open;
- first-load error.

**Consumer through a broker restart:** a running consumer survived a Kafka stop and start with no error, and the status was live again 5 s after the start. This was one run with no messages flowing.

**Tests at the 8f commit:** 47 test files and 396 tests pass; lint, typecheck, Prettier and the web build are clean.

### 8g: measurements and docs, commit `417b85a`

**Built:**
- **Tool:** `npm run stream:measure`.
- **Docs:** `docs/STREAMING.md` and `docs/measurements/`; the README "Streaming layer" section; the Velocity section of `docs/BIGDATA_JUSTIFICATION.md`; `PROJECT_OVERVIEW.md` §15.6 updated.

**Measured** (each run after `stream:reset`; details in `docs/STREAMING.md`):

| Run | Result |
|---|---|
| 500/s | consumer 506/s, latency p50 63 ms, p95 906 ms |
| 2,000/s | consumer 2,018/s, latency p50 138 ms, p95 2,236 ms |
| Unthrottled, all of December | producer 12,542/s, consumer with live scoring 2,442/s (scoring is the bottleneck), latency p50 72.6 s (queueing in Kafka) |

- **Conservation and unique keys:** they pass in every run.
- **Idempotent re-replay of 5,000 events:** 0 new flights; `deliveries` +5,000.
- **Hard kill at 58,530 of 100,000:** after restart, 100,000 stored, 100,000 keys, lag 0.
- **Status metrics:** 35 of 35 checks match.
- **Batch collections:** unchanged.

**State after 8g:** `stream_flights` held all 479,230 December flights from run C. The follow-ups below reset it again.

### Follow-ups after acceptance (2026-10-22)

Each was committed separately; details and evidence are in `docs/STREAMING.md` and `docs/measurements/`.

| Commit | Follow-up | Result |
|---|---|---|
| `1bb6969` | Stale measured figures | `build:stats` (370.8 s) and `build:lookup` (65.2 s) were re-measured. SCHEMA.md and BIGDATA_JUSTIFICATION.md now cite `batch-runs-2026-10-22.json`, with the 110.2 to 370.8 s range of seven runs, the latest ingest RSS (362 MB) and the current database totals. The README keeps its clean-clone audit times and says their output was not saved. |
| `ae094fe` | Latency at a sustainable rate | Run E at 1,200/s (49% of 2,442/s capacity): steady state p50 423 ms, p95 2,238 ms; 1,098 / 9,424 ms including the cold start. Lag over time from the new `stream:watch`. `stream:measure` gained `--from`. The host was busy during the run (62% CPU). |
| `706f4a3` | Mid-batch crash | Run F: kill attempt 2 landed mid-batch, with 31,554 written against 31,054 committed. Those 500 were redelivered: 500 flights have `deliveries` = 2, the run ended with 200,000 flights for 200,000 keys, 0 duplicates and lag 0. |
| `fdc1b6f` | Kafka restart under load | Run G: the broker was down for 28 s. Nothing was restarted and nothing lost (150,000 sent = stored). The consumer resumed 42 s after the broker came back. Status was degraded with a reason while Kafka was down, then reported `live` while the consumer was stalled. |
| `6f9b0f0` | Two consumers against one | Runs H1 and H2: 1,736/s against 2,155/s (1.24x). The 3 partitions split 1 + 2 (62.4% to one consumer) and both shared one busy laptop. |
| `cfcc44b` | Frontend colour scheme (your request) | Reverted the rose / cerulean retheme (`9c41f26`, `b5c3734`), so `web/` is back to the departure-board palette in `web/DESIGN.md`. |

**Current state** (restored on 2026-10-22 after the follow-ups):
- `stream_flights` holds all 479,230 December flights again: `stream:reset`, then one consumer and `stream:replay -- --month 12 --rate 0`.
- Every `stream:measure` check passes: 479,230 sent = on `flights.raw` = upserts = stored, 0 DLQ, 0 redeliveries, lag 0.
- `/api/stream/status` reports `live`, with whole-replay n 469,717 and precision 0.278, the same as the earlier full-December runs.

**Tests at the 8g commit:** 49 test files and 412 tests pass; lint, typecheck and Prettier are clean.

---

### Kafka reliability fixes (2026-10-22 to 23)

Six broker-restart runs (R1 to R6) in an isolated database, consumer group and topics; the full-December state was left as it was. Details and evidence: `docs/STREAMING.md`, "Reliability fixes after acceptance".
- **Stall detection:** `state` is `degraded` when the consumer is alive but has stored no batch for more than 15 s while messages have waited more than 15 s (verified in R4).
- **Consistent stored counts:** refused and unscored come from one aggregation; two racing counts had made `unscored` negative and failed the response schema (R1).
- **Faster resume:** `KAFKA_SESSION_TIMEOUT_MS`, default 10 s: resumed 17.2 s after the broker started, against 36.9 s and 39.1 s with 30 s.
- **`--idle-exit`** counts from the first batch.
- **Redelivery warning:** the consumer logs how many already-stored flights arrived again (R5: 40, R6: 26 + 74, each exactly the flights stored twice).
- **Probe in an API without a console:** the probe is forked detached; reproduced the 0xC0000142 start-up failure and verified the fix through two broker restarts.
- **More runs at 10 s:** resumed 17.2, 19.1 and 19.8 s after the broker started (R3, R5, R6).

## 2. Decisions that later steps depend on

- **Kafka client:** `@confluentinc/kafka-javascript` 1.11.0 (librdkafka), through its KafkaJS-compatible API: `import { KafkaJS } from '@confluentinc/kafka-javascript'`, then `new KafkaJS.Kafka({ kafkaJS: { brokers, clientId, ... } })`.
  - `kafkajs` was rejected: no release since 2.2.4 (2023-02-27).
  - Admin calls use the types in `node_modules/@confluentinc/kafka-javascript/types/kafkajs.d.ts`: `listTopics`, `fetchTopicMetadata`, `createTopics`, `fetchTopicOffsets`, `fetchOffsets`, `deleteTopics` and `deleteGroups`.
  - The client factory is `createKafka()` in `server/src/stream/kafka.ts`. It also exports `topicNames()`, `consumerGroup()` and `ADMIN_TIMEOUT_MS`.
- **Broker address:** `127.0.0.1:9092`. On Windows, `localhost` resolves to `::1` first, which the loopback-only binding does not serve.
- **Topics:**
  - `flights.raw`: 3 partitions, replication factor 1, message key = `pre.origin`.
  - `flights.dlq`: 1 partition, replication factor 1.
  - Both come from env (`KAFKA_TOPIC_RAW`, `KAFKA_TOPIC_DLQ`). Only `kafka:init` creates topics.
- **Consumer group:** `flight-stream` (`KAFKA_CONSUMER_GROUP`).
- **Event key:** `flightKey(pre) = date|airline|flightNumber|origin|schedDepMin`, from `shared/src/stream.ts`. It is the `_id` of `stream_flights`, and `FlightEventSchema` checks that `key` matches `pre`.
- **Event shape:**
  - `{v: 1, key, runId, producedAt (epoch ms), pre, outcome}`.
  - `pre` = date, airline, flightNumber, origin, dest, schedDepMin, schedDepHour (strict).
  - `outcome` = depDelay, arrDelay, isDelayed, cancelled, diverted (strict).
- **Collections:** Phase 8 writes only these two. `flights`, `stats_*`, `delay_lookup` and `model_runs` are never written by Phase 8 code.
  - **`stream_flights`:** `{_id: key, runId, lastRunId, pre, outcome, prediction: {probability, label, threshold, modelVersion} | null, scoreError, correct, producedAt, firstWrittenAt, lastWrittenAt, deliveries}`. Indexes: `firstWrittenAt_-1` and `runId_1`.
  - **`stream_stats`:** producer-run documents (`kind: "producer-run"`), and one heartbeat document per consumer process (`kind: "consumer"`, `_id: "consumer:<group>:<host>-<pid>"`, `lastSeenAt` every 2 s, per-process counters, `throughput`).
- **How the scorer is called:**
  - `createPredictor(db)` returns `predict = (request) => predictDelay(request, model, cachedReferenceData(mongoReferenceData(() => db)))`.
  - `scoreEvents(events, predict)` builds each request with `toScoringRequest(event.pre)`, the only producer of the branded `ScoringRequest` type. It is re-validated with the strict `PredictRequestSchema` from `shared/src/model.ts`.
  - `outcome.isDelayed` is read only after scoring, to set `correct`.
- **Error handling:** only a `MongoError` fails a batch and causes redelivery. Every other failure is recorded on the flight as `scoreError` (the HTTP code for a 4xx, `INVALID_REQUEST`, or `SCORING_FAILED`).
- **Authoritative totals:** these come from the `stream_flights` count and Kafka offsets. Consumer heartbeat counters are per-process observations.
- **Status endpoint (8e):**
  - It is always 200, with `state` `live`, `idle` or `degraded` and a reason.
  - The response carries `source: "replay of Dec 2015 flights"`, the window order (`firstWrittenAt`, then `_id`: replay order, not flight date), `windowStart`/`windowEnd` and `departureHours`.
  - Every metric group carries its `modelVersion`, `threshold` and `n`, and a `lowSample` flag below 200.
- **Indexes (8e):**
  - `stream_flights` has `firstWrittenAt_-1__id_-1` (which replaced `firstWrittenAt_-1`), `runId_1` and `stream_totals` (`prediction.modelVersion`, `prediction.threshold`, `prediction.label`, `outcome.isDelayed`, `scoreError`).
  - `stream_stats` has the TTL index `lastSeenAt_ttl` (6 h).
  - All are created by `ensureStreamIndexes`, which runs at consumer start and from `npm run stream:indexes`.
- **Liveness:** heartbeats every 2 s; a heartbeat is stale after 10 s. The newest heartbeat per group is used.
- **No librdkafka in the API process:** the Kafka admin calls run in a forked child process (`isolated-probe.ts`).
- **`deliveries` vs topic size:** `deliveries` may exceed the number of messages on the topic after a crash inside the write-to-commit window. Use `>=` for deliveries; the `stream_flights` count is the invariant.

---

## 3. Plan

Phase 8 (8a to 8g) is complete. There is no further approved plan; the open items are in §5.

## 4. How to run

**Prerequisites:**
- Docker Desktop running.
- `flights.csv`, `airlines.csv` and `airports.csv` in `data/raw/`.
- MongoDB loaded by the batch pipeline: ingest, `build:stats`, `build:lookup`.
- A model in `ml/artifacts/` (registered with `ml:register`).

```bash
docker compose up -d mongo kafka
```

```bash
npm run kafka:init
```

Start the consumer first, in its own terminal. It runs until Ctrl+C; `--idle-exit SECONDS` stops it once no batch has arrived for that long after its first batch, which suits scripted runs.

```bash
npm run stream:consume
```

Then replay December. `--rate` is events per second (`0` = unthrottled). `--limit N` stops after N rows of the month. `--month` defaults to 12. `--dir` defaults to `data/raw`.

```bash
npm run stream:replay -- --month 12 --rate 1000 --limit 5000
```

The status endpoint (with the API running, `npm run dev`) and its independent check. The check needs the consumer stopped, because a write during the run fails it:

```bash
curl http://127.0.0.1:3001/api/stream/status
```

```bash
npm run stream:verify-status
```

To create or migrate the stream indexes without starting a consumer:

```bash
npm run stream:indexes
```

To empty the speed layer for 8g (refuses unless `--db` is the configured database; stop the consumer and any replay first). **Not run yet; ask the user first:**

```bash
npm run stream:reset -- --db flight_delay --yes
```

To score `stream_flights` documents stored before live scoring existed (a no-op once everything is scored):

```bash
npm run stream:score-missing
```

The end-to-end smoke test against the real broker uses its own topics (`smoke-<time>.raw` / `.dlq`), consumer group and database (`flight_delay_smoke_test`), and removes all three afterwards. It does not need `flights.csv`. It reads airlines, airports, `stats_route` and `delay_lookup` from the main database, read-only, to score.

```bash
npm run stream:smoke
```

**Inspecting Kafka** from Git Bash (prefix with `MSYS_NO_PATHCONV=1`, or Git Bash rewrites the container paths):

```bash
MSYS_NO_PATHCONV=1 docker compose exec kafka /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic flights.raw
```

```bash
MSYS_NO_PATHCONV=1 docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group flight-stream
```

**Env vars** (all optional; defaults in `.env.example`): `KAFKA_BROKERS=127.0.0.1:9092`, `KAFKA_CLIENT_ID=flight-delay`, `KAFKA_CONSUMER_GROUP=flight-stream`, `KAFKA_TOPIC_RAW=flights.raw`, `KAFKA_TOPIC_DLQ=flights.dlq` and `STREAM_WINDOW_SIZE=2000`. `MONGODB_DB` selects the database the consumer writes to.

---

## 5. Open items

### Leftover data
- **Stale figures (fixed after 8g):** `build:stats` and `build:lookup` were re-measured on 2026-10-22 (370.8 s and 65.2 s); SCHEMA.md and BIGDATA_JUSTIFICATION.md now cite `docs/measurements/batch-runs-2026-10-22.json` with the full range of saved runs.
- **`flight_delay_crash_test`** (MongoDB) is still present: 479,230 unscored `stream_flights` documents plus `stream_stats`, left from the 8c crash test. The bash guard hook blocked dropping it from Claude. The user can drop it from a terminal: `docker compose exec mongo mongosh flight_delay_crash_test --eval "db.dropDatabase()"`. Its Kafka group `crash-test` was already deleted.
- **`flights.raw`** holds 484,230 messages after the 8g runs: run C (all of December) plus the 5,000-event re-replay. Retention is 168 hours.
- **`stream_stats`** in `flight_delay` holds the two producer runs since the last `stream:reset` (run C and the re-replay) plus consumer heartbeats, which expire after 6 h. The 8b to 8d run records, including the pre-fix `achievedRate: 11`, were cleared by the 8g resets.

### Found in the follow-ups
- **Fixed:** "live" while stalled, the slow resume after a broker restart, and `--idle-exit` counting from the start (see Kafka reliability fixes above).
- **Lost commits now warn:** the consumer logs redelivered flights as they arrive. Why the client lost 16,000 commits in R1 without an error is still not traced.
- **Reset after a hard kill:** `stream:reset` refuses until the killed member's session expires (about 45 s). That is correct, but it means a retry loop.
- **Host load matters:** timings varied widely across the day (`build:stats` 127 to 371 s; one consumer 2,442/s in the morning, 1,736/s in the evening).

### Found in 8e
- **Native crash:** `@confluentinc/kafka-javascript` 1.11.0 `admin.fetchOffsets` crashes its process (0xC0000005) when the broker comes back after a stop. The API contains this with a forked probe process. The consumer (`stream:consume`) uses the same library. In 8f a running consumer survived one broker stop and start with no messages flowing. Under load it also survived a 28 s broker outage without crashing (run G, follow-ups); the API's probe process crashed once in that run and was replaced. A consumer crash is recoverable by restarting it (8c crash test).
- **No web health indicator:** `web/` has no page that calls `/api/health`. The schema change is covered by a web parse test only.

### Reviewer suggestions not done
- **8a:**
  - No fixed `CLUSTER_ID` in compose; the image generates one.
  - In `kafka-init-cli.ts`, a `disconnect()` error in `finally` can mask the original error.
- **8b and 8c:**
  - zod 4 prefers `z.strictObject` to `.strict()`; both work.
- **8c:**
  - **Idle-exit timing:** fixed; `--idle-exit` now counts from the first batch.
  - **Poll interval:** librdkafka's `max.poll.interval` still applies, so a MongoDB stall over 5 minutes removes the consumer from the group.
- **8d:**
  - **Circular type import:** there is a type-only circular import between `store.ts` and `score.ts`.
  - **Permanent refusals:** a refused flight's `scoreError` is permanent; the backfill does not retry `UNKNOWN_ROUTE` after a `stats_route` rebuild.
  - **Version literal:** `v: 1` is hard-coded in `score-missing.ts`.
  - **Model-lookup link:** nothing records which `delay_lookup` build the model was trained against. This applies to the API too.
  - **Parity test:** the leakage auditor suggested an automated test comparing the cached and uncached predictor on a seeded database. Instead, parity was verified manually against a running `/api/predict` (20 of 20 identical); no such automated test exists.
  - **Batch vs stream metrics:** stream metrics differ from the batch test metrics for December by design. `/predict` uses `stats_route`'s route-level `scheduledTime` and distance, not each flight's own, and refused flights are excluded. Documented next to item 7 in `docs/STREAMING.md` (8g).

### Reviewer suggestions not done (8e)
- **Flaky-timer risk:** the tests that bound timing (`toBeLessThan(500)` with 30 to 50 ms timeouts) use real timers. They could be flaky on a slow CI.
- **Unvalidated aggregation rows:** the window `aggregate<WindowRow>` result and the `verify-status` cursor rows are typed but not zod-validated. Both read our own pipeline's output.

### Not yet measured or verified
- **Repeated runs:** each figure is a single run; no mean or spread over repeated runs.
- **Three consumers** (one per partition) and more partitions were not measured.
- **Graceful stop via a real Ctrl+C.** A SIGINT cannot be sent to a Node process programmatically on Windows. The same `stop()` path was exercised through `--idle-exit`, and both runs ended with heartbeat `status: "stopped"` and lag 0.
- **The backoff path against a real MongoDB or broker outage.** It is covered by unit-level logic only.
- **The DLQ path with real data.** December has no rows the transformer rejects. The DLQ path is exercised by unit tests and by `stream:smoke` (one producer reject and one malformed message, both landed on the DLQ topic).
