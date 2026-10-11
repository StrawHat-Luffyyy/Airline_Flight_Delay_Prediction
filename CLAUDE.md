# Flight Delay Prediction (Big Data project)

`PROJECT_OVERVIEW.md` is the source of truth. Read it before any non-trivial work. If a decision is not covered there, pick the simplest option and log it in `docs/DECISIONS.md`.

## Non-negotiables

- MongoDB is the system of record. Use the official `mongodb` driver. No Mongoose.
- TypeScript strict everywhere. No `any` (use `unknown` + zod). The only non-TS file is `ml/train.py`.
- Never load the full dataset into memory: stream CSVs, iterate cursors, bulk insert in batches of 10,000.
- No target leakage. Forbidden model features: depDelay, taxiOut, taxiIn, airTime, arrDelay, elapsedTime, any causes.\*, cancelled, diverted. Split is time-based (train Jan-Sep, test Oct-Dec). Lookup rates come from the train split only.
- `web/` was generated with Google AI Studio. Replace mock data with the typed API client. No Gemini / @google/genai / API keys in client code. No LLM calls anywhere in the app. Its visual design may be improved per "Frontend Design Improvement Policy" below.
- Every number shown in the UI or written in docs must come from real data (API or measured results). Never invent metrics.

## Workflow

- Work phase by phase (overview section 11). Run acceptance checks, then commit with a conventional commit message, then stop and report.
- Pipeline builders are pure functions returning `Document[]` so they can be unit tested without a DB.

## Skill Usage Policy (automatic)

Do not wait for the user to name a skill or type a slash command. Before implementing any non-trivial task, pick the relevant installed skills from the table below and **invoke them with the Skill tool** (reading a SKILL.md or paraphrasing it does not count). Follow their instructions during the work, then run the review/verify skills afterwards. Use several complementary skills when they fit; do not run irrelevant ones. Pick one skill per concern when two overlap (e.g. one TDD skill, one debugging skill, not both). Project rules in this file win over any skill.

| Task | Invoke (before) | Invoke (after) |
|---|---|---|
| Build a numbered phase | `phase-runner` | `code-review`, `superpowers:verification-before-completion` |
| New analytics endpoint/chart | `add-analytics-endpoint` | `mongo-query-optimizer` agent, `ts-reviewer` agent |
| Frontend UI, dashboard, layout, styling, a11y, responsive, motion | `impeccable` (fits dashboards/product UI); add `design-taste-frontend` (the `taste-skill`) only for landing pages, portfolios, or full redesigns, since its scope excludes dashboards and data tables | `impeccable` audit/critique/polish, then inspect the running UI in the browser |
| Any new logic, pipeline builder, route, transform | `tdd` (use `test-writer` agent for fixtures) | `npm run test`, `lint`, `typecheck` |
| Bug, failing test, slow query, unexpected behavior | `diagnosing-bugs` (or `superpowers:systematic-debugging`) | `superpowers:verification-before-completion` |
| Auth, secrets/env, Express input handling, Mongo connection, CORS, deployment | `vibe-security` | `security-review` |
| MongoDB indexes/pipelines/performance | `mongo-query-optimizer` agent, `explain-report` | `explain-report` |
| Ingestion | `verify-ingestion` | n/a |
| Features, model training, encoders, `/predict` | `model-parity-check` | `leakage-auditor` agent |
| Module/interface design, refactor, architecture | `codebase-design`, `domain-modeling` | `improve-codebase-architecture` (user-invoked only) |
| Docs, report, viva | `report-section`, `report-writer` agent | `explain-report` for index evidence |
| Writing/editing CLAUDE.md or skills | `writing-for-agents` | n/a |
| Open-ended new feature or behavior change | `superpowers:brainstorming` | `superpowers:requesting-code-review` |
| Hard decision to pressure-test | `llm-council` | n/a |
| PR text | `pr` | n/a |
| Dependency/API docs lookup | Context7 MCP (`mcp__context7__*`) | n/a |

Invocation limits (respect them, do not work around them):

- Skills with `disable-model-invocation: true` run only when the user types them: `grill-me`, `grill-with-docs`, `to-spec`, `to-tickets`, `triage`, `implement`, `implement-spec`, `improve-codebase-architecture`, `retro`, `wayfinder`, `handoff`, `teach`, `wait-what`, `ask-matt`, `to-questionnaire`, `setup-matt-pocock-skills`. Suggest them when relevant; do not run them yourself.
- `ponytail*` is an opt-in coding mode; apply it only when the user asks. It conflicts with this project's phase workflow, so never use it inside `/phase-runner`.
- Not relevant here, do not run: `slides`, `banner-design`, `brand`, `design`, `design-system`, `ui-styling`, `ui-ux-pro-max`, `shadcn` (no `components.json`), `migrate-radix-to-base`, `wizard`, `teach`.
- If a skill cannot be invoked or does not exist, say so and continue; never imitate it from memory.

## Frontend Design Improvement Policy

The `impeccable` and `taste-skill` skills are installed. Use them intelligently to improve the frontend of this project.

### Core Rule

You may modify, redesign, and improve the frontend whenever the result is demonstrably better than the existing design. Do not preserve the current design simply because it exists. Never change things just for the sake of changing them.

### 1. Evaluate Before Editing

Before changing any frontend code:

- Inspect the existing `web/` application, its components, styling, and page structure.
- Run the application and examine the actual interface in the browser when the environment supports it.
- Evaluate typography, spacing, layout, visual hierarchy, responsiveness, color usage, interactions, animations, accessibility, and consistency.
- Identify specific weaknesses and decide whether a redesign or targeted refinements would produce a meaningful improvement.

### 2. Use the Installed Skills

- `taste-skill` (invoked as `design-taste-frontend`) guides visual direction and avoids generic AI-generated aesthetics. Its own scope is landing pages, portfolios, and redesigns, not dashboards or data tables, so apply it to those and use only its anti-slop principles on dashboard views.
- `impeccable` audits, refines, and polishes the interface. Use its relevant workflows and browser-iteration capabilities when available.
- Do not follow either blindly. Apply professional design judgment and choose what fits this project's purpose.

### 3. What Qualifies as an Improvement

Prioritize changes that produce a noticeably better user experience:

- Stronger visual hierarchy and more intentional typography.
- Better layouts, spacing, alignment, and information density.
- A distinctive visual identity rather than a generic AI-generated template.
- Natural, purposeful animations and interactions where they improve the experience.
- Better responsive behavior across desktop, tablet, and mobile.
- Improved accessibility, readability, consistency, and usability.
- More coherent visual details, loading states, empty states, and error states.

Avoid unnecessary gradients, excessive rounded cards, arbitrary animations, decorative elements without purpose, and trendy patterns that do not suit the product.

### 4. Preserve What Already Works

- Do not assume the whole frontend needs redesigning. Retain components that are already excellent and improve only the weaker areas.
- Do not sacrifice usability, performance, accessibility, maintainability, or consistency for visual novelty.
- Keep existing functionality and API contracts intact. Follow the backend integration requirements, including the typed API client instead of mock data. Never replace real functionality with hardcoded demonstration data.

### 5. Work Iteratively and Verify

1. Inspect and evaluate the existing design.
2. Identify the highest-impact improvements.
3. Implement them.
4. Run the application and inspect the result in the browser where possible.
5. Compare the updated interface against the original.
6. Fix visual regressions, broken interactions, responsive issues, and styling inconsistencies.
7. Run the relevant checks and tests.

If a change does not improve the overall result, revise or revert it. If the existing design is better than the alternative, keep it. Do not claim visual verification unless you actually inspected the running interface.

### 6. Decision-Making

You may make meaningful frontend design decisions independently. Do not ask for approval of every minor design choice. Choose the strongest direction based on the product, its users, and the existing codebase. Make substantial changes when clearly justified and avoid needless rewrites.

At the end, summarize:

- What you changed.
- Why the new design is better.
- Which existing elements you retained.
- What you tested and visually verified.
- Any remaining limitations.

Success criterion: the final frontend must be demonstrably better than the original, not merely different from it.

## Commands

`npm run dev`, `test`, `lint`, `typecheck`, `ingest`, `build:indexes`, `build:stats`, `build:lookup`, `export:training`, `ml:register`

## Project agents (.claude/agents) and skills (.claude/skills)

Agents: mongo-query-optimizer, leakage-auditor, ts-reviewer, test-writer, frontend-integrator, report-writer.
Skills: /phase-runner, /add-analytics-endpoint, /verify-ingestion, /explain-report, /model-parity-check, /report-section.
