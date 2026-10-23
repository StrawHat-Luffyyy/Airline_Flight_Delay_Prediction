# Production readiness

State on 2026-10-24, before deployment. Every result below was measured in this project; anything not measured says so. Evidence lives in `docs/measurements/` and `docs/DECISIONS.md` ("Production hardening").

## Verdict

- **The application code is ready for a production deployment.** The audit's code-level P0 and P1 findings are fixed and tested, and the checks pass on Windows and in a clean Linux replica of CI.
- **The deployment itself does not exist yet.** The blockers below are all deployment work (stage 3). None needs an application change.

## Unresolved production blockers (all stage 3)

| #   | Blocker                                         | Why it blocks                                                                                     | Planned fix                                                                                  |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | No container image for the API and dashboard    | The repo only starts MongoDB and Kafka; nothing builds or runs the app as a service               | Dockerfile(s) using `npm run build:server` (`node dist/server.js`) and the web build         |
| 2   | No reverse proxy                                | The dashboard calls `/api` on its own origin, so something must serve `web/dist` and proxy `/api` | Caddy (TLS, static files, `/api` proxy); set `TRUST_PROXY_HOPS=1`                            |
| 3   | MongoDB has no authentication                   | `docker-compose.yml` runs `mongo:7` with no users; fine bound to 127.0.0.1, not on a network      | Root and app users, a least-privilege app role, `MONGODB_URI` with credentials from a secret |
| 4   | Kafka is PLAINTEXT with no authentication       | Same reason; any network peer could read or write topics                                          | Keep the broker on a private network with no published port, or add SASL/TLS                 |
| 5   | Secrets handling for a deployment               | `.env` is git-ignored (verified) but a deployment needs its own secret source                     | Compose secrets or an env file outside the repo                                              |
| 6   | Topics must exist before the API and consumer   | Without `kafka:init`, the status probe reports the broker as unreachable (see finding F1)         | Run `kafka:init` as a one-shot service before the consumer                                   |
| 7   | Data must be loaded into the production MongoDB | The API serves pre-aggregated collections and the model reads `delay_lookup`                      | Run the README's batch steps 1-6, or restore a dump, then `ml:register`                      |

## Accepted Kafka limitations

These are known, documented and accepted for this project. None loses an acknowledged message in the tests below.

- **One broker, replication factor 1.** There is no fault tolerance. Losing the broker or its volume loses every event not yet consumed. Production would need at least 3 brokers, `min.insync.replicas=2` and monitoring.
- **Power loss is untested.** A hard kill (SIGKILL) of the broker lost no acknowledged message (runs K1 to K2b). A host crash could still lose messages acknowledged but not yet flushed to disk.
- **The Kafka client has two known defects.** Both affect `@confluentinc/kafka-javascript` 1.11.0, the latest release:
  - `commitOffsets()` can report success for a commit the broker never stored. The consumer works around this by reading each commit back; `stream:commit-check` proves the workaround on every client upgrade (see the verification record below).
  - `admin.fetchOffsets` can crash its process natively after a broker restart. The API contains this with a forked probe process. The consumer uses the same client; a crash there is recovered by restarting the consumer (8c crash test).
- **The speed layer is a replay.** December 2015 is replayed at a chosen rate; it is not a live feed.
- **Throughput was measured on one laptop.** Live scoring reached about 2.4k flights/s in one process, and two consumers gave 1.24x. More partitions or machines were not measured.
- **A write that hangs while MongoDB stays healthy is untested.** A fully frozen MongoDB is handled (below). A server that answers heartbeats but hangs one write would hold a batch until librdkafka's 300 s poll limit. The commit read-back then fails the batch and it is redelivered, so it would stall but not lose data. This is reasoned from the code, not reproduced.
- **Resuming after a broker restart takes 17 to 20 s** with the 10 s session timeout (runs R3, R5 and R6).

## Verification record (2026-10-24)

| Check                                                   | Result                                                                                                                                                                                                                                                                                                                           | Evidence                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| typecheck, lint, format check (now including `web/src`) | pass                                                                                                                                                                                                                                                                                                                             | local run                                        |
| Test suite                                              | 61 files and 501 tests pass, 0 skipped (MongoDB and Kafka integration tests ran)                                                                                                                                                                                                                                                 | local run and CI replica                         |
| Production builds                                       | web and server bundles build; the server bundle boots and answers `/api/health`                                                                                                                                                                                                                                                  | local run and CI replica                         |
| `npm audit`                                             | 0 vulnerabilities                                                                                                                                                                                                                                                                                                                | local run                                        |
| `stream:smoke`                                          | 5 of 5 checks pass with the real model                                                                                                                                                                                                                                                                                           | local run                                        |
| CI workflow                                             | all `run:` steps of `.github/workflows/ci.yml` pass in a clean Linux replica: fresh clone, `node:22`, `mongo:7` and `apache/kafka:4.3.1` services, `npm ci` from the lockfile. Not yet run on GitHub, because nothing is pushed                                                                                                  | replica log                                      |
| `stream:commit-check`                                   | both verdicts hold on client 1.11.0. In `raw` mode 45 commits were believed during the outage and 5,398 messages were delivered twice. In `confirmed` mode 0 were believed, 1 was rejected and 0 were delivered twice                                                                                                            | `docs/measurements/commit-check-isolated-*.json` |
| Isolation of the commit-check runs                      | they ran on a separate compose project (port 19092). The project broker was unchanged afterwards: same topic offsets, same `flight-stream` offsets, same container start time                                                                                                                                                    | same files (`environment`)                       |
| MongoDB frozen for 330 s                                | the driver detected it in about 34 s and failed the in-flight batches; 17 batches backed off; there was no group eviction; 10,400 events were stored exactly once and committed offsets equalled end offsets                                                                                                                     | `docs/measurements/mongo-hang-330s.json`         |
| Model lookup fingerprint                                | the served model's pin matches the current `delay_lookup`. Every rate in the 100 parity-sample test rows (500 values) is bit-identical to the current lookup after the float32 cast used in training, and all three lookup builds have identical scope totals. So the current predictions use the rates the model was trained on | `ml/artifacts/parity_sample.json`, `lookup_runs` |

## Findings from this verification

- **F1 (low): `kafka: "down"` when only the topics are missing.**
  - **Seen in:** the CI replica, where `kafka:init` never runs.
  - **What happens:** the status probe reported "Kafka unreachable: Broker: Unknown topic or partition", so `/api/health` showed `kafka: "down"` and `/api/stream/status` showed `degraded`, while the broker was reachable.
  - **Impact:** the reason text is accurate but the label is misleading. Health stays `200 ok`, because Kafka is informational.
  - **Fix:** a deployment must run `kafka:init` (blocker 6). Changing the label is a possible follow-up.
- **The fingerprint pin was taken at registration, not at export.** The served model's export predates fingerprints. The parity check above shows that this pin equals the training lookup for the sampled rows. Exports from now on record the fingerprint themselves.

## Leftover test data (cleanup, 2026-10-24)

None of these was read by the application; `grep` found their names only in measurement records and in `docs/DECISIONS.md`. Each target was re-checked just before removal: its contents were unchanged and no other consumer group read the topics.

**Removed (with your approval):**

- Kafka topics `reliability.raw` (1,470,000 messages, about 483 MB) and `reliability.dlq` (empty).
- Kafka topics `commitrepro.plain1`, `commitrepro.plain2` and `commitrepro.verify1` (6,000 messages each).
- The broker deletes these topics' files asynchronously.
- Kafka consumer groups `commit-repro-plain1`, `commit-repro-plain2` and `commit-repro-verify1` (state `Empty`).

**Approved but not removed.** The project's guard hook blocks these from Claude, so run them yourself:

- MongoDB database `flight_delay_reliability_test`: `stream_flights` 0 and `stream_stats` 0 documents, copies of `airlines` (14) and `airports` (322), and `ingest_runs` (2). About 1 MB.

  ```bash
  docker compose exec mongo mongosh flight_delay_reliability_test --eval "db.dropDatabase()"
  ```

- Docker volumes `fdverify_kafka_data`, `fdverify_mongo_data` and `fdci_root_node_modules`. They were created for the isolated commit-check, the MongoDB hang test and the CI replica, and no container uses them.

  ```bash
  docker volume rm fdverify_kafka_data fdverify_mongo_data fdci_root_node_modules
  ```

**Kept until you confirm.** Docker volume `fdp_mongo_data` (1.6 GB) is a MongoDB data directory from compose project `fdp`, created 2026-10-18. Its date and size match the README's clean-clone audit, but nothing records it.

**Verified after the removal:**

- The broker lists only `flights.raw`, `flights.dlq` and `__consumer_offsets`, and only the group `flight-stream`. Its committed offsets are unchanged and its lag is 0.
- `flight_delay` holds 5,819,079 `flights` and 479,230 `stream_flights`.

**Keep:** `flight_delay` (the system of record), `flights.raw` and `flights.dlq`, the group `flight-stream`, and the volumes `2015flightdelaysandcancellations_mongo_data` and `2015flightdelaysandcancellations_kafka_data`.
