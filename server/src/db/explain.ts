import { isDeepStrictEqual } from 'node:util';
import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import { collections } from './collections.js';
import type { RepresentativeQuery } from './representative-queries.js';

const ExecutionStatsSchema = z.object({
  executionTimeMillis: z.number(),
  totalKeysExamined: z.number(),
  totalDocsExamined: z.number(),
  nReturned: z.number(),
});

export interface ExplainSummary extends z.infer<typeof ExecutionStatsSchema> {
  /** Winning-plan stages, outermost first. */
  stages: string[];
  /** Indexes the winning plan reads. */
  indexes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkPlan(node: unknown, stages: string[], indexes: string[]): void {
  if (!isRecord(node)) return;
  // Slot-based (SBE) plans wrap the readable tree in `queryPlan`.
  if (isRecord(node.queryPlan)) return walkPlan(node.queryPlan, stages, indexes);
  if (typeof node.stage === 'string') stages.push(node.stage);
  if (typeof node.indexName === 'string') indexes.push(node.indexName);
  walkPlan(node.inputStage, stages, indexes);
  if (Array.isArray(node.inputStages)) {
    for (const child of node.inputStages) walkPlan(child, stages, indexes);
  }
}

/** The part of an explain document that holds queryPlanner/executionStats (find or aggregate). */
function queryLayer(explain: Document): Record<string, unknown> {
  if (isRecord(explain.executionStats)) return explain;
  const stages: unknown = explain.stages;
  if (Array.isArray(stages) && isRecord(stages[0]) && isRecord(stages[0].$cursor)) {
    return stages[0].$cursor;
  }
  return explain;
}

/** Pure: reduce explain("executionStats") output to the numbers the report needs. */
export function summarizeExplain(explain: Document): ExplainSummary {
  const layer = queryLayer(explain);
  const parsed = ExecutionStatsSchema.safeParse(layer.executionStats);
  if (!parsed.success) throw new Error('explain output has no executionStats');

  const stages: string[] = [];
  const indexes: string[] = [];
  const planner = layer.queryPlanner;
  if (isRecord(planner)) walkPlan(planner.winningPlan, stages, indexes);
  return { stages, indexes, ...parsed.data };
}

export type PlanMode = 'collscan' | 'default';

export interface Measurement extends ExplainSummary {
  /** Median wall-clock time of the explain round trips, in ms. */
  wallMs: number;
  /** Median server executionTimeMillis. */
  serverMs: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

async function explainOnce(db: Db, query: RepresentativeQuery, mode: PlanMode): Promise<Document> {
  const flights = collections.flights(db);
  const natural = { $natural: 1 } as const;
  if (query.kind === 'find') {
    const cursor = flights.find(
      query.filter,
      query.projection ? { projection: query.projection } : {},
    );
    return (mode === 'collscan' ? cursor.hint(natural) : cursor).explain('executionStats');
  }
  return flights
    .aggregate(
      query.pipeline,
      mode === 'collscan' ? { hint: natural, allowDiskUse: true } : { allowDiskUse: true },
    )
    .explain('executionStats');
}

/** Runs explain("executionStats") `runs` times and reports medians (collscan = hint $natural). */
export async function measure(
  db: Db,
  query: RepresentativeQuery,
  mode: PlanMode,
  runs = 3,
): Promise<Measurement> {
  const wall: number[] = [];
  const server: number[] = [];
  let last: ExplainSummary | undefined;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    const explain = await explainOnce(db, query, mode);
    wall.push(performance.now() - started);
    last = summarizeExplain(explain);
    server.push(last.executionTimeMillis);
  }
  if (!last) throw new Error('runs must be >= 1');
  return { ...last, wallMs: Math.round(median(wall)), serverMs: median(server) };
}

export interface ResultCheck {
  /** find queries compare counts; aggregations compare the full result documents. */
  compared: 'count' | 'documents';
  collscan: number;
  indexed: number;
  identical: boolean;
}

/** Runs the query for real under both plans and checks that the index changes nothing but speed. */
export async function checkSameResults(db: Db, query: RepresentativeQuery): Promise<ResultCheck> {
  const flights = collections.flights(db);
  const natural = { $natural: 1 } as const;
  if (query.kind === 'find') {
    const collscan = await flights.countDocuments(query.filter, { hint: natural });
    const indexed = await flights.countDocuments(query.filter);
    return { compared: 'count', collscan, indexed, identical: collscan === indexed };
  }
  const collscan = await flights
    .aggregate(query.pipeline, { hint: natural, allowDiskUse: true })
    .toArray();
  const indexed = await flights.aggregate(query.pipeline, { allowDiskUse: true }).toArray();
  return {
    compared: 'documents',
    collscan: collscan.length,
    indexed: indexed.length,
    identical: isDeepStrictEqual(collscan, indexed),
  };
}

export interface MonthlyCount {
  month: number;
  flights: number;
}

/**
 * Independent check for Q1: an airline's flights per month, read by collection scan (so not
 * through the airline/date index), plus the airline's total.
 */
export async function airlineMonthlyCounts(
  db: Db,
  airline: string,
): Promise<{ months: MonthlyCount[]; total: number }> {
  const flights = collections.flights(db);
  const months = await flights
    .aggregate<MonthlyCount>(
      [
        { $match: { airline } },
        { $group: { _id: '$month', flights: { $sum: 1 } } },
        { $project: { _id: 0, month: '$_id', flights: 1 } },
        { $sort: { month: 1 } },
      ],
      { hint: { $natural: 1 } },
    )
    .toArray();
  const total = await flights.countDocuments({ airline }, { hint: { $natural: 1 } });
  return { months, total };
}
