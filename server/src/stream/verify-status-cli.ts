/**
 * `npm run stream:verify-status -- [--url http://127.0.0.1:3001]`: checks GET /api/stream/status
 * against an independent recomputation from stream_flights (§15.9 item 7). Stop the consumer first:
 * a write during the run fails the check.
 *
 * Independent of the endpoint's code path:
 * - Counts: instead of COUNT_SCANs on (label, isDelayed), every document is streamed through a cursor
 *   and classified by its stored `correct` verdict and label (correct + "delayed" = TP, wrong +
 *   "delayed" = FP, ...), cross-checking isDelayed on the way.
 * - Rates are recomputed here from those counts, per (modelVersion, threshold) group.
 * - Window ROC-AUC: a direct count over every (delayed, on-time) pair (O(n^2) on at most
 *   window.size rows), not the endpoint's rank-sum formula.
 * Bounded memory: one cursor batch at a time, plus at most window-size rows.
 */
import {
  StreamStatusResponseSchema,
  type StreamMetricGroup,
  type StreamStatusResponse,
} from '@flight-delay/shared';
import { env } from '../config/env.js';
import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { streamFlights } from './store.js';

interface Cells {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Scored, no arrival outcome. */
  noOutcome: number;
}

interface Tally {
  flights: number;
  scored: number;
  refused: number;
  unscored: number;
  groups: Map<string, Cells>;
}

interface Row {
  correct: boolean | null;
  scoreError: string | null;
  prediction: {
    label: 'delayed' | 'on-time';
    probability: number;
    modelVersion: string;
    threshold: number;
  } | null;
  outcome: { isDelayed: boolean | null };
  pre: { date: string; schedDepHour: number };
}

const groupKey = (modelVersion: string, threshold: number) => `${modelVersion}|${threshold}`;
const emptyTally = (): Tally => ({
  flights: 0,
  scored: 0,
  refused: 0,
  unscored: 0,
  groups: new Map(),
});

function add(tally: Tally, row: Row): void {
  tally.flights += 1;
  if (row.prediction === null) {
    if (row.scoreError !== null) tally.refused += 1;
    else tally.unscored += 1;
    return;
  }
  tally.scored += 1;
  const key = groupKey(row.prediction.modelVersion, row.prediction.threshold);
  let cells = tally.groups.get(key);
  if (cells === undefined) {
    cells = { tp: 0, fp: 0, fn: 0, tn: 0, noOutcome: 0 };
    tally.groups.set(key, cells);
  }
  if (row.correct === null) {
    cells.noOutcome += 1;
    return;
  }
  const flagged = row.prediction.label === 'delayed';
  // Cross-check: the stored verdict must agree with the outcome.
  if (row.correct !== (flagged === row.outcome.isDelayed)) {
    throw new Error('stored `correct` disagrees with label and outcome');
  }
  if (flagged) cells[row.correct ? 'tp' : 'fp'] += 1;
  else cells[row.correct ? 'tn' : 'fn'] += 1;
}

/** Share of (delayed, on-time) pairs where the delayed flight has the higher probability. */
function pairwiseAuc(rows: ReadonlyArray<{ p: number; y: boolean }>): number | null {
  const positives = rows.filter((row) => row.y).map((row) => row.p);
  const negatives = rows.filter((row) => !row.y).map((row) => row.p);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const p of positives) {
    for (const q of negatives) wins += p > q ? 1 : p === q ? 0.5 : 0;
  }
  return wins / (positives.length * negatives.length);
}

const PROJECTION = { correct: 1, scoreError: 1, prediction: 1, outcome: 1, pre: 1 };

async function recompute(windowSize: number) {
  const flights = streamFlights(getDb());
  const all = emptyTally();
  for await (const row of flights.find<Row>({}, { projection: PROJECTION, batchSize: 10_000 })) {
    add(all, row);
  }
  const window = emptyTally();
  const dates: string[] = [];
  const hours: number[] = [];
  const pairs = new Map<string, Array<{ p: number; y: boolean }>>();
  const newest = flights
    .find<Row>({ correct: { $ne: null } }, { projection: PROJECTION })
    .sort({ firstWrittenAt: -1, _id: -1 })
    .limit(windowSize);
  for await (const row of newest) {
    add(window, row);
    dates.push(row.pre.date);
    hours.push(row.pre.schedDepHour);
    if (row.prediction !== null && row.outcome.isDelayed !== null) {
      const key = groupKey(row.prediction.modelVersion, row.prediction.threshold);
      const list = pairs.get(key) ?? [];
      list.push({ p: row.prediction.probability, y: row.outcome.isDelayed });
      pairs.set(key, list);
    }
  }
  dates.sort();
  return {
    all,
    window,
    pairs,
    windowStart: dates[0] ?? null,
    windowEnd: dates.at(-1) ?? null,
    departureHours:
      hours.length === 0 ? null : { min: Math.min(...hours), max: Math.max(...hours) },
  };
}

/** Rates recomputed here from the tallied cells, with the endpoint's documented null rules. */
function rates({ tp, fp, fn, tn }: Cells) {
  const n = tp + fp + fn + tn;
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  const baseRate = n === 0 ? null : (tp + fn) / n;
  return {
    n,
    precision,
    recall,
    f1,
    baseRate,
    accuracy: n === 0 ? null : (tp + tn) / n,
    majorityBaseline: baseRate === null ? null : Math.max(baseRate, 1 - baseRate),
  };
}

type Check = [name: string, endpoint: unknown, recomputed: unknown];

/** Exact for counts and dates; within 1e-12 for rates computed by different arithmetic. */
function matches(endpoint: unknown, recomputed: unknown): boolean {
  if (typeof endpoint === 'number' && typeof recomputed === 'number') {
    return Number.isInteger(endpoint) && Number.isInteger(recomputed)
      ? endpoint === recomputed
      : Math.abs(endpoint - recomputed) <= 1e-12;
  }
  return JSON.stringify(endpoint) === JSON.stringify(recomputed);
}

function groupChecks(prefix: string, group: StreamMetricGroup, cells: Cells | undefined): Check[] {
  const mine = cells ?? { tp: 0, fp: 0, fn: 0, tn: 0, noOutcome: 0 };
  const r = rates(mine);
  return [
    [`${prefix} TP`, group.tp, mine.tp],
    [`${prefix} FP`, group.fp, mine.fp],
    [`${prefix} FN`, group.fn, mine.fn],
    [`${prefix} TN`, group.tn, mine.tn],
    [`${prefix} n`, group.n, r.n],
    [`${prefix} precision`, group.precision, r.precision],
    [`${prefix} recall`, group.recall, r.recall],
    [`${prefix} F1`, group.f1, r.f1],
    [`${prefix} base rate`, group.baseRate, r.baseRate],
    [`${prefix} accuracy`, group.accuracy?.value ?? null, r.accuracy],
    [`${prefix} majority baseline`, group.accuracy?.majorityBaseline ?? null, r.majorityBaseline],
  ];
}

function parseUrl(argv: readonly string[]): string {
  if (argv.length === 0) return `http://127.0.0.1:${env.PORT}`;
  if (argv[0] === '--url' && argv[1] !== undefined && argv.length === 2) return argv[1];
  throw new Error('Usage: npm run stream:verify-status -- [--url http://127.0.0.1:3001]');
}

async function fetchStatus(base: string): Promise<StreamStatusResponse> {
  const response = await fetch(`${base}/api/stream/status`);
  if (!response.ok) throw new Error(`GET /api/stream/status answered ${response.status}`);
  return StreamStatusResponseSchema.parse(await response.json());
}

async function main(): Promise<void> {
  const base = parseUrl(process.argv.slice(2));
  await connectToMongo();
  const status = await fetchStatus(base);
  if (status.totals === null || status.window === null || status.stored === null) {
    throw new Error(`endpoint has no metrics: ${status.metricsReason}`);
  }
  const started = performance.now();
  const mine = await recompute(status.window.size);
  const recomputeMs = Math.round(performance.now() - started);
  // A write between the endpoint's read and this one shows up as a count mismatch below; this check
  // names the cause (the endpoint's counts may come from its few-second cache).
  const changed = (await streamFlights(getDb()).countDocuments()) !== status.stored.flights;

  const checks: Check[] = [
    ['stored.flights', status.stored.flights, mine.all.flights],
    ['stored.scored', status.stored.scored, mine.all.scored],
    ['stored.refused', status.stored.refused, mine.all.refused],
    ['stored.unscored', status.stored.unscored, mine.all.unscored],
    ['totals groups', status.totals.groups.length, mine.all.groups.size],
    ['window groups', status.window.groups.length, mine.window.groups.size],
    [
      'window n',
      status.window.n,
      [...mine.window.groups.values()].reduce((s, c) => s + rates(c).n, 0),
    ],
    ['windowStart', status.window.windowStart, mine.windowStart],
    ['windowEnd', status.window.windowEnd, mine.windowEnd],
    ['departureHours', status.window.departureHours, mine.departureHours],
  ];
  for (const group of status.totals.groups) {
    const key = groupKey(group.modelVersion, group.threshold);
    const cells = mine.all.groups.get(key);
    checks.push(...groupChecks(`totals[${key}]`, group, cells));
    checks.push([`totals[${key}] noOutcome`, group.noOutcome, cells?.noOutcome ?? 0]);
    checks.push([
      `totals[${key}] scored`,
      group.scored,
      cells === undefined ? 0 : rates(cells).n + cells.noOutcome,
    ]);
  }
  for (const group of status.window.groups) {
    const key = groupKey(group.modelVersion, group.threshold);
    checks.push(...groupChecks(`window[${key}]`, group, mine.window.groups.get(key)));
    checks.push([`window[${key}] ROC-AUC`, group.rocAuc, pairwiseAuc(mine.pairs.get(key) ?? [])]);
  }

  const results = checks.map(([name, endpoint, recomputed]) => ({
    name,
    endpoint,
    recomputed,
    match: matches(endpoint, recomputed),
  }));
  for (const result of results) logger.info(result, result.match ? 'match' : 'MISMATCH');
  const failed = results.filter((result) => !result.match);
  logger.info(
    { checks: results.length, failed: failed.length, recomputeMs, changedDuringRun: changed },
    failed.length === 0 ? 'stream:verify-status: all checks match' : 'stream:verify-status FAILED',
  );
  if (failed.length > 0 || changed) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'stream:verify-status failed (is the API running? npm run dev)');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
