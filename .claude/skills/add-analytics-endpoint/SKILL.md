---
name: add-analytics-endpoint
description: Scaffold a complete analytics feature for the flights data - a pure aggregation pipeline builder, seeded-fixture test, zod-validated Express route, shared types, cache, explain check and typed web hook. Use whenever the user wants a new analysis, chart, ranking, breakdown or /api/analytics endpoint, even if they do not say "endpoint".
argument-hint: "[analysis name, e.g. delay-rate-by-hour]"
---
# Add an analytics endpoint: $ARGUMENTS

Follow PROJECT_OVERVIEW.md sections 6, 8 and 9. Do the steps in order.

1. **Define the contract** in `shared/`: zod schema for query params and the response type. Params must have sensible defaults and caps (`limit <= 100`, `minFlights` default 500 for rankings).
2. **Pipeline builder** `server/src/analytics/<name>.ts`: a pure function `(params) => Document[]`. `$match` first, project early, `$facet` only when several slices share one scan, `allowDiskUse: true` for heavy groups. Treat `causes.*` null as 0 only inside the pipeline (`$ifNull`). Exclude cancelled/diverted when computing delay rates.
3. **Data source choice**: if the result can be served from a `stats_*` collection, read that; otherwise query `flights` with an index-backed `$match`. If a new stats collection is needed, add its `$merge` job to `build:stats`.
4. **Test** with the `test-writer` agent: tiny hand-computed fixture, edge cases (null causes, tiny groups, cancelled flights).
5. **Route** `server/src/routes/analytics.ts`: validate with zod, call the service, in-memory TTL cache for heavy results, errors in the project shape. Thin handler only.
6. **Performance**: run the `mongo-query-optimizer` agent on the pipeline. Require IXSCAN or a stats-collection read, and < 1 s on the full dataset. Append results to `docs/EXPLAIN_RESULTS.md`.
7. **Frontend** (if a UI element uses it): add a typed react-query hook in `web/src/api/` and wire the component with loading, empty and error states. No mock data.
8. Run typecheck, lint and tests. Summarise: endpoint path, params, example response, timing.
