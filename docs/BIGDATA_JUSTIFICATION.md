# Big Data justification

This document covers PROJECT_OVERVIEW §12 point by point: volume, variety, velocity, schema trade-offs, scalability, and how MongoDB compares with the alternatives. Every figure names its source. Anything not measured is marked `TODO: measure`.

**Environment.** Everything was measured on one machine: a single-node MongoDB 7.0.43 in Docker with 7.6 GiB available to the container (source: DECISIONS.md, Phase 2). There is no cluster. Host: Intel Core i5-12450H (8 cores, 12 threads), 15.7 GB RAM, NVMe SSD, Windows 11 with Docker Desktop (read from Windows `Get-CimInstance Win32_Processor`, `Get-PhysicalDisk` and `Win32_ComputerSystem` on 2026-10-16).

**Units.** MB means 10^6 bytes. `docs/EXPLAIN_RESULTS.md` and `docs/DECISIONS.md` report the same quantities in MiB (2^20 bytes): 3,924.4 MB of data equals the 3,742.6 MiB printed there. They are the same measurements in different units.

## Scope and limitations

These limits are stated first because they bound every claim that follows.

| Limitation | Consequence |
|---|---|
| The data covers one year: 2015, 5,819,079 flights (source: `ingest_runs`). | There is no year-over-year signal, and the test period (Oct-Dec) is one season of one year. |
| The model uses no weather and no aircraft-position or inbound-flight features. Only pre-departure schedule fields and historical rates are allowed (PROJECT_OVERVIEW §7). | Test ROC-AUC is 0.6276 (source: `ml/artifacts/metrics.json`), below the 0.65-0.72 that §7 expects. |
| Velocity is simulated. The Kafka speed layer (Phase 8) replays December 2015 from the CSV at a chosen rate; there is no live feed. It runs on one broker with replication factor 1. | Throughput and latency are measured for a replay on one machine (source: `docs/STREAMING.md`), not for a production stream. The broker has no fault tolerance (see [Velocity](#velocity-simulated)). |
| Sharding is a design only. The optional `docker-compose.sharded.yml` was **not built**. | No sharded figures exist (see [Sharding strategy](#sharding-strategy-design-only)). |
| October airport codes are partly derived. 486,165 October rows used numeric BTS airport ids, and 483,018 (99.35%) were resolved offline (source: DECISIONS.md, "Airport id resolution"). | 1,632 flights still have an unresolved origin and 3,147 have an unresolved origin or destination (source: `stats_runs.dataQuality`). Airport-keyed results exclude them and say so in the API. |

## Volume

### What the data weighs

| Measure | Value | Source |
|---|---|---|
| Raw `flights.csv` | 592.4 MB | file size, measured 2026-10-16 |
| `flights` documents | 5,819,079 | `$collStats`, 2026-10-16 |
| `flights` uncompressed BSON | 3,924.4 MB (average document 674 bytes) | `$collStats` |
| `flights` on disk (WiredTiger, compressed) | 903.3 MB | `$collStats` after the Phase 7 rebuild (903.5 MB before it) |
| `flights` indexes (8, including `_id_`) | 368.6 MB | `$collStats`, 2026-10-22 (`docs/measurements/batch-runs-2026-10-22.json`) |
| Whole `flight_delay` database: 21 collections, 6,985,597 documents (including the Phase 8 `stream_*` collections) | data 4,382.5 MB, storage 1,009.3 MB, indexes 429.8 MB | `db.stats()`, 2026-10-22 (`docs/measurements/batch-runs-2026-10-22.json`) |
| Ingest | 5,819,079 rows read and inserted, 0 rejected; 296 s at 342 MB peak Node RSS (2026-10-11 run), and 421 s at 362 MB in the Phase 7 reproduction (2026-10-16, with other jobs sharing the machine) | `ingest_runs` (both `--drop` runs) |

Note that 592 MB of CSV is not "big data" by industry standards. What makes it a Big Data exercise here is the size relative to the tools: 5.8M rows will not fit in a browser or a naive Node array, a full scan costs 4-7 s per query (source: EXPLAIN_RESULTS.md, Q1-Q7 "Before"), and the BSON form is 6.6 times the size of the CSV, because every document repeats its field names and carries denormalised fields. WiredTiger compression shrinks the BSON by 4.3x (3,924.4 → 903.3 MB).

### Why a document store with indexes and pre-aggregation instead of scanning CSVs

Scanning the CSV for each question would cost one full pass per request. MongoDB with indexes gives three tiers of access, and each one was measured:

| Access pattern | Example | Time | Source |
|---|---|---|---|
| Full scan (the CSV-like baseline) | Q1 with `.hint({ $natural: 1 })`: 5,819,079 docs examined | 7,037 ms | EXPLAIN_RESULTS.md |
| Selective read through an index | Q1 via `airline_1_date_1`: 45,966 docs examined | 107 ms (65.8x) | EXPLAIN_RESULTS.md |
| Count answered from the index alone | Q6 delayed flights in December, `COUNT_SCAN`, 0 docs examined | 33 ms (190.3x) | EXPLAIN_RESULTS.md |
| Whole-collection ranking, no index can help | Q8 route ranking, `COLLSCAN` in both plans | 13,499 ms | EXPLAIN_RESULTS.md |
| The same ranking from a pre-aggregated collection | `/api/analytics/delay-rate?by=route`, reads 4,695 `stats_route` docs | 38 ms median over HTTP | EXPLAIN_RESULTS.md |

Indexes only help selective queries. Whole-collection rankings and breakdowns, which is what a dashboard mostly shows, have to be pre-aggregated. `npm run build:stats` does that, so every analytics endpoint reads at most 386,704 small documents (`stats_daily_origin`) and usually a few thousand. All 34 timed endpoint requests returned in under 1 s; the analytics medians were 5-39 ms and `/api/meta` 53 ms (source: EXPLAIN_RESULTS.md, "API endpoint timings").

### Memory stays bounded

No step loads the dataset into Node memory:

| Job | Peak Node RSS | How | Source |
|---|---|---|---|
| `ingest` (5.8M rows) | 362 MB (latest `--drop` run, 2026-10-16; 342 MB on 2026-10-11) | `csv-parse` stream, `for await`, batches of 10,000, `insertMany({ ordered: false })` | `ingest_runs` (`docs/measurements/batch-runs-2026-10-22.json`) |
| `build:stats` | 106 MB (latest run, 2026-10-22) | all work runs inside MongoDB (`$group` + `$merge`, `allowDiskUse: true`) | `stats_runs` (`docs/measurements/batch-runs-2026-10-22.json`) |
| `export:training` | 284 MB | projected cursor streamed to CSV | DECISIONS.md, Phase 4 |
| `resolve:airport-ids` | 364-455 MB | cursors plus `_id`-targeted bulk updates in batches of 10,000; the 127k-key reference map dominates | DECISIONS.md |

The Phase 1 acceptance limit was about 500 MB (PROJECT_OVERVIEW §11). Ingest memory does not grow with file size: `inBatches` (`server/src/ingest/batch.ts`) holds one batch, and the next batch is not read until `insertMany` returns, so backpressure reaches the file stream.

## Variety

The data has three shapes, and the document model holds all three without a schema migration.

| Kind | Where | Handling |
|---|---|---|
| Structured, fixed columns | `flights.csv`: times, carrier, route, delays | Validated with zod in `server/src/ingest/transform.ts`. HHMM integers become minutes and an hour; `2400` means midnight. |
| Semi-structured, optional | The five delay-cause columns, reported only for flights 15+ minutes late | Stored as a nullable `causes` sub-document. It is `null` when all five are blank and otherwise holds per-cause numbers or `null`. Blanks are never stored as 0 (DECISIONS.md, Phase 1). 1,063,439 of 5,819,079 flights have `causes` (DECISIONS.md, Phase 2). |
| Reference data | `airlines.csv` (14), `airports.csv` (322) | Separate collections with `_id` = IATA code. Airline name and airport city/state are copied into each flight at ingest. |
| Inconsistent identifiers | 486,165 October rows use 5-digit BTS airport ids instead of IATA codes | Kept and flagged rather than dropped (`originIsIata: false`, raw id in `originAirportId`), then resolved offline. See below. |

**Why a sub-document for `causes`.** A relational design would need five nullable columns on every row, or a child table and a join. Here the absence of causes is one `null` field. That also enables the partial index `month_1_airline_1_with_causes`, which holds only the flights with a `causes` object: 6.0 MB, against 28.1-50.8 MB for the five full-collection §6.2 indexes (`date_1`, `airline_1_date_1`, `origin_1_schedDepHour_1`, `route_1`, `isDelayed_1_month_1`; source: `$collStats`). Cause pipelines treat `null` as 0 only inside `$ifNull`, so stored data never confuses "not reported" with "zero minutes".

**The airport-id problem.** In October the source switches to numeric BTS ids for both origin and destination on 486,165 rows. October is about a third of the Oct-Dec test split, so dropping those rows would have hollowed out evaluation. `npm run resolve:airport-ids` infers the mapping from the data itself:

1. It keys each scheduled service by (airline, flight number, scheduled departure, scheduled arrival).
2. It learns the IATA pair for each key from the September and November rows.
3. It lets each numeric-id row vote.
4. It maps an id only with at least 20 votes and at least 99% agreement.

282 of 307 ids were mapped and 483,018 rows (99.35%) were fully resolved. The raw ids are never overwritten, and derived codes are flagged with `originIataDerived` / `destIataDerived` (source: DECISIONS.md, "Airport id resolution"). This is the kind of messy-source problem a Big Data pipeline has to absorb without crashing, and the flexible document shape let the extra fields be added without touching any other document.

## Velocity (simulated)

**Demonstrated as a replay, not a live feed.** Phase 8 adds a Kafka speed layer beside the batch layer (PROJECT_OVERVIEW §15). Every figure below is from `docs/STREAMING.md`, which cites a JSON file in `docs/measurements/` for each one.

### Where Kafka sits

| Layer | Path | Freshness |
|---|---|---|
| Batch | `flights.csv` → `ingest` → `flights` → `build:stats` / `build:lookup` → `stats_*`, `delay_lookup` → model training | As fresh as the last full `build:stats` rebuild (a full recompute; durations in `stats_runs`) |
| Speed (velocity) | `flights.csv` (December) → `stream:replay` → Kafka `flights.raw` → `stream:consume` → MongoDB `stream_flights` | Each flight is stored and scored as it arrives |

- **Same predictor.** The consumer scores each new flight with `predictDelay` from `server/src/ml/predict.ts`, the same code path as `POST /api/predict`, using only the pre-departure fields of the event. The outcome is read after scoring, to judge the prediction (`docs/DECISIONS.md`, Phase 8d).
- **Out-of-sample.** December is test data: the model and `delay_lookup` use January to September only.
- **Batch layer untouched.** Phase 8 writes only `stream_flights` and `stream_stats`. Every batch collection count was identical before and after the 8g runs (source: `docs/measurements/batch-collections-before.txt`, `-after.txt`). The speed layer does not feed `stats_*`; those are still full recomputes.
- **Delivery.** At-least-once (offsets committed only after the MongoDB write), made effectively-once by upserting on `_id` = the flight key. A re-delivered event bumps `deliveries` and never creates a second document.

### What was measured

All seven §15.9 items passed (source: `docs/STREAMING.md`):

| Measure | Result |
|---|---|
| Conservation and unique keys, all of December | 479,230 rows = 479,230 sent = 479,230 upserts; 479,230 stored = 479,230 distinct keys; lag 0 |
| Idempotent replay of 5,000 events | `stream_flights` stays 479,230; only `deliveries` grows (+5,000) |
| Hard kill of the consumer at 58,530 of 100,000 | after restart 100,000 stored, 100,000 distinct, lag 0 |
| Consumer throughput with live scoring | 506/s at a 500/s replay, 2,018/s at 2,000/s, 2,442/s unthrottled |
| Latency p50 / p95 (`firstWrittenAt − producedAt`) | 63 / 906 ms at 500/s; 138 / 2,236 ms at 2,000/s |
| `/api/stream/status` vs an independent recomputation | 35 of 35 checks match |

Unthrottled, the producer sent December at 12,542/s while the consumer stored and scored at 2,442/s. Kafka buffered the difference and the backlog drained after the producer had finished, so latency there (p50 72.6 s) is queueing time in Kafka, not processing time. That buffering is the point of putting a log between producer and consumer.

### Honest limits

- **Simulated velocity.** A replay of 2015 data at a chosen rate, not a live feed. Each event already carries its outcome, which in reality arrives hours later.
- **No fault tolerance.** One broker with replication factor 1: losing the broker or its volume loses every event not yet consumed. Production would need at least 3 brokers, `min.insync.replicas=2` and monitoring.
- **Bounded by scoring.** Consumer throughput with live scoring is about 2.4k/s in one process (2,442/s, run C). Unscored inserts reached 10,904/s and scoring alone 2,807/s (`docs/PHASE8_STATUS.md`, 8c and 8d). Scaling out to more consumer processes (up to one per partition, 3 here) was not measured.
- **A native crash in the client.** `@confluentinc/kafka-javascript` 1.11.0 (librdkafka) crashed its process (0xC0000005) in `admin.fetchOffsets` when the broker restarted. The API therefore runs its Kafka admin calls in a forked probe process: the child crashes, the API keeps serving and starts a new one (`docs/DECISIONS.md`, Phase 8e). A consumer under load through a broker restart was not tested.
- **One machine, one run per rate.** Producer, broker, consumer and MongoDB shared one laptop; no figure is a mean of repeated runs.

## Schema design trade-offs

| Choice | Alternative | Why this one | Cost |
|---|---|---|---|
| **Denormalise** `airlineName`, `originCity`/`originState`, `destCity`/`destState` and the derived `route` into every flight | Normalised flights plus `$lookup` into `airlines` / `airports` at read time | There is no `$lookup` anywhere in `server/src`. On a 5.8M-row aggregation a `$lookup` runs per input document, and in a sharded cluster it is an extra cross-collection step. The reference data is tiny (14 + 322 documents) and fixed for 2015, so update anomalies are not a practical risk. `route` turns "origin and dest" into one equality on the single-field `route_1` index (Q4: 27.8x faster). | Larger documents: the six fields take about 103 of the 674 average bytes per flight (about 15%; mean `$bsonSize` of an object holding just those fields over a 100,000-flight `$sample`, measured 2026-10-16). Airport *names* are deliberately not copied, so a reference reload never leaves flights stale (comment in `server/src/ingest/run.ts`). |
| **Computed pattern**: `stats_*` collections built by `$group` + `$merge` | Aggregating `flights` on every request | Q8 shows a whole-collection ranking takes 13.5 s even with indexes. The same ranking from `stats_route` takes 38 ms median. 4,926 `stats_daily` documents replace 5,819,079 flights for daily and monthly totals. | 370.8 s for the latest rebuild, 110.2-370.8 s over seven runs (source: `docs/measurements/batch-runs-2026-10-22.json`). Data is as fresh as the last build. About 123 MB of extra uncompressed data (sum of the eight `stats_*` sizes), most of it `stats_daily_origin` (117.53 MB). |
| **`$merge` into materialised collections** rather than `$out` | `$out` replaces the target collection | `$merge` upserts by `_id`, so a collection is never empty mid-build, and with a `buildId` sweep it is idempotent. A second full build removed 0 stale documents (DECISIONS.md, Phase 3). | The stale-document sweep is an extra `deleteMany` per collection. |
| **Store sums, derive rates** | Store only `delayRate` / `avgArrDelay` | Re-aggregating at read time (days into months, airlines into an airport) stays exact, and it enables a future incremental update. | Slightly larger documents. |
| **Partial index** `month_1_airline_1_with_causes` on `{ causes: { $type: "object" } }` | A full `{ month, airline }` index | It indexes only the 1,063,439 flights with causes: 6.0 MB. Q5 is 11.5x faster (4,653 → 403 ms). | Queries must repeat `causes: { $type: "object" }`, or the planner cannot use the index. |
| **Time-based split** stored on each flight (`split`: Jan-Sep `train`, Oct-Dec `test`) | Random split | A random split leaks seasonality and would overstate AUC (§7). Tagging the split at ingest makes every downstream job (`delay_lookup`, export) filter the same way. | The test period differs from training (16.08% vs 19.45% delayed; `metrics.json` `classBalance`). |
| **Offline training** in one Python script, ONNX served from Node | Training inside MongoDB or Node | See [MongoDB vs alternatives](#mongodb-vs-alternatives). | Training is a batch step; a new model needs `ml:register` and a server restart (DECISIONS.md, Phase 5). |

## Scalability

### Index selectivity

Indexes pay off in proportion to how few documents they let the query touch (source: EXPLAIN_RESULTS.md):

| Query | Docs examined after | Share of collection | Speedup |
|---|---|---|---|
| Q6 delayed in December (`COUNT_SCAN`) | 0 (96,773 keys) | 0% | 190.3x |
| Q2 ATL at 17:00 | 20,523 | 0.35% | 118.3x |
| Q7 24-26 Dec | 41,244 | 0.71% | 66.5x |
| Q1 AA in March | 45,966 | 0.79% | 65.8x |
| Q4 LAX-SFO | 14,799 | 0.25% | 27.8x |
| Q5 July causes (partial index) | 107,627 | 1.85% | 11.5x |
| Q3 ORD by hour | 313,536 | 5.39% | 2.4x |
| Q8 all routes | 5,819,079 | 100% | 1.0x (no index used) |

Q3 gains only 2.4x because it must fetch every ORD document to read `isDelayed`. A covering index was measured and rejected (4.6 s → 2.3 s for an extra wide index); the pre-aggregated `stats_airport_hour` serves this workload instead (DECISIONS.md, Phase 2). Indexes that were considered and **not** added (`dest`, `split`, `originIsIata`) are listed with measurements in DECISIONS.md, because every index costs RAM and slows every insert. The `flights` indexes total 367.4 MB, about 41% of the 903.3 MB compressed data.

### `allowDiskUse` and server-side work

`build:stats`, `build:lookup` and the explain runs pass `allowDiskUse: true`, so a `$group` over 5.8M documents can spill to disk instead of failing at the 100 MB per-stage memory limit. The aggregation runs inside `mongod`, and `$merge` writes the output there too, so Node's peak RSS during the full stats rebuild was 106 MB (source: `stats_runs`).

### Cursor streaming

`export:training` reads a projected cursor (only pre-departure fields plus the label) and writes 4,299,046 train rows and 1,411,835 test rows to CSV at 284 MB peak RSS (source: DECISIONS.md, Phase 4; row counts match `metrics.json` `trainRange.rows` / `testRange.rows`). `/api/flights` uses keyset pagination on `_id` with `limit` capped at 100, so no request materialises a large result.

### Sharding strategy (design only)

**Not deployed.** The optional `docker-compose.sharded.yml` (config servers, 2 shards, `mongos`) was **not built**. Nothing below has been measured.

**Shard key: `{ origin: 1, date: 1 }`** (PROJECT_OVERVIEW §6.3), for `flights` only.

| Property | Reasoning |
|---|---|
| Write distribution | `date` alone is monotonic: during an append or stream, every new flight would go to the last chunk, so one shard takes all writes (a hotspot). Leading with `origin` spreads concurrent inserts across airports. |
| Targeted reads | Queries that include `origin` (`/api/flights?origin=`, Q2, Q3, origin + date windows) route to the shards owning that airport's chunks instead of broadcasting. |
| Range queries | Within one airport, `date` keeps a date window in a contiguous key range. |
| Cardinality | The compound key has up to (airports × days) distinct values: 322 reference airports × 365 days. ATL, the busiest origin, has about 350k flights a year (DECISIONS.md, Phase 3), or roughly 960 a day. At 674 bytes each that is under 1 MB per (ATL, day) value, far below a chunk, so jumbo chunks are not expected. This is arithmetic, not a measurement. |
| Existing index | `origin_1_schedDepHour_1` does not have the shard-key prefix shape. Sharding needs an index on `{ origin: 1, date: 1 }`, one more index. Its size: `TODO: measure`. |

**What would get worse.** Queries without `origin` become scatter-gather across all shards: airline + date (Q1, trend by airline), `route` (unless rewritten to include `origin`), and pure date windows (Q7). `build:stats` and `build:lookup` are full-collection `$group` jobs anyway; on a sharded cluster the shards would group their own data in parallel and the merge would happen on one node, so those jobs would scale out. The `stats_*` and `delay_lookup` collections are small and would stay unsharded on the primary shard.

**Alternatives rejected.** A hashed `_id` key gives perfectly even writes, but turns every range query into a broadcast. `{ airline: 1, date: 1 }` has only 14 airline values to lead with, so it is uneven (one measured plan for WN sorted 1,261,855 documents, all of that airline's flights; DECISIONS.md, Phase 3 review).

## MongoDB vs alternatives

MongoDB was mandated (PROJECT_OVERVIEW §2), so this is a justification after the fact, not a bake-off. No alternative was benchmarked.

| | Flat CSV + scripts | PostgreSQL | Hadoop MapReduce / Hive | Spark | MongoDB (this project) |
|---|---|---|---|---|---|
| Fit at 5.8M rows, 3.9 GB | Every question is a full pass | Good. It would handle this size comfortably. | Overkill; job start-up latency dominates | Good for batch; the cluster is overhead at this size | Good |
| Nullable `causes`, flagged airport ids | Ad hoc | Nullable columns or a child table | Schema-on-read | Schema-on-read | Native: a nullable sub-document plus extra flag fields |
| Low-latency API reads | No | Yes | No (batch only) | No (needs a serving store) | Yes: indexed finds and small `stats_*` reads, all endpoints < 1 s |
| Pre-aggregation | Manual | Materialised views (`REFRESH`) | Batch jobs to files | Batch jobs to a store | `$group` + `$merge`, idempotent with `buildId` |
| Horizontal scale | No | Possible (partitioning, Citus) but not native | Yes | Yes | Yes, native sharding (designed, not deployed) |
| Iterative ML | Single process | No | Poor (each iteration is a disk-bound job) | **Strong** (in-memory iterations, MLlib) | **Weak**: no training engine |

**Where Spark would be better.** Gradient boosting and logistic regression are iterative: each pass reads the whole training set. Spark keeps that set in cluster memory across iterations; MongoDB has no ML runtime, and running iterations as aggregation pipelines would rescan 4.3M documents each time. That is why training is offline: `export:training` streams the features out once, `ml/train.py` trains LightGBM on one machine in 89.5 s (source: `metrics.json` `durationSeconds`), and the ONNX model is served from Node with `onnxruntime-node`. At 4,299,046 training rows and 13 features this fits in one process. At many times the volume, or with many more features, Spark MLlib (or distributed LightGBM on Spark) would be the right tool, with MongoDB still the system of record via the Spark connector.

**Honest note on PostgreSQL.** At this size, a relational database with B-tree indexes and materialised views would deliver similar results. MongoDB's real advantages here are the document shape (sub-documents and flags without migrations), `$merge` for idempotent materialised views, and native sharding as the growth path.

## Model ceiling: why accuracy is not higher

Source: `ml/artifacts/metrics.json` (LightGBM, 157 trees, threshold 0.2070 chosen on September validation).

| Model | Test ROC-AUC | Test PR-AUC | Precision | Recall | F1 |
|---|---|---|---|---|---|
| Baseline (constant train rate) | 0.5000 | 0.1608 | 0 | 0 | 0 |
| Logistic regression | 0.6155 | 0.2218 | 0.216 | 0.531 | 0.307 |
| LightGBM (served) | 0.6276 | 0.2348 | 0.218 | 0.582 | 0.318 |

- The model sees only what is known before departure: calendar, airline, airports, distance, scheduled time and historical rates (13 features). The causes that actually drive delays (weather on the day, air traffic control programmes, a late inbound aircraft) are known only after departure, and using them would be target leakage. The `causes` sub-document records these minutes after the fact (`stats_cause_monthly`), which is exactly why it is a forbidden feature.
- One year of data gives each rate feature only nine training months.
- The test period has fewer delays than training (16.08% vs 19.45%), so the base rate shifts.
- The low precision (about 1 in 5 flagged flights is delayed) is expected at a max-F1 threshold with a 16.1% base rate. Nothing was added to raise AUC: the leakage-auditor found no leakage into the test metrics (DECISIONS.md, Phase 4).

## Viva preparation

**Q: Why MongoDB and not Spark or Hadoop?**
A: The workload is ingest once, then serve many low-latency reads to an API. Hadoop and Spark are batch engines and would need a separate serving store. MongoDB stores the 5.8M flights, answers selective reads through indexes (Q1: 7,037 → 107 ms), and materialises dashboard aggregates with `$merge`, so every endpoint answers in under 1 s. Spark would win for iterative ML at much larger scale, which is why training is offline in `ml/train.py`.

**Q: Why is the accuracy not higher?**
A: Test AUC is 0.6276 (`metrics.json`) because only pre-departure features are allowed. Weather, ATC delays and late inbound aircraft are post-departure information and appear only in the forbidden `causes.*`, `depDelay`, `taxiOut` and related fields. Adding them would leak the label. The data also covers only 2015.

**Q: Why denormalise instead of `$lookup`?**
A: `airlines` and `airports` are tiny (14 and 322 documents) and fixed for 2015. Copying `airlineName`, `originCity` and the other fields into `flights` removes a per-document join from 5.8M-row pipelines; there is no `$lookup` in `server/src`. `route` gives a single-field index for origin-dest pairs.

**Q: What is the computed pattern here?**
A: `npm run build:stats` runs eight `$group` + `$merge` pipelines (`server/src/stats/builders.ts`) into `stats_*` collections. The API reads those small collections: for example, `stats_route` has 4,695 documents, against a 13.5 s scan of `flights`.

**Q: How do you avoid stale data after a rebuild?**
A: Every output document carries the run's `buildId`. After each `$merge`, `deleteMany({ buildId: { $ne: current } })` removes keys that no longer exist. A failed run is recorded in `stats_runs` and leaves the previous complete set in place.

**Q: Why a partial index?**
A: Only 1,063,439 flights report causes. `month_1_airline_1_with_causes` indexes just those, at 6.0 MB, and the cause query must repeat `causes: { $type: "object" }` to use it (Q5: 11.5x faster).

**Q: Why a time-based split?**
A: A random split would let the model learn the test months' seasonality and overstate AUC. Train is Jan-Sep and test is Oct-Dec, tagged as `flights.split` at ingest. `delay_lookup` uses train data only, with out-of-fold rates for the training rows.

**Q: How does ingestion stay within memory?**
A: `csv-parse` stream → `for await` → batches of 10,000 → `insertMany({ ordered: false })`. The next batch is not read until the insert returns. The peak was 362 MB RSS for 5.8M rows in the latest run (2026-10-16; 342 MB on 2026-10-11; `ingest_runs`, `docs/measurements/batch-runs-2026-10-22.json`).

**Q: Did you shard?**
A: No. The shard key `{ origin: 1, date: 1 }` is designed, but no cluster was run. `date` alone would be a monotonic write hotspot; leading with `origin` spreads writes and keeps per-airport queries targeted.

**Q: Did you demonstrate velocity?**
A: As a simulation. `stream:replay` sends December 2015 into Kafka (`flights.raw`) at a chosen rate, and `stream:consume` stores each flight in `stream_flights` and scores it with the same `predictDelay` as `/api/predict`. With live scoring the consumer kept up at 2,000/s (2,018/s) and reached 2,442/s unthrottled, where scoring is the bottleneck; p50 latency was 138 ms at 2,000/s (`docs/STREAMING.md`). It is a replay on one broker with replication factor 1, so it has no fault tolerance and is not a live feed.

**Q: Why Kafka in front of MongoDB instead of writing straight to it?**
A: Kafka decouples the producer's rate from the consumer's. In the unthrottled run the producer sent at 12,542/s and the consumer scored at 2,442/s; Kafka held the backlog and nothing was lost (lag 0 at the end). Committed offsets also make recovery possible: after a hard kill the restarted consumer read exactly the 41,470 unprocessed messages (`docs/STREAMING.md`, item 4).

**Q: Is the stream exactly-once?**
A: At-least-once delivery with idempotent writes. Offsets are committed only after the MongoDB write, so a crash can redeliver a batch, and `_id` = flight key turns a redelivery into an update of `deliveries`, never a second document. Re-sending 5,000 events left `stream_flights` at 479,230.

**Q: What about the numeric airport codes?**
A: 486,165 October rows used BTS numeric ids. `resolve:airport-ids` maps them by matching flight schedules against September and November, with at least 20 votes and at least 99% agreement. 99.35% of the rows were resolved. The rest are excluded from airport-keyed results, and the API reports this in `coverage`.
