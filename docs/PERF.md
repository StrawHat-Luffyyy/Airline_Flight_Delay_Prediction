# Performance measurements

These are measured results only. Each section names its date, method and setup. Index evidence for the batch analytics queries is in `docs/EXPLAIN_RESULTS.md`.

## GET /api/stream/status and /api/health (Phase 8e, 2026-10-22)

**Setup:**
- Windows 11.
- Docker Desktop with 7.61 GiB and 12 CPUs (as recorded in 8a).
- MongoDB 7.0.43 and Kafka `apache/kafka:4.3.1`, both in Docker.
- The API ran as the dev server (`npm run dev --workspace=@flight-delay/server`, port 3001), with the model `lightgbm-20261013093139-12f165c2` loaded.

**Data:**
- `stream_flights` held the full December replay: 479,230 flights, all scored, 469,717 of them judged.
- The rolling window was the default 2,000.

**Method:**
- A Node script timed each request client-side with `fetch` (`performance.now()` around request and body).
- **Uncached** runs waited 4 s before each request. That is longer than the 3 s MongoDB metrics cache and the 2 s Kafka cache, so every timed status request ran all of its MongoDB counts and its Kafka admin calls.
- Each figure below is the **median of 3** such runs.

### With Kafka up

| Endpoint | Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|---|
| `GET /api/stream/status` (uncached) | 250.6 ms | 133.9 ms | 158.6 ms | **158.6 ms** |
| `GET /api/health` | 16.0 ms | 6.8 ms | 6.8 ms | **6.8 ms** |

- **Target:** under 1 s with the full December replay loaded. **Met.**
- **After the outage below,** with Kafka back, the same uncached status request measured 119.4, 133.6 and 124.4 ms (median 124.4 ms).
- **A fix found by measuring.** The first version took 891 ms (median). Almost all of it, about 780 ms, came from one `distinct('prediction.modelVersion', {$type: 'string'})`: the `$type` filter turned a DISTINCT_SCAN into an IXSCAN + FETCH of all 479,230 documents. Running the distinct unfiltered and dropping the null in code made it a 1-key DISTINCT_SCAN.

### Kafka stopped (real outage, not a mock)

**Sequence** (one script):
1. `docker compose stop kafka` (took 1.5 s; the container then showed `exited`);
2. three uncached status + health pairs, 4 s apart;
3. `docker compose start kafka`;
4. poll status every 1 s until Kafka was reachable;
5. three more pairs.

The API was **not** restarted at any point.

| While Kafka was stopped | Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|---|
| `GET /api/stream/status` (uncached), HTTP 200 | 1,125.7 ms | 1,016.0 ms | 1,022.4 ms | **1,022.4 ms** |
| `GET /api/stream/status` (repeated at once, cached) | 14.4 ms | 12.4 ms | 12.8 ms | 12.8 ms |
| `GET /api/health`, HTTP 200 | 15.2 ms | 13.2 ms | 10.9 ms | **13.2 ms** |

- **Status body:** `state: "degraded"`, with reason `"Kafka unreachable: Kafka admin request timed out after 1000 ms"`, `kafka.lag: null` and `kafka.dlqMessages: null`. The MongoDB metrics were still reported (`stored.flights: 479230`).
- **Why about 1 s:** the status request is bounded by the 1 s Kafka timeout (`KAFKA_TIMEOUT_MS`) plus the MongoDB reads.
- **Health body:** `{"status":"ok","mongo":"up","modelLoaded":true,"kafka":"down"}`. The overall status and HTTP code were unchanged.
- **Why health stays fast:** it reports the last completed Kafka probe and refreshes behind it, so it never waits on Kafka.
- **Recovery:** Kafka was reachable again **4.7 s** after `docker compose start kafka` returned (4 polls), with no API restart. The state returned to `idle` (no consumer running), with `lag.total: 0`.

**Contained native crash.** During each broker restart, the librdkafka client's `fetchOffsets` crashed its process with exit code 3221225477 (0xC0000005, an access violation). It is reproducible with a short script that uses only `@confluentinc/kafka-javascript` (see `docs/DECISIONS.md`, Phase 8e). The admin calls therefore run in a separate probe process.
- In the final run the API logged `Kafka probe process exited (code 3221225477); a new one starts on the next read`. It kept serving, and the next probe process connected.
- Before the isolation, the same restart killed the whole API, 4 times out of 4.

### Query plans on the real collection

`explain("executionStats")` on `stream_flights` (479,230 documents) for each query behind the endpoint:

| Query | Plan | Index | Keys examined | Docs examined |
|---|---|---|---|---|
| Rolling window (2,000, replay order) | LIMIT ← FETCH ← IXSCAN | `firstWrittenAt_-1__id_-1` | 2,006 | 2,006 |
| Count TP | COUNT ← COUNT_SCAN | `stream_totals` | 56,480 | 0 |
| Count FP | COUNT ← COUNT_SCAN | `stream_totals` | 146,807 | 0 |
| Count FN | COUNT ← COUNT_SCAN | `stream_totals` | 40,294 | 0 |
| Count TN | COUNT ← COUNT_SCAN | `stream_totals` | 226,140 | 0 |
| Count scored, no outcome (each label) | COUNT ← OR ← 2 × COUNT_SCAN | `stream_totals` | 5,177 / 4,340 | 0 |
| Count with no prediction | COUNT ← OR ← 2 × COUNT_SCAN | `stream_totals` | 2 | 0 |
| Count refused | COUNT ← IXSCAN | `stream_totals` | 1 | 0 |
| Distinct model versions | DISTINCT_SCAN | `stream_totals` | 1 | 0 |
| Distinct thresholds of a version | DISTINCT_SCAN | `stream_totals` | 1 | 0 |
| Newest heartbeat (`stream_stats`) | LIMIT ← FETCH ← IXSCAN | `lastSeenAt_ttl` | 1 | 1 |

- **No COLLSCAN anywhere.** The window reads 6 documents past its 2,000 because unjudged flights (cancelled or diverted) are interleaved and filtered out.
- **Regression test:** `server/tests/stream/status.integration.test.ts` asserts these plan shapes on a seeded test database: IXSCAN with no SORT and no COLLSCAN, COUNT_SCAN, and DISTINCT_SCAN with no FETCH.
