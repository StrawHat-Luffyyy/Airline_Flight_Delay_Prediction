---
name: phase-runner
description: Execute one numbered build phase from PROJECT_OVERVIEW.md section 11 end to end - implement, run its acceptance checks, review, commit - then stop. Use when the user says "run phase N", "start phase N", "continue to the next phase", or asks to build the next part of the project.
argument-hint: "[phase number 0-7]"

---
# Run a build phase

Phase requested: $ARGUMENTS (if empty, determine the next unfinished phase from `git log` and the repo state, and confirm with the user).

1. **Read** PROJECT_OVERVIEW.md fully, then re-read the section 11 entry for this phase, plus any sections it references (schema 6, model 7, analytics 8, API 9, dashboard 10). Read `docs/DECISIONS.md` and `docs/FRONTEND_AUDIT.md` if they exist.
2. **Check prerequisites**: previous phases' acceptance criteria are met (run their checks quickly). If not, stop and report what is missing; do not paper over it.
3. **Plan** in a few lines: files to create or change, commands to run. Then implement. Keep to the phase scope; log new decisions in `docs/DECISIONS.md`.
4. **Verify**: `npm run typecheck && npm run lint && npm test`, then run each acceptance criterion of the phase literally and record pass/fail with the evidence (command output, counts, timings).
5. **Review with subagents** as relevant:
   - always: `ts-reviewer`
   - phases 2-3 (indexes, analytics): `mongo-query-optimizer`
   - phases 4-5 (features, model, predict): `leakage-auditor`
   - phase 6 (dashboard): `frontend-integrator` does the work; `ts-reviewer` checks it
   - missing tests for pipelines/transforms: `test-writer`
   Fix Must-fix findings and re-run verification.
6. **Commit** with a conventional message (`feat(ingest): ...`). Do not commit `data/`, `.env`, or large artifacts other than `ml/artifacts/`.
7. **Report**: a checklist of acceptance criteria with pass/fail and evidence, decisions made, and anything blocked. Then STOP. Do not start the next phase.
