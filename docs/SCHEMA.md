# MongoDB schema

This document describes the `flight_delay` database: every collection in use, its document shape (taken from the code), the denormalised and pre-aggregated design, and every index with the query it serves.

**Sources.**
- Shapes: `server/src/db/collections.ts`, `server/src/stats/builders.ts`, `server/src/stats/build.ts`, `server/src/features/lookup.ts`, `server/src/features/export.ts`, `server/src/ml/register.ts`, `shared/src/model.ts`.
- Counts and sizes: `$collStats` / `db.stats()`, measured 2026-10-16 on single-node MongoDB 7 in Docker.
- MB means 10^6 bytes. `docs/EXPLAIN_RESULTS.md` reports the same sizes in MiB.

## Overview

| Collection | Role | Documents | Uncompressed size | Written by |
|---|---|---|---|---|
| `flights` | System of record, one document per flight | 5,819,079 | 3,924.4 MB | `npm run ingest`, `npm run resolve:airport-ids` |
| `airlines` | Reference | 14 | < 0.01 MB | `ingest` |
| `airports` | Reference | 322 | 0.05 MB | `ingest` |
| `stats_daily` | Computed pattern | 4,926 | 2.19 MB | `npm run build:stats` |
| `stats_daily_origin` | Computed pattern | 386,704 | 117.53 MB | `build:stats` |
| `stats_route` | Computed pattern | 4,695 | 1.43 MB | `build:stats` |
| `stats_airport_hour` | Computed pattern | 4,259 | 1.60 MB | `build:stats` |
| `stats_cause_monthly` | Computed pattern | 162 | 0.03 MB | `build:stats` |
| `stats_cancellation` | Computed pattern | 440 | 0.07 MB | `build:stats` |
| `stats_delay_buckets` | Computed pattern | 8 | < 0.01 MB | `build:stats` |
| `stats_dow_hour` | Computed pattern | 168 | 0.04 MB | `build:stats` |
| `delay_lookup_cells` | Intermediate for model features (train split) | 249,130 | 56.55 MB | `npm run build:lookup` |
| `delay_lookup` | Model feature rates (train split) | 36,420 | 6.49 MB | `build:lookup` |
| `model_runs` | Model registry | 2 | 0.01 MB | `npm run ml:register` |
| `ingest_runs` | Audit | 14 | < 0.01 MB | `ingest` |
| `resolve_runs` | Audit | 4 | < 0.01 MB | `resolve:airport-ids` |
| `stats_runs` | Audit | 5 | < 0.01 MB | `build:stats` |
| `lookup_runs` | Audit | 1 | < 0.01 MB | `build:lookup` |
| `export_runs` | Audit | 2 | < 0.01 MB | `npm run export:training` |

On disk, `flights` takes 903.3 MB (WiredTiger compressed, after the Phase 7 rebuild), plus 367.4 MB of indexes. The whole database holds 6,506,355 documents: 4,110.4 MB of data, 959.1 MB of storage and 398.0 MB of indexes (`db.stats()`).

## `flights`

One document per flight. The interface is `FlightDoc` in `server/src/db/collections.ts`, and `_id` is an ObjectId assigned at insert, so it follows CSV (almost chronological) order.

| Group | Fields | Notes |
|---|---|---|
| Calendar | `date` (Date, UTC midnight), `year`, `month`, `day`, `dayOfWeek` (1 = Mon ... 7 = Sun) | `dayOfWeek` is derived from `date`, not copied from the CSV. |
| Carrier | `airline` (IATA), **`airlineName`**, `flightNumber`, `tailNumber` (string or null) | `airlineName` is denormalised from `airlines`. |
| Origin | `origin`, `originIsIata`, `originAirportId` (raw BTS id or null), `originIataDerived`, **`originCity`**, **`originState`** | City and state are denormalised from `airports`. |
| Destination | `dest`, `destIsIata`, `destAirportId`, `destIataDerived`, **`destCity`**, **`destState`** | Same as origin. |
| Route | **`route`** (`"ORIGIN-DEST"`) | A derived key, recomputed by `resolve:airport-ids`. |
| Schedule | `schedDepMin`, `schedDepHour` (0-23), `schedArrMin`, `distance`, `scheduledTime` (or null) | HHMM is converted to minutes; `2400` is midnight. |
| Outcome (post-departure) | `depDelay`, `arrDelay`, `taxiOut`, `taxiIn`, `airTime`, `elapsedTime` (each number or null), `cancelled`, `cancellationReason` (`A`-`D` or null), `diverted` | All forbidden as model features (PROJECT_OVERVIEW §7). |
| Label | `isDelayed` (boolean or null) | `arrDelay >= 15`; null when cancelled, diverted or arrival delay unknown. |
| Causes | `causes`: `{ carrier, weather, nas, security, lateAircraft }`, each number or null, **or `null`** | `null` when all five source columns are blank. Blanks are never stored as 0. 1,063,439 flights have a `causes` object (DECISIONS.md, Phase 2). |
| Split | `split`: `"train"` (months 1-9) or `"test"` (10-12) | Set at ingest (`server/src/ingest/transform.ts`). |

The airport flag fields go beyond PROJECT_OVERVIEW §6.1. They exist because 486,165 October rows used numeric BTS airport ids. Ingest keeps the raw id, `resolve:airport-ids` writes the IATA code into `origin`/`dest` and sets `*IataDerived: true`, and 1,632 rows still have an unresolved origin (see DECISIONS.md, "Airport id resolution").

### Denormalisation: no `$lookup` on the hot path

`airlineName`, `originCity`, `originState`, `destCity`, `destState` and `route` are copied or derived at ingest. There is no `$lookup` anywhere in `server/src`.

- **Why.** Analytics aggregate millions of flights. A `$lookup` into `airlines` or `airports` would run once per input document, and on a sharded cluster it adds a cross-collection step. The reference data is tiny (14 + 322 documents) and fixed for 2015, so copying it carries little risk of update anomalies.
- **`route`** turns an origin-and-destination filter into one equality on a single-field index. `/api/flights?origin=JFK&dest=HNL` is rewritten to `route` and answered through `route_1` in 9 ms median (EXPLAIN_RESULTS.md).
- **What is not copied.** Airport *names* stay only in `airports`, so `ingest -- --reference-only` can fix a name without leaving flights stale (comment in `server/src/ingest/run.ts`).
- **Cost.** Each document is larger. The denormalised fields (`airlineName`, `originCity`, `originState`, `destCity`, `destState`, `route`) take about 103 of the 674-byte average, roughly 15% (mean `$bsonSize` of an object holding just those fields over a 100,000-flight `$sample`, measured 2026-10-16).

### Indexes on `flights`

Defined in `server/src/db/indexes.ts`. They are built by `npm run build:indexes` after the bulk load, idempotently, and are never dropped automatically except for an exact-match retired index. Sizes are from `$collStats`, 2026-10-16.

| Index | Key | Size | Serves | Evidence |
|---|---|---|---|---|
| `_id_` | `{ _id: 1 }` | 64.7 MB | `/api/flights` keyset pagination (`cursor` = last `_id`). Date windows add `_id` bounds taken from `stats_daily.minId/maxId`. | December window: 8.8 s → 21 ms after adding the bounds (DECISIONS.md, Phase 3) |
| `date_1` | `{ date: 1 }` | 29.0 MB | Date-range reads, `/api/meta` date range, daily trends | Q7: 4,392 → 66 ms |
| `airline_1_date_1` | `{ airline: 1, date: 1 }` | 50.8 MB | One airline over a date range (equality, then range) | Q1: 7,037 → 107 ms |
| `origin_1_schedDepHour_1` | `{ origin: 1, schedDepHour: 1 }` | 39.7 MB | One origin airport, optionally by hour; `/api/flights?origin=` | Q2: 4,614 → 39 ms; Q3: 4,916 → 2,063 ms |
| `route_1` | `{ route: 1 }` | 48.0 MB | One route; `/api/flights?route=` and `origin` + `dest` | Q4: 4,953 → 178 ms |
| `isDelayed_1_month_1` | `{ isDelayed: 1, month: 1 }` | 28.1 MB | Delayed / on-time counts by month, answered from keys alone (`COUNT_SCAN`) | Q6: 6,280 → 33 ms, 0 docs examined |
| `month_1_airline_1_with_causes` | `{ month: 1, airline: 1 }`, **partial** on `{ causes: { $type: "object" } }` | 6.0 MB | Cause analysis over flights that report causes. Queries must repeat `causes: { $type: "object" }`. | Q5: 4,653 → 403 ms |
| `airline_1_origin_1__id_1` | `{ airline: 1, origin: 1, _id: 1 }` | 100.9 MB | `/api/flights?airline=&origin=`, returning a pair's flights already in page order (added beyond §6.2) | HA+ATL: 7.5 s worst case → 5 ms; DL+ATL 6 ms (DECISIONS.md "Phase 3 review", EXPLAIN_RESULTS.md) |

Query timings are server-side `executionTimeMillis`, collection scan → indexed plan, from `docs/EXPLAIN_RESULTS.md` unless another source is named.

**Why the partial index.** Only 1,063,439 of 5,819,079 flights (18.3%) carry causes. Indexing only those keeps the index at 6.0 MB, against 28.1-50.8 MB for the five full-collection §6.2 indexes (`date_1`, `airline_1_date_1`, `origin_1_schedDepHour_1`, `route_1`, `isDelayed_1_month_1`), and cause pipelines only ever read those flights.

**Why the extra `airline_1_origin_1__id_1` index.** Without an airline-origin index, an empty pair such as HA + ATL walked all 5,819,079 documents. `{ airline, origin }` alone sometimes led the planner to sort a dense pair in memory (NK + FLL 513 ms). The trailing `_id` makes every page read at most 21 keys. It is the largest index (100.9 MB); DECISIONS.md records the trade-off.

**Considered and not added** (measurements in DECISIONS.md, Phase 2 and the Phase 3 close-out):
- `dest`: no endpoint reads by destination alone.
- `split`: low selectivity (75% `train`).
- `originIsIata`: 0.03% `false`, filtered cheaply after the `origin` match.
- A covering `{ origin, schedDepHour, isDelayed }` index: served by `stats_airport_hour` instead.
- `{ route: 1, _id: 1 }`: busy-route pages are 10-14 ms warm.

## Reference collections

| Collection | Shape | Indexes | Read by |
|---|---|---|---|
| `airlines` | `{ _id: IATA, name }` | `_id_` | Ingest (to denormalise `airlineName`), `/api/meta`, `/api/predict` code check (422 on an unknown code) |
| `airports` | `{ _id: IATA, name, city, state, country, latitude, longitude }` (nullable except `_id`, `name`) | `_id_` | Ingest (city/state), `resolve:airport-ids` (city/state for resolved rows), `/api/meta`, `/api/predict` code check |

Both are reloaded in full on every ingest and upserted by `_id`, so reloading is idempotent.

## Computed-pattern collections (`stats_*`)

**How they are built.** Each collection is produced by one pure pipeline builder in `server/src/stats/builders.ts`: `$match` (where a subset is aggregated) → `$group` → `$set` → `$merge { on: "_id", whenMatched: "replace", whenNotMatched: "insert" }`, run over `flights` with `allowDiskUse: true`. Every analytics endpoint reads these collections; none scans `flights`.

**Shared conventions.**
- `_id` is the group key.
- Delay-rate collections store the sums from `OUTCOME_ACCUMULATORS`: `flights`, `completed` (where `isDelayed` is not null), `delayed`, `cancelled`, `diverted` and `arrDelaySum`. They derive `delayRate = delayed / completed`, `cancelRate = cancelled / flights` and `avgArrDelay = arrDelaySum / completed`, each null when its denominator is 0. Storing sums keeps re-aggregation at read time exact (for example days into months).
- Cause minutes treat a null cause as 0 only inside the pipeline (`$ifNull`).
- **Every document carries `buildId`**, the UUID of the run that wrote it. After each `$merge`, `build:stats` runs `deleteMany({ buildId: { $ne: current } })`, so keys that no longer exist are swept, and the collection is never empty mid-build. A failed run leaves the previous complete set and is recorded in `stats_runs`. A second full build removed 0 stale documents (DECISIONS.md, Phase 3).

| Collection | `_id` (group key) | Other fields | Filter | Read indexes | Serves |
|---|---|---|---|---|---|
| `stats_daily` | `{ date, airline }` | `date`, `airline`, `dayOfWeek`, `month`, `minId`, `maxId`, outcome sums and rates, `causeMinutes { carrier, weather, nas, security, lateAircraft }`, `flightsWithCauses`, `buildId` | none (every flight) | `{ airline: 1, date: 1 }` | `/analytics/summary`, `/analytics/trend` (overall and `?airline=`), `/analytics/delay-rate?by=airline` and `by=dow`, `/api/flights` `_id` bounds for date windows |
| `stats_daily_origin` | `{ date, origin, airline }` | `date`, `origin`, `airline`, outcome sums and rates, `buildId` | `originIsIata: true` | `{ origin: 1, date: 1 }`, `{ airline: 1, origin: 1, date: 1 }` | `/analytics/trend?origin=` and `?airline=&origin=` |
| `stats_route` | `route` | `route`, `origin`, `dest`, `distance` (`$max`), `scheduledTime` (approximate `$median`), outcome sums and rates, `buildId` | both ends IATA | `{ flights: -1 }` | `/analytics/delay-rate?by=route` (worst routes); `/api/predict` reads `distance` and `scheduledTime` (published schedule data, not outcomes) |
| `stats_airport_hour` | `{ airport, hour }` | `airport`, `hour`, outcome sums and rates, `causeMinutes`, `flightsWithCauses`, `buildId` | `originIsIata: true` | `_id_` only | `/analytics/delay-rate?by=origin` and `by=hour`, `/analytics/causes?by=airport` and `by=hour`, `/analytics/cascade` |
| `stats_cause_monthly` | `{ month, airline }` | `month`, `airline`, `carrier`, `weather`, `nas`, `security`, `lateAircraft` (minutes), `flightsWithCauses`, `buildId` | `causes: { $type: "object" }` (matches the partial index) | `_id_` only | `/analytics/causes?by=overall`, `by=airline`, `by=month` |
| `stats_cancellation` | `{ month, airline, reason }` (reason `A`-`D` or `unknown`) | `month`, `airline`, `reason`, `flights`, `buildId` | `cancelled: true` | `_id_` only | `/analytics/cancellations` |
| `stats_delay_buckets` | `$bucket` lower bound (boundaries -100000, -15, 0, 15, 30, 60, 120, 180, 100000 minutes) | `flights`, `buildId` | `isDelayed` not null | `_id_` only | `/analytics/delay-distribution` |
| `stats_dow_hour` | `{ dow, hour }` | `dow`, `hour`, outcome sums and rates, `buildId` | none | `_id_` only | `/analytics/heatmap` |

**Read cost.** All analytics endpoints answered with medians of 5-39 ms over HTTP with the cache off. The largest unindexed read is a scan of the 4,926 `stats_daily` documents (EXPLAIN_RESULTS.md). The small collections have no secondary index because scanning a few thousand small documents already meets the 1 s target; only `stats_daily_origin` (386,704 documents) needs its two read indexes.

**Build cost** (latest `stats_runs`): 137.9 s in total, peak Node RSS 106 MB.

| Collection | Build time |
|---|---|
| `stats_daily` | 23.0 s |
| `stats_daily_origin` | 33.8 s |
| `stats_route` | 20.8 s |
| `stats_airport_hour` | 19.3 s |
| `stats_cause_monthly` | 8.3 s |
| `stats_cancellation` | 5.7 s |
| `stats_delay_buckets` | 13.5 s |
| `stats_dow_hour` | 13.0 s |

**Coverage.** Airport-keyed collections (`stats_daily_origin`, `stats_route`, `stats_airport_hour`) exclude flights whose airport is still a numeric BTS id. `stats_runs.dataQuality` records the exact difference: 1,632 flights with an unresolved origin and 3,147 with an unresolved origin or destination. The API reports it in `coverage`.

## Model feature collections

Both are built by `npm run build:lookup` (`server/src/features/lookup.ts`) from the **train split only**: `split: "train"`, `isDelayed` not null, both airports IATA.

| Collection | `_id` | Fields | Indexes | Purpose |
|---|---|---|---|---|
| `delay_lookup_cells` | `{ airline, origin, dest, hour, month }` | the same five keys, `completed`, `delayed`, `buildId` | `_id_` | One `$group` pass over the train flights. Every rate is then derived from these 249,130 cells instead of rescanning `flights`. |
| `delay_lookup` | `"<scope>/<kind>/<key>"`, for example `full/originHour/MDT\|15` | `scope` (`full`, `fold1`, `fold2`, `fold3`), `kind` (`global`, `airline`, `origin`, `dest`, `originHour`, `route`), `key`, `completed`, `delayed`, `rate`, `buildId` | `{ scope: 1, kind: 1, key: 1 }` | Smoothed rate features: `rate = (delayed + 50 × globalRate) / (completed + 50)`. The `full` scope is used by test rows and `/api/predict`; `foldK` excludes fold K's months (1-3, 4-6, 7-9), so no training row's rate includes its own label. |

- Both collections use the same `$merge` + `buildId` sweep as `stats_*`.
- The latest run (`lookup_runs`) built the cells in 26.1 s and the whole lookup in 32.7 s.
- The server reads `delay_lookup` into memory once per process (`loadLookupTable`), so the API never queries it per request.

## Model registry

`model_runs` holds one document per registered training run, upserted by `modelVersion` from `ml/artifacts/metrics.json` (`server/src/ml/register.ts`, shape `ModelRunSchema` in `shared/src/model.ts`).

- **Fields:** `modelVersion`, `createdAt`, `registeredAt`, `algorithm`, `featureList`, `trainRange`, `validation`, `testRange` (`from`, `to`, `rows`), `excluded`, `classBalance`, `threshold`, `metrics` (`auc`, `prAuc`, `precision`, `recall`, `f1`, `threshold`, `confusion`), `models` (baseline, logistic regression and LightGBM results), `featureImportance[]`, `onnx`, `durationSeconds`, `versions`.
- **Indexes:**
  - `{ modelVersion: 1 }`, **unique**: `/api/model/*` looks up the run whose `modelVersion` equals the served `encoders.json`, not the newest one.
  - `{ createdAt: -1 }`: history ordering.
- **Guards:** registration refuses a run whose `featureList` contains a forbidden (post-departure) feature or differs from `FEATURE_COLUMNS`.
- **Contents:** two runs are stored. The served one is `lightgbm-20261013093139-12f165c2`, with test AUC 0.6276 (`metrics.json`).

## Run and audit collections

Every batch job records one document per run, including failed runs (`status: "failed"`, `error`), so volume and memory claims can be checked in the database. Each has only the `_id_` index; they are written once per run and read rarely.

| Collection | Fields | Used for |
|---|---|---|
| `ingest_runs` | `startedAt`, `finishedAt`, `file`, `status`, `mode` (`drop`, `append`, `fresh`, `reference`), `rowsRead`, `rowsInserted`, `rowsRejected`, `rejectReasons{}`, `peakRssMb`, `error?` | Ingest evidence. Full `--drop` loads: 5,819,079 read and inserted, 0 rejected; 296 s at 342 MB peak RSS (2026-10-11) and 421 s at 362 MB (2026-10-16 reproduction, machine shared with other jobs). Also used by `/api/flights` to decide whether the `stats_daily` `_id` bounds are fresh. |
| `resolve_runs` | `mode` (`dry-run`, `apply`), `thresholds { minVotes, minTopShare }`, `referenceMonths`, `referenceRows`, `referenceKeys`, `ambiguousKeys`, `rowsWithNumericIds`, `rowsMatched`, `distinctIds`, `mappedIds`, `unmappedIds[]`, `rowsFullyResolved`, `rowsOriginResolved`, `rowsDestResolved`, `rowsUpdated`, `peakRssMb`, plus timestamps, `status`, `error?` | Airport-id resolution evidence |
| `stats_runs` | `buildId`, `startedAt`, `finishedAt`, `status`, `collections[] { collection, ms, docs, staleRemoved }`, `totalMs`, `peakRssMb`, `dataQuality { flights, unresolvedOriginFlights, unresolvedRouteFlights }`, `error?` | Stats build evidence; `dataQuality` feeds `/api/meta` and `coverage` |
| `lookup_runs` | `buildId`, timestamps, `status`, `m`, `cellsMs`, `cellsDocs`, `lookupDocs`, `scopes[] { scope, completed, delayed, globalRate }`, `error?` | Lookup build evidence. `export:training` refuses to run unless the last lookup build completed. |
| `export_runs` | timestamps, `status`, `dir`, `trainRows`, `testRows`, `excludedUnresolvedAirport`, `excludedNoOutcome`, `nullScheduledTime`, `peakRssMb`, `error?` | Training export evidence |

## Sharding (design only)

No collection is sharded, and no sharded cluster was built. The design for `flights` is the shard key `{ origin: 1, date: 1 }`; see `docs/BIGDATA_JUSTIFICATION.md`, "Sharding strategy". All other collections are small enough to stay unsharded.
