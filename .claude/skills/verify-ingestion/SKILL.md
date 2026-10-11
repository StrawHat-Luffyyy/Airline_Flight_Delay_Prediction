---
name: verify-ingestion
description: Run or check the CSV-to-MongoDB ingestion and prove it is correct - row counts reconcile, memory stays bounded, nulls and HHMM times are handled, indexes exist. Use after running the ingest command, when counts look off, or when the user asks whether the data loaded properly.

---
# Verify ingestion

Read the DB name and URI from `.env` / `.env.example`. Use `docker compose exec mongo mongosh <db> --quiet --eval '...'` for queries.

1. **Environment**: `docker compose ps` shows mongo healthy; `data/raw/` has flights.csv, airlines.csv, airports.csv.
2. **Run (only if the user asked to ingest)**: `/usr/bin/time -v npm run ingest -- --drop 2>&1 | tail -40`. Record peak RSS ("Maximum resident set size"). Target: under ~500 MB. A larger value means something is buffering; find it.
3. **Reconcile counts**:
   - CSV data rows: `tail -n +2 data/raw/flights.csv | wc -l`
   - `db.flights.countDocuments()`
   - latest `ingest_runs` doc: rowsRead, rowsInserted, rowsRejected, rejectReasons
   - Must hold: rowsRead = CSV rows; rowsInserted + rowsRejected = rowsRead; countDocuments = rowsInserted.
4. **Spot checks** (report each as pass/fail):
   - no doc with `schedDepHour` outside 0-23 or `schedDepMin` outside 0-1439
   - cancelled docs have `isDelayed: null` and null arrDelay: `db.flights.countDocuments({cancelled:true, isDelayed:{$ne:null}})` is 0
   - `isDelayed` agrees with arrDelay: `db.flights.countDocuments({arrDelay:{$gte:15}, isDelayed:false})` is 0
   - `causes` is null or an object whose fields are null or numbers, never strings
   - denormalized fields populated: share of docs with `airlineName == null`, `originCity == null`
   - `split` set on every doc; months 1-9 are train, 10-12 test
   - date range is all of 2015
5. **Indexes**: `db.flights.getIndexes()` matches PROJECT_OVERVIEW.md 6.2, created after the load.
6. **Size**: `db.flights.stats()` storageSize and index sizes, for the report.
7. Output a table of checks with pass/fail and the numbers. If anything fails, find the root cause in `server/src/ingest/` and propose a fix; do not edit the data by hand.
