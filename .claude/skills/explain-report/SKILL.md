---
name: explain-report
description: Generate docs/EXPLAIN_RESULTS.md - before/after index evidence from explain("executionStats") for the project's representative queries. Use when the user needs index or performance evidence for the report, or after changing indexes or key pipelines.

---
# Explain report

Goal: report-ready evidence that indexes and pre-aggregation matter on 5M+ documents.

1. Pick 4+ representative queries (add the real pipelines from `server/src/analytics/`):
   - flights for one airline in a date range
   - flights from one origin at a given scheduled hour
   - delay-rate ranking by route
   - monthly cause breakdown (compare `flights` scan vs the `stats_cause_monthly` read)
2. For each, run in mongosh with `explain("executionStats")`, twice:
   - **Before**: force a collection scan with `.hint({ $natural: 1 })`. Never drop real indexes to get this.
   - **After**: default plan.
   Capture: winning plan stage, totalKeysExamined, totalDocsExamined, nReturned, executionTimeMillis.
3. Write `docs/EXPLAIN_RESULTS.md`: a summary table (query, before ms, after ms, docs examined before/after, speedup) and, per query, the query text, the index used and a two-sentence interpretation.
4. Include the collection and index sizes (`db.flights.stats()`), and the cost trade-off: indexes speed reads but cost RAM and ingestion time.
5. Only report numbers you measured in this run, with the date. If the database is not loaded, say so and stop.
