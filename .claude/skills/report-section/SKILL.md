---
name: report-section
description: Draft a section of the college project report or viva prep from real project evidence - big data justification, schema design, methodology, results, limitations, viva questions. Use when the user asks for report content, documentation, a write-up, abstract, or viva preparation for this project.
argument-hint: "[bigdata | schema | methodology | results | limitations | abstract | viva]"
---
# Report section: $ARGUMENTS

Delegate the writing to the `report-writer` agent, after gathering evidence yourself.

Evidence to collect first (skip what does not exist yet and mark TODO):
- counts and sizes: `db.flights.countDocuments()`, `db.flights.stats()`, latest `ingest_runs`
- schema: `docs/SCHEMA.md`, `server/src/db/`
- performance: `docs/EXPLAIN_RESULTS.md`
- model: `ml/artifacts/metrics.json`, latest `model_runs`
- decisions: `docs/DECISIONS.md`

Section guidance:
- **bigdata**: volume, variety, velocity (simulated stream), scalability (sharding design with key `{origin, date}`), why MongoDB, honest comparison with Spark/Hadoop. Output `docs/BIGDATA_JUSTIFICATION.md`.
- **schema**: collections, denormalization, computed-pattern stats collections, indexes with the reason for each.
- **methodology**: dataset, cleaning rules, feature engineering, time-based split, offline training, ONNX serving.
- **results**: model metrics, cause analysis findings pulled from the analytics endpoints (for example largest cause share, worst airports, cascade by hour), each with its source.
- **limitations**: single year of data, no weather or live traffic features, modest AUC and why, single-node deployment.
- **abstract**: 150-200 words, only claims backed by the evidence above.
- **viva**: 15-20 likely questions with short answers grounded in this repo.

Write to `docs/report/<section>.md` (or the path named above). No invented numbers: unknown values stay `TODO: measure`.
