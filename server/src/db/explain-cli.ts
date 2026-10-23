import { writeFile } from 'node:fs/promises';
import type { Db } from 'mongodb';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { closeMongo, connectToMongo, getDb } from './client.js';
import {
  airlineMonthlyCounts,
  checkSameResults,
  measure,
  type Measurement,
  type MonthlyCount,
  type ResultCheck,
} from './explain.js';
import { flightsSizes, type CollectionSizes } from './indexes.js';
import { REPRESENTATIVE_QUERIES, type RepresentativeQuery } from './representative-queries.js';
import { toShellSyntax } from './shell-format.js';
import type { DataQuality } from '@flight-delay/shared';
import { loadDataQuality } from '../analytics/common.js';
import { STATS_COLLECTIONS } from '../stats/builders.js';
import { API_LIMIT_MS, measureApi, type ApiTiming } from './api-timing.js';
import { fromRepoRoot } from '../paths.js';

const OUTPUT = fromRepoRoot('docs', 'EXPLAIN_RESULTS.md');
const RUNS = 3;
const Q1_AIRLINE = 'AA';
const Q1_MONTH = 3;

interface Result {
  query: RepresentativeQuery;
  before: Measurement;
  after: Measurement;
  check: ResultCheck;
}

interface Q1Sanity {
  months: MonthlyCount[];
  total: number;
  sum: number;
  q1Count: number;
  monthCount: number;
  sumMatchesTotal: boolean;
  monthMatchesQ1: boolean;
}

const fmt = (n: number): string => n.toLocaleString('en-US');
const plan = (m: Measurement): string => m.stages.join(' > ') || '(none)';
const speedup = (r: Result): string =>
  r.after.serverMs === 0
    ? `>${fmt(r.before.serverMs)}x (after < 1 ms)`
    : `${(r.before.serverMs / r.after.serverMs).toFixed(1)}x`;
/** COUNT_SCAN reports the count value as nReturned; it returns one row. */
const returned = (m: Measurement): string =>
  m.stages[0] === 'COUNT_SCAN' ? `1 row (count = ${fmt(m.nReturned)})` : fmt(m.nReturned);
/** Phase 2 acceptance: an index scan on the index the query was designed for. */
const usesExpectedIndex = (r: Result): boolean =>
  r.query.expectedIndex !== null &&
  r.after.indexes.includes(r.query.expectedIndex) &&
  r.after.stages.some((stage) => stage === 'IXSCAN' || stage === 'COUNT_SCAN');

const checkText = (c: ResultCheck): string =>
  c.compared === 'count'
    ? `${c.identical ? 'PASS' : 'FAIL'}: count ${fmt(c.collscan)} (collscan) ${c.identical ? '=' : '!='} ${fmt(c.indexed)} (indexed)`
    : `${c.identical ? 'PASS' : 'FAIL'}: ${fmt(c.collscan)} result docs (collscan) vs ${fmt(c.indexed)} (indexed), ${c.identical ? 'identical' : 'DIFFERENT'}`;

function queryText(query: RepresentativeQuery): string {
  const body =
    query.kind === 'find'
      ? `db.flights.find(${toShellSyntax(query.filter)}${query.projection ? `, ${toShellSyntax(query.projection)}` : ''})`
      : `db.flights.aggregate(${toShellSyntax(query.pipeline, 2)})`;
  return ['```js', body, '```'].join('\n');
}

const apiPlan = (a: ApiTiming): string =>
  a.plan
    ? `${a.plan.stages.join(' > ')}${a.plan.indexes.length ? ` (${a.plan.indexes.join(', ')})` : ''}`
    : 'n/a';

function apiSection(
  api: ApiTiming[],
  statsDocs: Record<string, number>,
  quality: DataQuality | null,
): string {
  const passing = api.filter((a) => a.status === 200 && a.medianMs < API_LIMIT_MS).length;
  return [
    '## API endpoint timings (Phase 3)',
    '',
    '- **How they were measured:** each endpoint was called over HTTP against the real Express app running in-process. The response cache was disabled (`cacheTtlMs: 0`), so every request runs its query. Times are wall-clock medians of the runs.',
    '- **What they read:** analytics endpoints read the pre-aggregated `stats_*` collections built by `npm run build:stats`. `/api/flights` reads `flights` through the §6.2 indexes.',
    '',
    `**Acceptance (Phase 3: every endpoint < 1 s on the full dataset):** ${passing === api.length ? 'PASS' : 'FAIL'}. ${passing} of ${api.length} requests returned 200 in under ${fmt(API_LIMIT_MS)} ms.`,
    '',
    '| Endpoint | Status | Median ms | Max ms | Reads | Plan of the underlying query | Docs examined |',
    '|---|---|---|---|---|---|---|',
    ...api.map(
      (a) =>
        `| \`${a.path}\` | ${a.status} | ${fmt(a.medianMs)} | ${fmt(a.maxMs)} | ${a.source} | ${apiPlan(a)} | ${a.plan ? fmt(a.plan.totalDocsExamined) : 'n/a'} |`,
    ),
    '',
    quality
      ? `**Data coverage:** ${fmt(quality.unresolvedOriginFlights)} of ${fmt(quality.flights)} flights (${((quality.unresolvedOriginFlights / quality.flights) * 100).toFixed(3)}%) still have an unresolved numeric origin airport id, and ${fmt(quality.unresolvedRouteFlights)} have an unresolved origin or destination. They count toward the totals by airline, month and day of week. Airport-, hour- and route-keyed results exclude them, and those responses report this in \`coverage.excludedUnresolvedFlights\`.`
      : '**Data coverage:** no stats build recorded.',
    '',
    `Stats collection sizes (documents): ${Object.entries(statsDocs)
      .map(([name, docs]) => `\`${name}\` ${fmt(docs)}`)
      .join(', ')}.`,
  ].join('\n');
}

async function statsDocCounts(db: Db): Promise<Record<string, number>> {
  const entries = await Promise.all(
    STATS_COLLECTIONS.map(
      async (name) => [name, await db.collection(name).countDocuments()] as const,
    ),
  );
  return Object.fromEntries(entries);
}

function q1SanitySection(s: Q1Sanity): string {
  const monthName = (m: number): string =>
    new Date(Date.UTC(2015, m - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return [
    '## Q1 sanity check',
    '',
    `This is an independent count of ${Q1_AIRLINE} flights per month. It is read by collection scan (\`.hint({ $natural: 1 })\`), so it does not go through \`airline_1_date_1\`.`,
    '',
    '| Month | Flights |',
    '|---|---|',
    ...s.months.map((m) => `| ${monthName(m.month)} | ${fmt(m.flights)} |`),
    `| **Sum** | **${fmt(s.sum)}** |`,
    '',
    `- Sum of the monthly counts = ${fmt(s.sum)}; \`countDocuments({ airline: "${Q1_AIRLINE}" })\` = ${fmt(s.total)}: ${s.sumMatchesTotal ? 'PASS' : 'FAIL'}.`,
    `- ${monthName(Q1_MONTH)} = ${fmt(s.monthCount)}; Q1 (indexed, date range 2015-03-01 to 2015-04-01) returned ${fmt(s.q1Count)}: ${s.monthMatchesQ1 ? 'PASS' : 'FAIL'}.`,
  ].join('\n');
}

function interpretation(r: Result): string {
  const { query, before, after } = r;
  const index = after.indexes.join(', ');
  const verdict =
    query.expectedIndex === null
      ? `Both plans read all ${fmt(before.totalDocsExamined)} documents (${plan(after)}), so an index cannot help this query.`
      : after.indexes.includes(query.expectedIndex)
        ? `With \`${index}\` the planner examined ${fmt(after.totalKeysExamined)} index keys and ${fmt(after.totalDocsExamined)} documents instead of scanning ${fmt(before.totalDocsExamined)}, so it ran ${speedup(r)} faster (${fmt(before.serverMs)} ms -> ${fmt(after.serverMs)} ms server time).`
        : `**Unexpected plan:** expected \`${query.expectedIndex}\` but the winning plan was ${plan(after)} (${index || 'no index'}).`;
  return `${query.why} ${verdict}`;
}

function sizesTable(sizes: CollectionSizes): string {
  const rows = Object.entries(sizes.indexSizesMb).map(([name, mb]) => `| \`${name}\` | ${mb} |`);
  return [
    `- Documents: ${fmt(sizes.count)}`,
    `- Data size (uncompressed BSON): ${fmt(sizes.dataSizeMb)} MB`,
    `- Storage size (compressed on disk): ${fmt(sizes.storageSizeMb)} MB`,
    `- Total index size: ${fmt(sizes.totalIndexSizeMb)} MB (${((sizes.totalIndexSizeMb / sizes.storageSizeMb) * 100).toFixed(1)}% of storage size)`,
    '',
    '| Index | Size (MB) |',
    '|---|---|',
    ...rows,
  ].join('\n');
}

interface Context {
  sizes: CollectionSizes;
  measuredAt: Date;
  mongoVersion: string;
  octoberRows: number;
  octoberUnresolvedOrigin: number;
  q1Sanity: Q1Sanity;
  api: ApiTiming[];
  statsDocs: Record<string, number>;
  quality: DataQuality | null;
}

function render(results: Result[], context: Context): string {
  const { sizes, measuredAt } = context;
  const unresolvedShare = ((context.octoberUnresolvedOrigin / context.octoberRows) * 100).toFixed(
    2,
  );
  const indexed = results.filter((r) => r.query.expectedIndex !== null);
  const passing = indexed.filter(usesExpectedIndex).length;
  const allIndexScans = passing === indexed.length;
  const identical = results.filter((r) => r.check.identical).length;
  const summary = results.map(
    (r) =>
      `| ${r.query.id} | ${r.query.title} | ${fmt(r.before.serverMs)} | ${fmt(r.after.serverMs)} | ${speedup(r)} | ${fmt(r.before.totalDocsExamined)} -> ${fmt(r.after.totalDocsExamined)} | ${fmt(r.after.totalKeysExamined)} | ${returned(r.after)} | ${plan(r.after)} | ${r.after.indexes.map((i) => `\`${i}\``).join(', ') || 'none'} | ${r.check.identical ? 'yes' : '**NO**'} |`,
  );
  const details = results.map((r) =>
    [
      `### ${r.query.id}. ${r.query.title}`,
      '',
      queryText(r.query),
      '',
      `- Before (\`.hint({ $natural: 1 })\`): ${plan(r.before)}; ${fmt(r.before.totalDocsExamined)} docs examined; ${fmt(r.before.serverMs)} ms server, ${fmt(r.before.wallMs)} ms wall.`,
      `- After (default plan): ${plan(r.after)}; index ${r.after.indexes.map((i) => `\`${i}\``).join(', ') || 'none'}; ${fmt(r.after.totalKeysExamined)} keys and ${fmt(r.after.totalDocsExamined)} docs examined; ${returned(r.after)} returned by the query stage; ${fmt(r.after.serverMs)} ms server, ${fmt(r.after.wallMs)} ms wall.`,
      `- Same result under both plans: ${checkText(r.check)}.`,
      '',
      interpretation(r),
    ].join('\n'),
  );

  return [
    '# Explain results: index evidence',
    '',
    `Generated by \`npm run explain:report\` on ${measuredAt.toISOString().slice(0, 10)} against the \`${env.MONGODB_DB}\` database (MongoDB ${context.mongoVersion}, single node in Docker). Every number below was measured in that run.`,
    '',
    '## Method',
    '',
    '- Each query runs `explain("executionStats")` in two modes:',
    '  - **Before**: `.hint({ $natural: 1 })` forces a full collection scan. No real index is dropped to get this baseline.',
    '  - **After**: the planner picks its plan freely, with the PROJECT_OVERVIEW §6.2 indexes in place (`npm run build:indexes`).',
    `- Times are medians of ${RUNS} runs per mode. Server time is \`executionTimeMillis\`; wall time is the client round trip.`,
    '- Runs are back to back, so the cache is warm. Cold-cache times would be higher, mostly for the collection scans.',
    '- "Docs examined" and "keys examined" come from the last run. They do not vary between runs.',
    `- **Unresolved airports:** airport-keyed queries (Q2, Q3) filter \`originIsIata: true\`. At measurement time ${fmt(context.octoberUnresolvedOrigin)} of ${fmt(context.octoberRows)} October rows (${unresolvedShare}%) still had a numeric BTS origin id that \`resolve:airport-ids\` could not map, and airport analytics must exclude them.`,
    '- **Q8 is a control**, not an index candidate: ranking every route has to read every flight.',
    '- **Same-result check:** each query also runs for real under both plans, to prove the index changes only the speed.',
    '  - Find queries compare `countDocuments` with `hint: { $natural: 1 }` against the default plan.',
    '  - Aggregations compare their complete result arrays document by document. Sorts end on `_id`, so ties cannot reorder.',
    '',
    `**Acceptance (Phase 2: every representative query uses an IXSCAN):** ${allIndexScans ? 'PASS' : 'FAIL'}. ${passing} of ${indexed.length} indexed queries use an index scan (IXSCAN or COUNT_SCAN) on their intended index.`,
    '',
    `**Same-result check:** ${identical === results.length ? 'PASS' : 'FAIL'}. ${identical} of ${results.length} queries return identical results under the collection scan and the default plan.`,
    '',
    '## Summary',
    '',
    '| # | Query | Before ms | After ms | Speedup | Docs examined (before -> after) | Keys examined (after) | Returned | Plan (after) | Index | Same result |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...summary,
    '',
    q1SanitySection(context.q1Sanity),
    '',
    apiSection(context.api, context.statsDocs, context.quality),
    '',
    '## Collection and index sizes',
    '',
    sizesTable(sizes),
    '',
    '## Cost trade-off',
    '',
    '- **Memory and disk:** indexes speed up selective reads, but every index costs RAM and disk. Its keys compete with documents for the WiredTiger cache.',
    '- **Writes:** every index slows every insert. This is why `npm run ingest` loads the data first and `npm run build:indexes` builds the indexes afterwards (§6.4). The per-index build times and before/after sizes are in `docs/DECISIONS.md` (Phase 2).',
    '- **Selectivity:** the indexes pay off for selective access (one airline, one airport, one route, one month).',
    '- **Whole-collection rankings:** the control query Q8 shows an index cannot help a ranking over the whole collection. Such reads are served by the pre-aggregated `stats_*` collections (`npm run build:stats`), as the API timings above show.',
    '',
    '## Per-query detail',
    '',
    ...details.flatMap((d) => [d, '']),
  ].join('\n');
}

async function main(): Promise<void> {
  await connectToMongo();
  const db = getDb();
  const sizes = await flightsSizes(db);
  if (sizes.count === 0) throw new Error('flights is empty. Run `npm run ingest` first.');
  if (Object.keys(sizes.indexSizesMb).length <= 1) {
    throw new Error('Only the _id index exists. Run `npm run build:indexes` first.');
  }

  const measuredAt = new Date();
  const results: Result[] = [];
  for (const query of REPRESENTATIVE_QUERIES) {
    const before = await measure(db, query, 'collscan', RUNS);
    const after = await measure(db, query, 'default', RUNS);
    const check = await checkSameResults(db, query);
    results.push({ query, before, after, check });
    logger.info({ id: query.id, check: checkText(check) }, 'Same-result check');
    logger.info(
      {
        id: query.id,
        beforeMs: before.serverMs,
        afterMs: after.serverMs,
        docsBefore: before.totalDocsExamined,
        docsAfter: after.totalDocsExamined,
        keysAfter: after.totalKeysExamined,
        planAfter: after.stages,
        indexes: after.indexes,
      },
      'Measured',
    );
  }
  const flights = db.collection('flights');
  const buildInfo = await db.admin().command({ buildInfo: 1 });
  const context: Context = {
    sizes,
    measuredAt,
    mongoVersion: typeof buildInfo.version === 'string' ? buildInfo.version : 'unknown',
    octoberRows: await flights.countDocuments({ month: 10 }),
    octoberUnresolvedOrigin: await flights.countDocuments({ month: 10, originIsIata: false }),
    q1Sanity: await q1Sanity(db, results),
    api: await measureApi(db, RUNS),
    statsDocs: await statsDocCounts(db),
    quality: await loadDataQuality(db),
  };
  await writeFile(OUTPUT, render(results, context));
  logger.info({ output: OUTPUT }, 'explain:report written');

  const failed = [
    ...context.api
      .filter((a) => a.status !== 200 || a.medianMs >= API_LIMIT_MS)
      .map((a) => `${a.path} returned ${a.status} in ${a.medianMs} ms`),
    ...results.filter((r) => !r.check.identical).map((r) => `${r.query.id} results differ`),
    ...(context.q1Sanity.sumMatchesTotal ? [] : ['Q1 sanity: monthly sum != total']),
    ...(context.q1Sanity.monthMatchesQ1 ? [] : ['Q1 sanity: March count != Q1']),
  ];
  if (failed.length > 0) throw new Error(`Result checks failed: ${failed.join('; ')}`);
}

async function q1Sanity(db: Db, results: Result[]): Promise<Q1Sanity> {
  const q1 = results.find((r) => r.query.id === 'Q1');
  if (!q1) throw new Error('Q1 is missing from REPRESENTATIVE_QUERIES');
  const { months, total } = await airlineMonthlyCounts(db, Q1_AIRLINE);
  const sum = months.reduce((acc, m) => acc + m.flights, 0);
  const monthCount = months.find((m) => m.month === Q1_MONTH)?.flights ?? 0;
  const sanity: Q1Sanity = {
    months,
    total,
    sum,
    q1Count: q1.check.indexed,
    monthCount,
    sumMatchesTotal: sum === total,
    monthMatchesQ1: monthCount === q1.check.indexed,
  };
  logger.info(
    { months: months.map((m) => `${m.month}:${m.flights}`), sum, total, q1Count: sanity.q1Count },
    'Q1 sanity check',
  );
  return sanity;
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'explain:report failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
