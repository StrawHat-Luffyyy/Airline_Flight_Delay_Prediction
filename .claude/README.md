# Claude Code toolkit for this project

Copy this `.claude/` folder and `CLAUDE.md` into the repo root (next to PROJECT_OVERVIEW.md), commit them, and restart Claude Code.

Subagents (auto-delegated, or ask "use the leakage-auditor"): mongo-query-optimizer, leakage-auditor, ts-reviewer, test-writer, frontend-integrator, report-writer.

Skills (run with a slash command): /phase-runner 3, /add-analytics-endpoint cause-by-hour, /verify-ingestion, /explain-report, /model-parity-check, /report-section viva.
Skills with disable-model-invocation only run when you call them.
