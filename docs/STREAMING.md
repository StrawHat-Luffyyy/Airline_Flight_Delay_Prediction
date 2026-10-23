# Streaming layer: acceptance measurements (Phase 8g)

This is the record for `PROJECT_OVERVIEW.md` §15.9. Every figure below was measured on 2026-10-22 and names its evidence file in `docs/measurements/`. Anything not measured is marked "not measured". The design and the reasoning behind it are in `docs/DECISIONS.md` (Phase 8a to 8f); the status endpoint's timings are in [`docs/PERF.md`](PERF.md).

The speed layer replays December 2015 from `data/raw/flights.csv` into Kafka. A consumer writes each flight to MongoDB (`stream_flights`) and scores it with the same predictor as `POST /api/predict`. **This is simulated velocity: a replay of 2015 data, not a live feed.**

## What was measured and how

### Setup

| Item     | Value                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| Host     | Windows 11, Docker Desktop with 7.61 GiB and 12 CPUs                                                                     |
| MongoDB  | 7.0.43, single node in Docker                                                                                            |
| Kafka    | `apache/kafka:4.3.1`, one node in KRaft mode, `flights.raw` with 3 partitions, replication factor 1                      |
| Client   | `@confluentinc/kafka-javascript` 1.11.0                                                                                  |
| Model    | `lightgbm-20261013093139-12f165c2`, threshold 0.20697 (frozen at training)                                               |
| Consumer | one `stream:consume` process: batches of up to 500, 3 partitions consumed concurrently, live scoring on every new flight |

Producer, consumer, MongoDB and Kafka all ran on the same machine, so `producedAt` (stamped by the producer) and `firstWrittenAt` (stamped by the consumer) come from one clock. No clock-skew correction was needed.

### Method

Each measured run started from an empty speed layer:

1. `npm run stream:reset -- --db flight_delay --yes` cleared `stream_flights`, `stream_stats`, the consumer group's offsets and the messages on `flights.raw` and `flights.dlq`. It touches no batch collection.
2. `npm run stream:consume -- --idle-exit <seconds>` was started first, so it exits on its own once the backlog is drained. The idle limit counts from the consumer's start, so it was set above the producer's read of January to November: 120 s for runs A, B and C, 150 s for the re-replay, and 300 s then 60 s for the two consumers of run D (`run-d-crash-consumer.json`).
3. `npm run stream:replay -- --month 12 --rate <r> [--limit <n>]` sent the flights.
4. After the consumer caught up, `npm run stream:measure -- --out docs/measurements/<file>.json` recorded the run. It is read-only and combines:
   - the producer-run document in `stream_stats` (rows of the month, events sent, send-phase time);
   - Kafka offsets (messages on each topic, the consumer group's lag);
   - an aggregation over `stream_flights` for the run (`$match` on `runId`, then `$group`).
5. Once all runs were done, with the consumer stopped and the API running, `npm run stream:verify-status` checked `GET /api/stream/status` (item 7).

Definitions used by `stream:measure` (`server/src/stream/measure.ts`):

| Figure        | Definition                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Producer rate | events sent ÷ send phase (first December row to last broker acknowledgement)                                                                                                          |
| Consumer rate | flights first stored by the run ÷ time from their first to their last `firstWrittenAt`                                                                                                |
| Latency       | `firstWrittenAt − producedAt` per flight. p50, p95 and p99 come from MongoDB 7.0 `$percentile` with `method: "approximate"` (the only method 7.0 offers); min, max and mean are exact |
| Upserts       | the sum of `deliveries` in `stream_flights` (one per message the consumer stored)                                                                                                     |

The runs, in the order they were made:

| Run         | Command flags                | Started from           | Evidence                                                            |
| ----------- | ---------------------------- | ---------------------- | ------------------------------------------------------------------- |
| A           | `--rate 500 --limit 30000`   | reset                  | `run-a-500.json`                                                    |
| B           | `--rate 2000 --limit 120000` | reset                  | `run-b-2000.json`                                                   |
| D (crash)   | `--rate 0 --limit 100000`    | reset                  | `run-d-crash-before-restart.json`, `run-d-crash-after-restart.json` |
| C           | `--rate 0` (all of December) | reset                  | `run-c-unthrottled.json`                                            |
| C re-replay | `--rate 0 --limit 5000`      | run C's data, no reset | `run-c-rereplay-5000.json`                                          |

## Results

| #   | Item                                 | Result              | Key figures                                                                                                                                                                                                                                               | Evidence                                                                                                   |
| --- | ------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Conservation                         | **PASS**            | Run C: 479,230 month rows = 479,230 sent + 0 producer DLQ; 479,230 on `flights.raw` = 479,230 upserts + 0 consumer DLQ. Runs A and B pass the same checks.                                                                                                | `run-c-unthrottled.json`, `run-a-500.json`, `run-b-2000.json`                                              |
| 2   | Unique keys                          | **PASS**            | Run C: 479,230 stored = 479,230 distinct keys                                                                                                                                                                                                             | `run-c-unthrottled.json`                                                                                   |
| 3   | Idempotent replay                    | **PASS**            | `stream_flights` stays 479,230; deliveries 479,230 → 484,230                                                                                                                                                                                              | `run-c-rereplay-5000.json`                                                                                 |
| 4   | Crash recovery                       | **PASS**            | Run F: a hard kill landed mid-batch (500 flights written but not committed); after restart those 500 were redelivered (`deliveries` = 2), 200,000 stored = 200,000 distinct keys, 0 duplicates, lag 0. Run D: a kill between batches, nothing redelivered | `run-f-*.json`, `run-d-crash-*.json`                                                                       |
| 5   | Throughput at three rates            | **PASS** (measured) | Consumer 506/s, 1,190/s, 2,018/s and 2,442/s at 500/s, 1,200/s, 2,000/s and unthrottled                                                                                                                                                                   | `run-a-500.json`, `run-b-2000.json`, `run-c-unthrottled.json`                                              |
| 6   | Latency p50 / p95                    | **PASS** (measured) | **Headline, 1,200/s (about 49% of capacity), steady state: 423 / 2,238 ms**; whole run including start-up 1,098 / 9,424 ms. Also 63 / 906 ms at 500/s and 138 / 2,236 ms at 2,000/s; unthrottled is queueing delay under overload (below)                 | `run-e-1200-steady.json`, `run-e-1200.json`, `run-a-500.json`, `run-b-2000.json`, `run-c-unthrottled.json` |
| 7   | Status metrics match a recomputation | **PASS**            | 35 of 35 checks match                                                                                                                                                                                                                                     | `verify-status.json`                                                                                       |

### 1 and 2. Conservation and unique keys

`stream:measure` runs five checks per run. All five passed in runs A, B and C, and in run D after the restart.

| Check                                   | Run A (500/s)       | Run B (2,000/s)       | Run C (unthrottled)   |
| --------------------------------------- | ------------------- | --------------------- | --------------------- |
| Month rows = sent to raw + producer DLQ | 30,000 = 30,000 + 0 | 120,000 = 120,000 + 0 | 479,230 = 479,230 + 0 |
| Raw topic holds exactly what was sent   | 30,000 = 30,000     | 120,000 = 120,000     | 479,230 = 479,230     |
| Raw messages = upserts + consumer DLQ   | 30,000 = 30,000 + 0 | 120,000 = 120,000 + 0 | 479,230 = 479,230 + 0 |
| Stored flights = distinct keys produced | 30,000 = 30,000     | 120,000 = 120,000     | 479,230 = 479,230     |
| Consumer lag                            | 0                   | 0                     | 0                     |
| Scored / refused                        | 30,000 / 0          | 120,000 / 0           | 479,230 / 0           |

- **How "distinct keys produced" is counted.** The check compares the `stream_flights` count with the largest single run since the reset, minus consumer DLQ messages. That equals the distinct keys only because the source has no duplicate keys: December has 479,230 rows and 479,230 distinct flight keys, measured read-only on `flights` in 8b (`docs/DECISIONS.md`, Phase 8b). The script does not count distinct keys on the topic itself.
- **The DLQ path was not exercised by real data.** December has no rows the transformer rejects and no malformed messages, so every DLQ term above is 0. The DLQ path is covered by unit tests and `stream:smoke` (`docs/DECISIONS.md`, Phase 8c).

### 3. Idempotent replay

Right after run C, the first 5,000 December rows were replayed again (`--rate 0 --limit 5000`) with no reset (source: `run-c-rereplay-5000.json`; the "after run C" column is from `run-c-unthrottled.json`).

| Measure                               | After run C | After the re-replay              |
| ------------------------------------- | ----------- | -------------------------------- |
| `stream_flights` documents            | 479,230     | 479,230                          |
| Flights first stored by the re-replay | n/a         | 0                                |
| Sum of `deliveries`                   | 479,230     | 484,230 (+5,000)                 |
| Messages on `flights.raw`             | 479,230     | 484,230 = 484,230 sent in 2 runs |
| Scored / refused                      | 479,230 / 0 | 479,230 / 0                      |
| Lag                                   | 0           | 0                                |

The 5,000 re-sent events were consumed and upserted onto existing documents; only `deliveries` changed. This re-sent a prefix of the same replay, not all 479,230 events a second time. 8c ran the same kind of test without live scoring (5,000 re-sent, 0 inserted; `docs/DECISIONS.md`, Phase 8c).

### 4. Crash recovery

Run D replayed 100,000 flights unthrottled. While the consumer was writing, it was hard-killed with PowerShell `Stop-Process -Force`.

| Measure                               | Before restart                                 | After restart                |
| ------------------------------------- | ---------------------------------------------- | ---------------------------- |
| `stream_flights` documents            | 58,530                                         | 100,000                      |
| Sum of `deliveries`                   | 58,530                                         | 100,000                      |
| Consumer lag                          | 41,470 (= 100,000 − 58,530)                    | 0                            |
| Raw messages = upserts + consumer DLQ | FAIL (100,000 vs 58,530 + 0), expected mid-run | PASS (100,000 = 100,000 + 0) |
| Stored = distinct keys                | FAIL (58,530 vs 100,000), expected mid-run     | PASS (100,000 = 100,000)     |
| Lag = 0                               | FAIL, expected mid-run                         | PASS                         |
| Scored / refused                      | 58,530 / 0                                     | 100,000 / 0                  |

Sources: `run-d-crash-before-restart.json`, `run-d-crash-after-restart.json`.

- **Nothing lost, nothing duplicated.** `_id` is the flight key, so 100,000 documents means 100,000 distinct flights, and lag 0 means every message on the topic was processed.
- **No redelivery in this run.** The sum of `deliveries` equals the document count (100,000), so no message was processed twice. The restarted consumer's final counters were 41,470 consumed, 41,470 inserted and 0 redelivered, in 87 batches (`run-d-crash-consumer.json`, from its own log). The kill landed between batches, after a commit.
- **Redelivery inside the write-to-commit window** was exercised in the 8c crash test instead (`docs/DECISIONS.md`, Phase 8c; `docs/PHASE8_STATUS.md`): killed at 316,598 stored with 318,598 offsets committed, the restart consumed 167,832 and inserted 162,632, giving 479,230 flights with no duplicates. That test ran without live scoring (8c predates it), in the separate database `flight_delay_crash_test`.
- **A killed consumer leaves `status: "running"` behind.** After the kill, its heartbeat document still said `running`, last seen at 14:13:27.602 UTC with 52,002 messages consumed (`run-d-crash-consumer.json`, printed by mongosh right after the kill). This is why the status endpoint judges liveness by the age of `lastSeenAt` (stale after 10 s), not by the stored status (`docs/DECISIONS.md`, Phase 8e).
- **Run D is not a latency or throughput figure.** Its timings include the deliberate downtime (p50 15,686 ms after restart), so they are left out of items 5 and 6.

#### Run F: a kill inside the write-to-commit window

Run D's kill landed between batches, so it could not show redelivery. Run F set out to land one inside a batch: after its MongoDB write, before its offset commit. That is the only window where at-least-once delivery produces a duplicate delivery.

- **Setup:** from an empty speed layer, replay 200,000 events at 1,000/s (`--rate 1000 --limit 200000`), a pace the consumer handles continuously, so a kill at a random moment has a fair chance of landing mid-batch.
- **How a hit is detected:** right after each hard kill (`Stop-Process -Force`), `stream:measure` compared the flights stored with the messages committed (messages on the topic minus the group's lag).
  - Committed offsets are final once the process is dead.
  - Every key in the run is new, so stored = written.
  - Written > committed means a batch was written and not committed, so Kafka must redeliver it.

| Attempt | Flights written | Messages committed | Written but not committed           | Source                      |
| ------- | --------------- | ------------------ | ----------------------------------- | --------------------------- |
| 1       | 18,000          | 18,000             | 0 (between batches)                 | `run-f-kill-attempt-1.json` |
| 2       | 31,554          | 31,054             | **500** (one full batch, mid-batch) | `run-f-kill-attempt-2.json` |

After attempt 2 a third consumer was started and ran to the end:

| Measure                                           | Value                                                          | Source                           |
| ------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| Produced (sent to `flights.raw`)                  | 200,000                                                        | `run-f-midbatch-final.json`      |
| Upserts (messages processed, summed `deliveries`) | 200,500 = 200,000 + **500 redelivered**                        | `run-f-midbatch-final.json`      |
| Flights with `deliveries` = 1 / = 2               | 199,500 / **500**                                              | `run-f-midbatch-deliveries.json` |
| Restarted consumer's own counters                 | 168,946 consumed, 168,446 inserted, **500 redelivered**, 0 DLQ | `run-f-midbatch-deliveries.json` |
| Consumer DLQ                                      | 0                                                              | `run-f-midbatch-final.json`      |
| Distinct keys stored                              | 200,000 for 200,000 keys sent                                  | `run-f-midbatch-final.json`      |
| Duplicates                                        | **0** (`_id` is the flight key; 200,000 documents)             | `run-f-midbatch-final.json`      |
| Lag at the end                                    | 0                                                              | `run-f-midbatch-final.json`      |

- **What this shows:** the redelivered batch is exactly the 500 written-but-uncommitted messages. Kafka delivered them again, the upsert turned each into an update of `deliveries`, and no second document was created. This is the at-least-once + idempotent-write guarantee working under a real crash, with live scoring on (redeliveries are not re-scored).
- **Heartbeat counters lag the truth.** The killed consumers' last heartbeats said 16,300 and 11,554 consumed, against 18,000 and 13,554 actually written (heartbeats are written every 2 s). This is why the totals come from `stream_flights` and Kafka offsets, not from heartbeats.
- **Size of the gap:** 500, exactly one consumer batch at its maximum size (`MAX_BATCH` in `server/src/stream/consumer.ts`), consistent with one partition's batch having been written and not yet committed.

### Kafka restart under load (run G)

From an empty speed layer, 150,000 events were replayed at 1,000/s with one consumer running and the API up. When about 41,500 flights were stored, the broker was stopped with `docker compose stop kafka` (issued 15:17:25 UTC, stopped 15:17:29) and started again with `docker compose start kafka` at 15:17:56 to 15:17:57: **about 28 s down**. Nothing else was restarted.

| Component                   | What it did                                                                                                                                                                                                                                       | Evidence                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Producer (`stream:replay`)  | Blocked while the broker was down, then resumed at its paced rate; finished all 150,000 sends with no warning or error and exit code 0. Its send phase stretched to 191,009 ms (785/s achieved against 1,000/s)                                   | `run-g-kafka-restart.json` (`producer`), replay log           |
| Consumer (`stream:consume`) | Logged no warning or error and was **not restarted**. It stored nothing from 15:17:29 until **15:18:39, about 42 s after the broker started**, then caught up: all 150,000 stored by 15:19:55                                                     | `run-g-kafka-restart-status.json`, `run-g-kafka-restart.json` |
| `GET /api/stream/status`    | Answered **200** throughout (every request in at most 1.02 s while the broker was down). `degraded` with "Kafka unreachable: Kafka admin request timed out after 1000 ms" in all 19 samples from 15:17:29 to 15:18:05; `live` again from 15:18:07 | `run-g-kafka-restart-status.json`                             |
| API Kafka probe process     | Crashed once with exit code 3221225477 (0xC0000005) at 15:18:07, as the broker came back; the API logged it, kept serving and started a new probe process (`docs/DECISIONS.md`, Phase 8e)                                                         | API log                                                       |

Final counts (`run-g-kafka-restart.json`): 150,000 sent = 150,000 on `flights.raw` = 150,000 upserts = 150,000 flights for 150,000 keys; `deliveries` 1 for every flight (no redelivery); 0 DLQ; lag 0. All checks pass. Latency for this run (p50 214 ms, p95 32,068 ms, max 87,139 ms) includes the outage and the consumer's 42 s resume, so it is not a latency figure.

- **Recovers without restarting anything.** Producer, consumer and API all continued on their own; nothing was lost or duplicated.
- **The consumer resumes slowly.** About 42 s passed between the broker starting and the consumer storing again. The cause (broker start-up, group coordinator recovery, session and rebalance timing in librdkafka) was not isolated.
- **Limitation, since fixed: "live" while stalled.** From 15:18:07 to 15:18:39 the endpoint reported `live`, because the consumer's heartbeat was fresh, while throughput was 0 and lag grew to 28,000 (16 samples). Liveness is judged by heartbeat age only; a consumer that is alive but not progressing is visible only through lag and throughput, not through `state`.

### 5. Throughput (with live scoring)

| Replay rate              | Flights | Producer achieved | Send phase | Consumer rate | Consumer span (first to last write) | Source                   |
| ------------------------ | ------- | ----------------- | ---------- | ------------- | ----------------------------------- | ------------------------ |
| 500/s                    | 30,000  | 500/s             | 59,953 ms  | 506/s         | 59,328 ms                           | `run-a-500.json`         |
| 1,200/s (run E)          | 120,000 | 1,200/s           | 100,037 ms | 1,190/s       | 100,867 ms                          | `run-e-1200.json`        |
| 2,000/s                  | 120,000 | 2,002/s           | 59,951 ms  | 2,018/s       | 59,472 ms                           | `run-b-2000.json`        |
| Unthrottled (`--rate 0`) | 479,230 | 12,542/s          | 38,210 ms  | **2,442/s**   | 196,258 ms                          | `run-c-unthrottled.json` |

- **At 500/s and 2,000/s the consumer keeps up.** Its rate matches the producer's. It reads slightly higher because its span (first to last write) is a little shorter than the producer's send phase.
- **Unthrottled, the consumer is the bottleneck.** The producer sent all of December in 38.2 s; the consumer took 196.3 s to store and score it, so the backlog sat in Kafka and drained after the producer had finished. Lag still ended at 0.
- **Why about 2.4k/s.** Live scoring bounds the consumer. Earlier per-component figures (`docs/PHASE8_STATUS.md`):

  | Component alone                           | Rate     | Phase |
  | ----------------------------------------- | -------- | ----- |
  | Producer, all of December, `--rate 0`     | 9,987/s  | 8b    |
  | Consumer inserts without scoring          | 10,904/s | 8c    |
  | Scoring backfill (`stream:score-missing`) | 2,807/s  | 8d    |

  The consumer with scoring (2,442/s) sits just under scoring alone, and far under unscored inserts. This is one consumer process; scaling out (more consumer processes in the group, up to one per partition) was not measured.

- **Producer, whole run C:** 109,673 ms including reading January to November to reach December, at a peak RSS of 298 MB (`run-c-unthrottled.json`, `producer.elapsedMs` and `producer.peakRssMb`, read from the same producer-run record). Reading January to November took about 71 s in this run (109.7 s minus the 38.2 s send phase); 8b measured 93 to 95 s for the same read, so this figure varies between runs on this machine.

### Scaling out: two consumers against one (runs H1 and H2)

Two back-to-back runs under the same host conditions, each from an empty speed layer, replaying 150,000 events unthrottled so the consumers are saturated:

| Run | Consumers in `flight-stream` | Consumer rate (stored and scored) | Span, first to last write | All checks | Source                      |
| --- | ---------------------------- | --------------------------------- | ------------------------- | ---------- | --------------------------- |
| H1  | 1                            | **1,736/s**                       | 86,419 ms                 | pass       | `run-h1-one-consumer.json`  |
| H2  | 2                            | **2,155/s** (1.24x)               | 69,610 ms                 | pass       | `run-h2-two-consumers.json` |

Why only 1.24x, from the data (`run-h2-partitions.json`):

- **Partitions, not consumers, are the unit of parallelism.** `flights.raw` has 3 partitions, so two consumers split them 1 + 2. One consumer read partition 1 (56,384 messages); the other read partitions 0 and 2 (54,902 + 38,714 = 93,616, 62.4% of the run). The run lasts as long as the consumer with two partitions.
- **That bounds the ideal at 1.60x.** At H1's single-process rate, 93,616 messages take 53.9 s, which would be 2,782/s overall. The partitions are also uneven because the key is the origin airport.
- **The rest is contention.** The two-partition consumer took the whole 69.6 s, about 1,345/s, 23% slower than one consumer alone. Both processes score with ONNX on the CPU and write to the same MongoDB, on a laptop already at 51% CPU with 1.2 GB free memory after the run.
- **Three consumers** (one per partition) would be bounded by the largest partition (37.6% of this run, at most 2.66x) and by the same contention. This was not measured.
- **H1 against run C.** H1's 1,736/s is lower than run C's 2,442/s. The host load differed between the morning and the evening, so only H1 and H2 are compared with each other.

### 6. End-to-end latency

Latency is `firstWrittenAt − producedAt`, in milliseconds.

**Headline: a sustainable rate.** Run E replayed 120,000 flights at **1,200/s, about 49% of the measured consumer capacity with live scoring (2,442/s, run C)**, from an empty speed layer.

| Run E, 1,200/s                                                         | p50     | p95       | p99    | Min | Max    | Mean  | Flights                               | Source                   |
| ---------------------------------------------------------------------- | ------- | --------- | ------ | --- | ------ | ----- | ------------------------------------- | ------------------------ |
| **Steady state** (flights produced after the start-up backlog drained) | **423** | **2,238** | 2,686  | 44  | 3,060  | 691   | produced 14:58:51.9 to 14:59:52.9 UTC | `run-e-1200-steady.json` |
| Whole run, including start-up                                          | 1,098   | 9,424     | 10,199 | 44  | 10,873 | 2,773 | 120,000                               | `run-e-1200.json`        |

**Consumer lag over time**, sampled every 2 s from `GET /api/stream/status` by `npm run stream:watch` (`run-e-1200-lag.json`; resolution limited by the endpoint's 2 to 3 s caches). Time is seconds after lag first rose above 0, every third sample until the run was fully stored:

| t (s) | Lag (messages) | Flights stored | Consumer throughput (/s) |
| ----- | -------------- | -------------- | ------------------------ |
| 0     | 3,296          | 2              | 0                        |
| 6     | 8,158          | 2              | 0                        |
| 12    | 10,258         | 7,502          | 1319                     |
| 18    | 11,687         | 10,873         | 935                      |
| 24    | 8,158          | 24,002         | 2242                     |
| 30    | 5,578          | 31,502         | 1481                     |
| 36    | 120            | 46,569         | 2546                     |
| 42    | 332            | 51,240         | 997                      |
| 48    | 1,080          | 60,000         | 1082                     |
| 54    | 720            | 65,398         | 1466                     |
| 60    | 1,200          | 74,400         | 1004                     |
| 66    | 2,283          | 78,180         | 741                      |
| 72    | 0              | 90,006         | 1923                     |
| 78    | 333            | 94,795         | 1136                     |
| 84    | 74             | 104,483        | 1355                     |
| 90    | 76             | 109,320        | 1217                     |
| 96    | 2,880          | 116,211        | 714                      |
| 100   | 0              | 120,000        | 1240                     |

- **Why the steady state is the headline.** In the first samples after December started arriving the consumer had stored 2 flights; by t = 12 s it was storing at full speed. Its reference-data cache starts empty, so the first batches do several MongoDB reads per flight (`docs/DECISIONS.md`, Phase 8d), on top of process warm-up. Lag built to 11,687 at t = 18 s and was back near zero (120) at t = 36 s. From then on (cut at the first sample with lag at or below 1,200, one second of input, after the peak) lag stayed between 0 and 2,880 messages (median 720 over 32 samples), and the whole-run tail is that start-up backlog.
- **Host load.** Run E ran while the laptop was busy with other desktop applications: 62% host CPU and 2.2 GB of free memory right after the run, with MongoDB at 4.2 GiB and Kafka at 627 MiB (`run-e-host-load.json`). The read of January to November took 122.7 s against 71 s in run C. Host load was not recorded for runs A to D, so their latencies (below) are not directly comparable with run E.
- **A first attempt at run E failed.** The consumer was started with `--idle-exit 120`, which counts from its start. The read phase took longer than 120 s, so the consumer exited before the first event arrived and consumed nothing. That attempt was discarded, the speed layer reset, and run E repeated with `--idle-exit 400`.

**Other paced runs** (host load not recorded):

| Replay rate | p50 | p95   | p99   | Min | Max   | Mean | Source            |
| ----------- | --- | ----- | ----- | --- | ----- | ---- | ----------------- |
| 500/s       | 63  | 906   | 1,778 | 32  | 2,281 | 155  | `run-a-500.json`  |
| 2,000/s     | 138 | 2,236 | 2,586 | 40  | 2,788 | 441  | `run-b-2000.json` |

**Unthrottled: queueing delay under overload, not processing time.**

| Replay rate | p50    | p95     | p99     | Min | Max     | Mean   | Source                   |
| ----------- | ------ | ------- | ------- | --- | ------- | ------ | ------------------------ |
| Unthrottled | 72,641 | 152,105 | 157,307 | 515 | 158,623 | 74,641 | `run-c-unthrottled.json` |

The producer sent at 12,542/s, about 5 times what the consumer can store and score (2,442/s), so events waited in Kafka for up to 158.6 s before being consumed. This measures how long the backlog took to drain, not the pipeline's speed; Kafka absorbing that burst without loss (lag 0 at the end) is the point of the log.

- **Granularity.** All events in one producer send batch share one `producedAt` (batches of `rate/10`, 1 to 500 events), and all flights in one consumer batch share one `firstWrittenAt`. Latency is therefore measured per batch pair, not per event.
- **Approximate percentiles.** p50, p95 and p99 come from MongoDB's t-digest `$percentile`; min, max and mean are exact.

### 7. Status metrics against an independent recomputation

`npm run stream:verify-status` was run against the running API once all runs were done (`stream_flights` holding run C's 479,230 flights), with the consumer stopped (source: `verify-status.json`).

- **35 of 35 checks match**: stored, scored, refused and unscored counts; the number of groups; window size, dates and departure hours; TP, FP, FN, TN, n, precision, recall, F1, base rate, accuracy, majority baseline and `noOutcome` for the whole replay; the same for the window, plus window ROC-AUC.
- **Independent path.** The script streams every `stream_flights` document through a cursor and classifies it by its stored `correct` and label, instead of the endpoint's COUNT_SCANs. It recomputes window ROC-AUC by counting every (delayed, on-time) pair, instead of the endpoint's rank-sum formula.
- **Recompute time:** 57.8 s. **No writes during the run** (`changedDuringRun: false`).

| Metric                       | Whole replay                                                  | Window (2,000 newest judged, replay order) |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| n (judged)                   | 469,717                                                       | 2,000                                      |
| TP / FP / FN / TN            | 56,479 / 146,806 / 40,293 / 226,139                           | 299 / 1,509 / 15 / 177                     |
| Precision                    | 0.278                                                         | 0.165                                      |
| Recall                       | 0.584                                                         | 0.952                                      |
| F1                           | 0.376                                                         | 0.282                                      |
| Base rate (delayed share)    | 0.206                                                         | 0.157                                      |
| Accuracy / majority baseline | 0.602 / 0.794                                                 | 0.238 / 0.843                              |
| ROC-AUC                      | not computed (would need all 469,717 probabilities in memory) | 0.585                                      |
| Scored, no arrival outcome   | 9,513                                                         | n/a                                        |

- **The window is a slice of the schedule.** It holds the 2,000 newest judged flights in replay order: all on 2015-12-31, departure hours 13 to 23. It is not a sample of December, and its AUC must not be compared with the test-set AUC.
- **Window values differ slightly from 8e** (8e and 8f: precision 0.164 of 1,797 flagged, so TP 295, and ROC-AUC 0.575; now TP 299 and 0.585; `docs/DECISIONS.md`, Phase 8f). This replay's consumer batches interleaved the three partitions differently, so a different set of late-December flights fell into the newest 2,000. The whole-replay totals are identical to 8d and 8e.
- **Stream totals are not the batch test metrics.** The model's test metrics (`ml/artifacts/metrics.json`: precision 0.218, recall 0.582) cover October to December. The stream covers December only, and `/predict`, which the stream reuses, takes the route's typical scheduled time and distance from `stats_route` rather than each flight's own (`docs/DECISIONS.md`, Phase 8d).

### Batch layer untouched

The batch collections were counted before the runs (speed layer empty) and after them (source: `batch-collections-before.txt`, `batch-collections-after.txt`). Every non-stream count is identical, for example `flights` 5,819,079, `delay_lookup` 36,420, `delay_lookup_cells` 249,130, `model_runs` 2 and `stats_route` 4,695. Only `stream_flights` (0 → 479,230) and `stream_stats` (0 → 4) changed.

## Reliability fixes after acceptance (2026-10-22 to 23)

Six broker-restart experiments (R1 to R6) ran in an **isolated environment**, so the accepted full-December state was not touched:

- database `flight_delay_reliability_test`, consumer group `reliability-test`, topics `reliability.raw` and `reliability.dlq`;
- a second API on port 3002;
- only the airline and airport reference data copied in.

Every flight was refused by the scorer there (no route statistics), which does not affect Kafka behaviour. Each run replayed 60,000 events at 1,000/s, and once about 15,000 were stored, stopped the broker for 28 s (`docker compose stop kafka`, then `start`). The main database (`flight_delay`: 479,230 stream flights) and `flights.raw` were checked unchanged afterwards.

### Findings and fixes

| #   | Finding (evidence)                                                                                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Verified                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **"live" while stalled.** After a broker restart the consumer was alive (fresh heartbeat) but stored nothing, and the endpoint said `live` (run G: 32 s).                                                                                                                              | The heartbeat records `lastBatchAt`. The state is `degraded` ("Consumer is alive but not making progress: no batch for N s with M messages waiting") when the heartbeat is fresh, lag is above 0, messages have been waiting more than 15 s **and** no batch has been stored for more than 15 s (`STALL_AFTER_MS`). The waiting window avoids a false alarm when new messages reach a consumer that has been idle: the first version flagged a stall once at start-up in R2. | R4 (`reliability-r4-status.json`): `degraded` with that reason in all 8 samples from 19:00:51 to 19:01:05, while the consumer was stalled (lag 16,478 to 30,078). `live` again at 19:01:07, the first sample after it resumed. No stall reported anywhere else in R3 or R4. Unit and service tests. |
| 2   | **Negative `unscored` failed the response schema.** `refused` and "no prediction" were two separate counts; with a consumer inserting refused flights, `refused` overtook the total, `unscored` went negative and the endpoint answered with its validation fallback (R1: 12 samples). | Both now come from one aggregation over the flights without a prediction (`noPredictionPipeline`, IXSCAN on `stream_totals`), so refused can never exceed the total.                                                                                                                                                                                                                                                                                                         | R3 and R4: 0 validation fallbacks. Integration test.                                                                                                                                                                                                                                                |
| 3   | **Slow resume after a broker restart.** The consumer resumed 36.9 s (R2) and 39.1 s (R4) after the broker started, with the client's default 30 s session timeout. Run G: about 42 s.                                                                                                  | New `KAFKA_SESSION_TIMEOUT_MS`, **default 10 s**. librdkafka sends group heartbeats from its own thread, so slow batches do not count against it; slow processing is still governed by the separate 5-minute poll interval.                                                                                                                                                                                                                                                  | R3 with 10 s: resumed **17.2 s** after the broker started, about 20 s sooner, matching the 20 s cut. R2 and R4 with 30 s: 36.9 s and 39.1 s. One run per setting.                                                                                                                                   |
| 4   | **`--idle-exit` counted from the process start.** A consumer started before a replay exits during the producer's read of January to November (71 to 123 s measured; run E's first attempt).                                                                                            | It now counts from the first batch (`idle-exit.ts`), and the consumer waits as long as needed for the first one.                                                                                                                                                                                                                                                                                                                                                             | Unit tests; R2 to R4 consumers waited through the read phase.                                                                                                                                                                                                                                       |

| Run | Session timeout       | Resumed after broker start | Stored / keys   | Redelivered (`deliveries` = 2) | Evidence                                                               |
| --- | --------------------- | -------------------------- | --------------- | ------------------------------ | ---------------------------------------------------------------------- |
| R2  | 30 s (client default) | 36.9 s                     | 60,000 / 60,000 | 75                             | `reliability-r2-outage.json`                                           |
| R3  | 10 s                  | 17.2 s                     | 60,000 / 60,000 | 75                             | `reliability-r3-outage.json`, `reliability-r3-status.json`             |
| R4  | 30 s (explicit)       | 39.1 s                     | 60,000 / 60,000 | 78                             | `reliability-r4-outage.json`, `reliability-r4-status.json`             |
| R5  | 10 s                  | 19.1 s                     | 60,000 / 60,000 | 40                             | `reliability-r5-outage.json`, `reliability-r5-probe-console-lost.json` |
| R6  | 10 s                  | 19.8 s                     | 60,000 / 60,000 | 100                            | `reliability-r6-outage.json`, `reliability-r6-status.json`             |

With 10 s the consumer resumed 17.2 to 19.8 s after the broker started (3 runs); with 30 s, 36.9 and 39.1 s (2 runs), and about 42 s in run G.

### What else the runs showed

- **At-least-once through an outage, at scale (R1).** The consumer kept storing messages it had already fetched for 12 s after the broker stopped, 32,800 flights in all, but only 16,800 had committed offsets. The other 16,000 could not commit.
  - When the topic was drained, exactly those 16,000 were redelivered: 16,000 flights with `deliveries` = 2, 60,000 flights for 60,000 messages, no duplicate documents (`reliability-r1-redelivery.json`).
  - The consumer logged **no warning** for the failed commits.
- **No warning or error from the project's own logging** in R2 to R4; every producer run completed its 60,000 sends (exit 0). The Kafka client prints its own transport warnings (`broker transport failure`) while the broker is down, seen in the R5 and R6 consumer logs.
- **The API's probe process crashed once per broker restart** (0xC0000005) and was replaced, so status showed Kafka reachable again within about 5 to 8 s of the broker starting (R3, R4).

### Remaining risks, fixed afterwards (R5 and R6)

| Risk                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                  | Verified                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Failed commits were silent.** In R1, 16,000 offsets were not committed although the client never returned a commit error, so watching commit errors cannot catch it. | The consumer notices the consequence instead: when a batch contains flights that are already stored, it logs a warning with how many (`redelivery-warning.ts`; at most one per 10 s, the rest folded into the next).                                                                                                                                                                                 | R5: one warning, `redelivered: 40`, exactly the 40 flights stored twice. R6: two warnings, 26 + 74 = 100, exactly the 100 stored twice. Unit tests.                                                                                                                                                                     |
| **The probe could not restart in an API that had lost its console.**                                                                                                   | Reproduced on Windows: a process forks a child every 3 s; once its console host is killed, every child dies at start-up with 0xC0000142. `windowsHide` and ignored stdio did not help; `detached: true` did, with and without piped output. The API now forks the probe detached, with its output piped back. A detached child still exits when the API is killed (its IPC channel closes; checked). | An isolated API whose console was killed before its probe started: Kafka reachable; then, on two broker restarts (R5b and R6), the probe crashed (0xC0000005, the known client crash), was replaced, and status was reachable again within about 6 s of the broker starting (`reliability-r5-probe-console-lost.json`). |
| **Single runs.**                                                                                                                                                       | Two more runs at 10 s (R5, R6).                                                                                                                                                                                                                                                                                                                                                                      | 17.2, 19.1 and 19.8 s; see the table above.                                                                                                                                                                                                                                                                             |
| **Isolated test data left behind.**                                                                                                                                    | `stream:reset` on the isolated environment.                                                                                                                                                                                                                                                                                                                                                          | `flight_delay_reliability_test` holds only its reference data (14 airlines, 322 airports) and ingest bookkeeping; `stream_flights` and `stream_stats` are empty, and the `reliability.*` topics have no records. The main database still holds 479,230 stream flights.                                                  |

### Lost offset commits: root cause and fix (2026-10-23)

**Root cause.** In `@confluentinc/kafka-javascript` 1.11.0 the KafkaJS-style `consumer.commitOffsets()` resolves when the commit is **queued**, not when the broker stores it:

- `commitOffsets()` calls the native `commitCb`, which runs `KafkaConsumer::Commit`, which runs librdkafka's `commitAsync` (`src/workers.cc`, `src/kafka-consumer.cc`). The callback reports only whether queueing worked.
- The broker's answer goes to librdkafka's offset-commit callback. The KafkaJS layer enables it (`offset_commit_cb = true`) but never listens to the `offset.commit` event it produces (`lib/kafkajs/_consumer.js`, marked TODO there). A commit that fails later is therefore dropped without an error.

In R1 the consumer kept processing messages it had already fetched after the broker stopped. Every commit resolved, so it marked each batch done and moved on. The broker never stored those commits, and the 16,000 flights were delivered again after the restart.

**Reproduced** with `npm run stream:commit-check -- --mode raw --yes`. It uses a throwaway topic and group: 6,000 messages in batches of 100, with the broker stopped for 20 s.

- All 28 commits that completed while the broker was stopped resolved, and none was rejected.
- After rejoining, the consumer restarted from offset 2,402, the last commit the broker had stored.
- It delivered 3,598 messages twice: offsets 2,402 to 5,999, the range whose commits had resolved during the outage (`commit-check-raw.json`).
- Three earlier runs with a prototype script gave the same picture: 38 of 38 commits resolved, and 3,798 messages delivered twice (`commit-repro-prototype.json`).

**Fix** (`server/src/stream/commit.ts`). After each commit the consumer reads the group's committed offset back from the broker (`consumer.committed`, 5 s bound per read). The offset must reach the one just committed within three reads, 50 ms apart; the queued commit may not have been sent when the first read goes out. Otherwise the batch fails:

- it is not marked processed;
- the error is logged ("commit … not confirmed") and the heartbeat reports `failed`;
- the consumer backs off, the client seeks back, and the batch is delivered again;
- the idempotent upsert absorbs the second delivery, so nothing is lost and no duplicate document is written.

Because no commit is believed until the broker confirms it, the consumer no longer runs ahead of its commits during an outage.

**Verified:**

- **`stream:commit-check -- --mode confirmed`:** 0 commits were believed while the broker was stopped. The one commit made then was rejected (`commit-check-confirmed.json`). After the restart the consumer resumed exactly after that commit: it had reached the broker as the broker shut down, so it was stored although it could not be confirmed. Nothing was delivered twice, and the final committed offset is 6,000 of 6,000.
- **An earlier confirmed run** (single read-back, before the review fixes): 1 commit rejected, and that one batch of 100 delivered twice (`commit-repro-prototype.json`, `verify1`).
- **R7, the real consumer through the same 28 s outage as R1 to R6** (single read-back version): three batches failed with "commit … not confirmed: reading it back failed (Local: Timed out)", one per partition. After the restart only 41 flights were delivered twice, against 16,000 in R1 and 40 to 100 in R2 to R6. All 60,000 were stored with no duplicate documents, and the consumer resumed 17.1 s after the broker started (`reliability-r7-outage.json`).
- **`stream:smoke`** passes with the final version, including its idempotent-replay check.
- **Unit tests:** `commit.test.ts` covers:
  - the R1 case: the commit resolves but the broker keeps the old offset after three reads;
  - a commit that arrives on the second read;
  - a timed-out read-back;
  - a refused commit;
  - a missing partition;
  - a non-numeric offset;
  - an offset already past ours;
  - integer comparison.

  `commit-check.test.ts` covers the check's verdict.

- **Check classification:** the check counts a commit as "while down" only if it completed after `docker compose stop` returned. A first run counted from when the stop was issued. It reported 2 commits "believed" that the broker, still shutting down, had in fact stored: the consumer resumed right after them.
- **Cost:** one more broker round trip per batch, with no measurable cost. Draining 60,000 pre-filled events (isolated environment, scorer refusing every flight, so mostly the Kafka and MongoDB path) ran at 1,970/s with confirmation and 1,890/s without: one run each, a difference within run-to-run noise.

### Final version validated: outages R8 to R10 and repeated benchmarks (2026-10-23)

These runs use the committed fix (`a3fd8c6`: up to three read-backs per commit). The environment was isolated, with a 28 s broker outage at about 15,000 stored, as in R1 to R7.

| Run | Resumed after broker start | Stored | Delivered twice | Commit failures detected                                                                               | Committed vs end offsets after the run       |
| --- | -------------------------- | ------ | --------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| R8  | 16.1 s                     | 60,000 | 0               | 3 ("not confirmed", one per partition)                                                                 | not checked (see below); rerun as R8b        |
| R9  | 15.9 s                     | 60,000 | 36              | 3                                                                                                      | not checked; rerun as R9b                    |
| R10 | 14.7 s                     | 60,000 | 0               | 0: no batch was in flight when the broker stopped (the consumer was keeping pace, 1,320 small batches) | 1,080,000 = 1,080,000 on 3 partitions, lag 0 |
| R8b | 14.6 s                     | 60,000 | 0               | 3, one per partition                                                                                   | equal on all 3 partitions, lag 0             |
| R9b | 15.5 s                     | 60,000 | 41              | 3, one per partition                                                                                   | equal on all 3 partitions, lag 0             |

- **No data lost, no duplicate documents.** All 60,000 flights were stored in every run. The redelivered flights are counted in `deliveries`; the consumer's own counter agrees (R9: 36 and 36; R9b: 41 and 41). In R8b and R9b the duplicate check was also run independently: 60,000 sent = 60,000 stored = 60,000 distinct `_id`s, and 0 flights stored twice under different ids (grouped by date, airline, flight number, origin and scheduled departure).
- **Failures are detected and handled.** In R8 and R9 the commits made while the broker stopped failed loudly ("reading it back failed (Local: Timed out)"), and the batches backed off. R10 had no commit in flight to fail, so it shows recovery and offset correctness, not detection.
- **Unconfirmed is not the same as lost.** In R8 and R10 no batch came back after the restart, so those unconfirmed commits had reached the broker as it shut down. In R9, 36 flights came back and were absorbed by the upsert.
- **Offsets.** In R8 and R9 the offset check printed nothing: in Git Bash the container path was rewritten to a Windows path. It was fixed (`MSYS_NO_PATHCONV=1`) for R10, then both scenarios were rerun as R8b and R9b with the check running inside the container. In R8b, R9b and R10 the group's committed offset equals the log-end offset on every partition, with lag 0 (after the consumer exited, `kafka-consumer-groups.sh --describe`; raw output saved in `reliability-r8b-outage.json` and `reliability-r9b-outage.json`). R8b and R9b, like R8 and R9, had commits in flight when the broker stopped (3 detected failures each), so they test offset correctness after detected failures, which R10 could not.

**Throughput, five runs per configuration** (`commit-confirm-throughput.json`). Each run replays 60,000 events with no consumer running, then one consumer drains them; confirmed and baseline runs alternate.

| Configuration                     | Runs (events/s)                   | Median | Mean ± sd   | Without the highest run            |
| --------------------------------- | --------------------------------- | ------ | ----------- | ---------------------------------- |
| Confirmed (read-back)             | 4,076; 2,107; 2,009; 2,064; 2,049 | 2,064  | 2,461 ± 903 | 2,009 to 2,107 (mean 2,057, sd 40) |
| Baseline (`commitOffsets()` only) | 2,011; 1,966; 2,002; 2,470; 2,077 | 2,011  | 2,105 ± 208 | 1,966 to 2,077 (mean 2,014, sd 46) |

- **The read-back has no measurable cost.** The medians differ by 53/s in favour of the confirmed version, well inside the run-to-run spread.
- **Run-to-run variability is the larger effect.** Most runs agree within about 2% (coefficient of variation without each configuration's highest run). One run per configuration was much faster: 4,076/s and 2,470/s. Their logs show the same 124 batches, with no errors and no redeliveries. The cause was not found; the laptop was also in desktop use. A single drain run on this machine can therefore be off by up to 2x.
- These rates are below the 2,442/s of run C (full December) because the isolated environment refuses every flight at the scorer. That makes the per-batch work different, so the two are not comparable.

### Kafka client upgrades

The read-back exists because of a defect in `@confluentinc/kafka-javascript`, so it has to be rechecked whenever that client changes.

**Status on 2026-10-23:**

- **Installed:** the client is pinned exactly to 1.11.0, which is the latest release on npm.
- **Raw mode still reproduces the defect on 1.11.0:** 28 of 28 commits were believed while the broker was stopped. Confirmed mode passes (`commit-check-raw.json`, `commit-check-confirmed.json`; both record `clientVersion`).
- **Upstream `master` (read on GitHub the same day) is unchanged:**
  - `commitOffsets()` still goes through `commitCb`;
  - `commitCb` still calls librdkafka's `commitAsync`;
  - the offset-commit callback is still marked TODO;
  - the changelog's newest entry is 1.11.0 and mentions no commit fix.

  **The workaround remains necessary.**

**Guard.** `server/src/stream/client-version.ts` records the version last verified (`COMMIT_CHECK_VERIFIED_CLIENT`). `client-version.test.ts` fails, and prints the steps below, when:

- the pinned or installed client differs from it;
- the dependency is not pinned to an exact version.

The test was checked to fail by setting the constant to 1.12.0. So an upgrade cannot pass `npm test` (or CI) until the check has been run.

**After every client upgrade**, with the broker up:

```bash
npm run stream:commit-check -- --mode raw --yes --out docs/measurements/commit-check-raw.json
npm run stream:commit-check -- --mode confirmed --yes --out docs/measurements/commit-check-confirmed.json
```

- **`confirmed` must pass.** If it fails, do not upgrade.
- **If `raw` passes,** it still reproduces the defect: keep the read-back.
- **If `raw` fails with "defect not reproduced",** the client now reports commit results itself. The read-back is then redundant but harmless; remove it only as a deliberate change.
- **Then** update `COMMIT_CHECK_VERIFIED_CLIENT` and commit the two reports.

### Hard broker kill (K1, K2, K1b, K2b; 2026-10-23)

The earlier outages stopped the broker gracefully (`docker compose stop`). These runs kill it abruptly with `docker kill` (SIGKILL) while the producer is still sending and the consumer is still storing.

**Setup:**

- **A disposable broker,** so the project broker and its data were never touched: container `fdkilltest-kafka`, own volume `fdkilltest_kafka_data`, host port 19092. It uses the same image (`apache/kafka:4.3.1`) and settings as `docker-compose.yml`.
- **Isolated names:** topics `killtest.raw` (3 partitions) and `killtest.dlq`, group `killtest`, MongoDB database `flight_delay_reliability_test`.
- **Each run:**
  - replay 60,000 December events;
  - kill the broker once 16,400 to 21,600 flights were stored;
  - start it again 20 s later.
- **Rates:** 1,000/s, where the consumer keeps pace, and 3,000/s, faster than the consumer, so a backlog and in-flight commits exist at the kill.
- **Checks after the consumer exits:**
  - topic start and end offsets;
  - committed against end offsets;
  - MongoDB counts by `_id` and by the flight's own fields.

| Run | Rate    | Sent (acked) | Records in topic             | Stored / distinct ids | Duplicate flights | Committed = end, lag 0 | Commit failures caught | Delivered twice |
| --- | ------- | ------------ | ---------------------------- | --------------------- | ----------------- | ---------------------- | ---------------------- | --------------- |
| K1  | 1,000/s | 60,000       | 60,000 (inferred, see below) | 60,000 / 60,000       | 0                 | not checked            | 0                      | 0               |
| K2  | 3,000/s | 60,000       | 60,000                       | 60,000 / 60,000       | 0                 | yes, 3 partitions      | 3                      | 0               |
| K1b | 1,000/s | 60,000       | 60,000                       | 60,000 / 60,000       | 0                 | yes, 3 partitions      | 0                      | 0               |
| K2b | 3,000/s | 60,000       | 60,000                       | 60,000 / 60,000       | 0                 | yes, 3 partitions      | 3                      | 1,344           |

**What survived:**

- **Every acknowledged message.** The records in the topic (end minus start offsets) equal the producer's acknowledged sends in every run.
- **No duplicate records.** The idempotent producer's retries across the kill did not write any record twice.
- **Committed offsets.** They equal the end offsets on all partitions after recovery.
- **Every flight stored exactly once.** There were 0 flights under two ids. In K2b, 1,344 were delivered twice and absorbed as `deliveries` = 2; the consumer logged them as it happened (500 + 844).

**What was lost:** nothing that had been acknowledged or committed, in these runs.

**Recovery:**

- **After the kill:** the broker logged an unclean recovery ("Recovering 54 logs … since no clean shutdown file was found"), with no truncation logged for `killtest.raw`.
- **Timing:** the broker was healthy 15.6 to 15.8 s after it was started, and the consumer stored again 24.2 to 24.4 s after the start.
- **Consumer behaviour:** neither the producer nor the consumer had to be restarted.
- **Commit failures:** at 3,000/s, commits in flight at the kill were caught ("not confirmed: reading it back failed (Local: Timed out)") and the batches redelivered. At 1,000/s no commit was in flight.

**Notes on method:**

- **K1's offsets were not checked.** Inside the container the CLI tools connected to `localhost:9092`, but the broker advertised the host port 19092, so they could not reach it.
- **K2's offsets were checked afterwards,** from the state left on the volume. The container was first stopped gracefully, then recreated with an internal listener for the tools.
- **K1 and K2 were rerun with the checks working,** as K1b and K2b. K1's record count is inferred: `stream:reset` before K2 deleted K1's records up to its end, so K2's start offsets (60,000 in total, from 0) are K1's end.

**Limits of this test:**

- **A process crash, not a power loss.** `docker kill` ends the broker process, but the Docker VM's page cache survives it. Kafka acknowledges writes before they are flushed to disk (no forced fsync by default), and here there are no replicas. So a host crash or power loss can still lose acknowledged messages, and that was not tested.
- **A copy of the project broker, not the broker itself.** It ran the same image and settings on the same machine.
- **Four runs at two rates, one laptop.**

Evidence: `docs/measurements/broker-kill.json`. It holds:

- per-run timelines;
- topic and group offsets;
- producer and consumer counts;
- the consumer's errors and warnings;
- the broker's recovery log lines;
- the before and after check of the project broker and the main database: identical topic offsets, group offsets and 479,230 stream flights.

### Remaining Kafka risks

- **The confirmation reads the committed offset, not the commit's own result.** It depends on the client's current behaviour; a test now blocks any client upgrade until `stream:commit-check` has been run in both modes (see Kafka client upgrades).
- **A commit can succeed and still be reported as failed.** This happens when the read-back times out after the broker stored the commit. The batch is then delivered once more, and the upsert absorbs it.
- **Few runs, one machine.** Resume after a broker restart, with a 10 s session timeout: 14.6 to 19.8 s across nine runs (R3, R5 to R10, R8b, R9b). With 30 s: 36.9 and 39.1 s (two runs). Drain throughput varies by up to 2x between single runs (see the repeated benchmarks).
- **The status reads `live` for up to 15 s of a stall.** By design (the stall window): in R6 it read `live` for about 10 s after Kafka came back and before the first new batch.
- **Unchanged from before:** single broker with replication factor 1 (no fault tolerance); the native `fetchOffsets` crash in the Kafka client (contained in the probe process); the consumer was never tested in a crash of the client itself.

## Raw evidence

| File                                                                                                        | What it holds                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/measurements/run-a-500.json`                                                                          | `stream:measure` report and checks, run A                                                                                                                                       |
| `docs/measurements/run-b-2000.json`                                                                         | run B                                                                                                                                                                           |
| `docs/measurements/run-c-unthrottled.json`                                                                  | run C, all of December                                                                                                                                                          |
| `docs/measurements/run-c-rereplay-5000.json`                                                                | the 5,000-event re-replay after run C (`timing` is null: it stored nothing new)                                                                                                 |
| `docs/measurements/run-d-crash-before-restart.json`                                                         | run D after the hard kill, before the restart                                                                                                                                   |
| `docs/measurements/run-d-crash-after-restart.json`                                                          | run D after the restart                                                                                                                                                         |
| `docs/measurements/reliability-r1-redelivery.json`, `reliability-r1-status.json`                            | R1 (isolated): 16,000 redelivered after an outage, and the status series that showed the validation fallbacks and the first stall detection                                     |
| `docs/measurements/reliability-r2-outage.json`, `reliability-r3-*.json`, `reliability-r4-*.json`            | R2 to R4 (isolated): resume times by session timeout, and the status series verifying the stall state                                                                           |
| `docs/measurements/reliability-r5-outage.json`, `reliability-r6-outage.json`, `reliability-r6-status.json`  | R5 and R6 (isolated, 10 s): resume times, the consumer's redelivery warnings, and the status series                                                                             |
| `docs/measurements/commit-check-raw.json`, `commit-check-confirmed.json`                                    | `stream:commit-check`: every commit made during an outage, with and without the read-back confirmation                                                                          |
| `docs/measurements/commit-repro-prototype.json`                                                             | the first reproductions, before `stream:commit-check` existed                                                                                                                   |
| `docs/measurements/reliability-r8-outage.json`, `reliability-r9-outage.json`, `reliability-r10-outage.json` | R8 to R10 (isolated): the final version through a broker outage, with offsets (R10), stored documents by `deliveries`, and the consumer's errors and warnings                   |
| `docs/measurements/reliability-r8b-outage.json`, `reliability-r9b-outage.json`                              | R8b and R9b: R8 and R9 rerun with the offset check (per-partition committed and end offsets, raw tool output), stored and distinct counts, duplicate check                      |
| `docs/measurements/broker-kill.json`                                                                        | K1, K2, K1b, K2b: hard broker kill (SIGKILL) on a disposable broker during produce and consume; offsets, counts, recovery log, and the before/after check of the project broker |
| `docs/measurements/commit-confirm-throughput.json`                                                          | five drain runs each with and without the commit read-back, with summary statistics                                                                                             |
| `docs/measurements/reliability-r7-outage.json`                                                              | R7 (isolated): the real consumer with confirmed commits through a broker outage, with its error and warning lines                                                               |
| `docs/measurements/reliability-r5-probe-console-lost.json`                                                  | the probe in an API whose console was killed: its process log and status every 2 s through a broker restart                                                                     |
| `docs/measurements/run-h1-one-consumer.json`, `run-h2-two-consumers.json`                                   | runs H1 and H2: one against two consumers, 150,000 events unthrottled                                                                                                           |
| `docs/measurements/run-h2-partitions.json`                                                                  | run H2: messages per partition and per consumer                                                                                                                                 |
| `docs/measurements/run-g-kafka-restart.json`                                                                | run G (Kafka stopped about 28 s under load): checks and counts after recovery                                                                                                   |
| `docs/measurements/run-g-kafka-restart-status.json`                                                         | run G: `GET /api/stream/status` every 2 s through the outage (`stream:watch`)                                                                                                   |
| `docs/measurements/run-f-kill-attempt-1.json`, `run-f-kill-attempt-2.json`                                  | run F: `stream:measure` right after each hard kill (written vs committed)                                                                                                       |
| `docs/measurements/run-f-midbatch-final.json`, `run-f-midbatch-deliveries.json`                             | run F after recovery: checks, and flights grouped by `deliveries` with each consumer's heartbeat                                                                                |
| `docs/measurements/run-e-1200.json`, `run-e-1200-steady.json`                                               | run E at 1,200/s: the whole run, and only the flights produced after the start-up backlog drained (`stream:measure --from`)                                                     |
| `docs/measurements/run-e-1200-lag.json`                                                                     | run E: consumer lag, flights stored and throughput every 2 s (`stream:watch`)                                                                                                   |
| `docs/measurements/run-e-host-load.json`                                                                    | host load right after run E                                                                                                                                                     |
| `docs/measurements/run-d-crash-consumer.json`                                                               | run D: the state printed at the kill, the restarted consumer's final counters, and each run's `--idle-exit`                                                                     |
| `docs/measurements/verify-status.json`                                                                      | `stream:verify-status`: 35 checks with endpoint and recomputed values                                                                                                           |
| `docs/measurements/batch-collections-before.txt`, `-after.txt`                                              | collection counts in `flight_delay` before and after                                                                                                                            |

## Honest limits

- **Simulated velocity.** The events are a replay of 2015 flights at a chosen rate, not a live feed. Each event carries its outcome, which in reality would arrive hours later.
- **No fault tolerance.** One broker with replication factor 1: losing the broker or its volume loses every event not yet consumed. Production would need at least 3 brokers, `min.insync.replicas=2` and monitoring.
- **Hard broker kill survived; power loss untested.** A SIGKILL of the broker during produce and consume lost no acknowledged message and left committed offsets correct (runs K1 to K2b). A host crash or power loss is a different case: with one broker, no replicas and no forced fsync, messages acknowledged but not yet on disk would be lost.
- **One machine.** Throughput with live scoring is bounded by scoring: about 2.4k/s in one process (run C). Two consumers gave 1.24x (runs H1 and H2), limited by the 3-partition split and by sharing one laptop. More partitions, three consumers and other machines were not measured.
- **One run per rate.** Each figure is a single run on a laptop with Docker Desktop, not a mean of repeated runs.
- **Latency resolution.** Batch-level timestamps and approximate percentiles (see item 6). Unthrottled latency is queueing time.
- **Resume after a broker restart.** About 42 s in run G with the client's 30 s session timeout; 17.2 to 19.8 s with the new 10 s default (R3, R5, R6). The endpoint now reports the stall instead of `live` (see Reliability fixes).
- **The live predictions are weakly selective.** At the deployed threshold (0.207) the model flagged 43.3% of the 469,717 December flights with an outcome, while 20.6% were delayed. Precision was 27.8% and recall 58.4%: a flagged flight was 1.35 times as likely to be delayed as any flight (lift over the base rate). The batch test months show the same picture: 42.8% flagged, precision 21.8% against a base rate of 16.1%, lift 1.36. The threshold maximises F1 on September validation, so it trades precision for recall; on September, flagging only the top 10% by score would give a lift of 1.77 but catch 17.7% of delays (Model page, `ml/artifacts/operating-points.json`). The threshold was not changed: choosing it again from these figures would be a new modelling decision (`docs/DECISIONS.md`, threshold analysis).
- **Shared laptop.** Runs were made on a laptop also in desktop use; run E's host load was recorded (62% CPU), the others' was not, so latencies across runs are only loosely comparable.
- **Not measured in 8g:**
  - consumer memory use;
  - a graceful stop by a real Ctrl+C under load. It was later checked once on an idle consumer: a console Ctrl+C sent with `GenerateConsoleCtrlEvent` produced "stream:consume stopped" and a final heartbeat (2026-10-23);
  - the DLQ path with real data (December has no rejects).
