# Flight Delay Prediction (Big Data project)

`PROJECT_OVERVIEW.md` is the source of truth. Read it before any non-trivial work. If a decision is not covered there, pick the simplest option and log it in `docs/DECISIONS.md`.

## Non-negotiables

- MongoDB is the system of record. Use the official `mongodb` driver. No Mongoose.
- TypeScript strict everywhere. No `any` (use `unknown` + zod). The only non-TS file is `ml/train.py`.
- Never load the full dataset into memory: stream CSVs, iterate cursors, bulk insert in batches of 10,000.
- No target leakage. Forbidden model features: depDelay, taxiOut, taxiIn, airTime, arrDelay, elapsedTime, any causes.\*, cancelled, diverted. Split is time-based (train Jan-Sep, test Oct-Dec). Lookup rates come from the train split only.
- `web/` was generated with Google AI Studio. Keep its design; replace mock data with the typed API client. No Gemini / @google/genai / API keys in client code. No LLM calls anywhere in the app.
- Every number shown in the UI or written in docs must come from real data (API or measured results). Never invent metrics.

## Workflow

- Work phase by phase (overview section 11). Run acceptance checks, then commit with a conventional commit message, then stop and report.
- Pipeline builders are pure functions returning `Document[]` so they can be unit tested without a DB.

## Commands

`npm run dev`, `test`, `lint`, `typecheck`, `ingest`, `build:indexes`, `build:stats`, `build:lookup`, `export:training`, `ml:register`

## Project agents (.claude/agents) and skills (.claude/skills)

Agents: mongo-query-optimizer, leakage-auditor, ts-reviewer, test-writer, frontend-integrator, report-writer.
Skills: /phase-runner, /add-analytics-endpoint, /verify-ingestion, /explain-report, /model-parity-check, /report-section.
