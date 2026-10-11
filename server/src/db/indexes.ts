import { isDeepStrictEqual } from 'node:util';
import type { Db, Document } from 'mongodb';
import type { Logger } from 'pino';
import { collections } from './collections.js';

export interface IndexSpec {
  name: string;
  /** Field order matters: equality fields first, then range/sort fields. */
  key: Record<string, 1 | -1>;
  partialFilterExpression?: Document;
  /** Which queries this index serves (PROJECT_OVERVIEW §6.2). */
  purpose: string;
}

/** The `flights` index set from PROJECT_OVERVIEW §6.2. Built after the bulk load (§6.4). */
export const FLIGHT_INDEXES: readonly IndexSpec[] = [
  { name: 'date_1', key: { date: 1 }, purpose: 'date-range scans, daily/monthly trends' },
  {
    name: 'airline_1_date_1',
    key: { airline: 1, date: 1 },
    purpose: 'one airline over a date range (equality then range)',
  },
  {
    name: 'origin_1_schedDepHour_1',
    key: { origin: 1, schedDepHour: 1 },
    purpose: 'one origin airport, optionally by scheduled hour',
  },
  { name: 'route_1', key: { route: 1 }, purpose: 'one route (origin-dest)' },
  {
    name: 'isDelayed_1_month_1',
    key: { isDelayed: 1, month: 1 },
    purpose: 'delayed / on-time flights by month',
  },
  {
    name: 'month_1_airline_1_with_causes',
    key: { month: 1, airline: 1 },
    partialFilterExpression: { causes: { $type: 'object' } },
    purpose:
      'cause analysis over only the flights that report causes; queries must include causes: { $type: "object" }',
  },
];

/** True when an existing index (from listIndexes) has the spec's key order and partial filter. */
export function matchesSpec(existing: Document, spec: IndexSpec): boolean {
  const existingKey: unknown = existing.key;
  if (typeof existingKey !== 'object' || existingKey === null) return false;
  // Entries keep field order, which is part of an index definition.
  const sameKey = isDeepStrictEqual(Object.entries(existingKey), Object.entries(spec.key));
  const samePartial = isDeepStrictEqual(
    existing.partialFilterExpression ?? null,
    spec.partialFilterExpression ?? null,
  );
  return sameKey && samePartial;
}

export interface IndexOutcome {
  name: string;
  status: 'created' | 'exists';
  ms: number;
}

/**
 * Creates any missing §6.2 index, one at a time, timing each build. Idempotent: an index that
 * already exists with the same definition is skipped. A name or key clash with a different
 * definition throws instead of dropping anything.
 */
export async function ensureFlightIndexes(db: Db, logger: Logger): Promise<IndexOutcome[]> {
  const flights = collections.flights(db);
  const existing = await flights.listIndexes().toArray();

  // Check every spec before building anything, so a conflict never leaves a half-built set.
  const missing: IndexSpec[] = [];
  for (const spec of FLIGHT_INDEXES) {
    const sameName = existing.find((index) => index.name === spec.name);
    if (sameName && matchesSpec(sameName, spec)) continue;
    const clash = sameName ?? existing.find((index) => matchesSpec(index, spec));
    if (clash) {
      throw new Error(
        `Index "${String(clash.name)}" conflicts with the definition of "${spec.name}". Inspect it; it is not dropped automatically.`,
      );
    }
    missing.push(spec);
  }

  const outcomes: IndexOutcome[] = [];
  for (const spec of FLIGHT_INDEXES) {
    if (!missing.includes(spec)) {
      outcomes.push({ name: spec.name, status: 'exists', ms: 0 });
      logger.info({ index: spec.name }, 'Index already exists');
      continue;
    }

    const started = performance.now();
    await flights.createIndex(spec.key, {
      name: spec.name,
      ...(spec.partialFilterExpression
        ? { partialFilterExpression: spec.partialFilterExpression }
        : {}),
    });
    const ms = Math.round(performance.now() - started);
    outcomes.push({ name: spec.name, status: 'created', ms });
    logger.info({ index: spec.name, ms }, 'Index created');
  }
  return outcomes;
}

export interface CollectionSizes {
  count: number;
  dataSizeMb: number;
  storageSizeMb: number;
  totalIndexSizeMb: number;
  indexSizesMb: Record<string, number>;
}

const toMb = (bytes: unknown): number =>
  typeof bytes === 'number' ? Math.round((bytes / 1024 / 1024) * 10) / 10 : 0;

/** `db.flights.stats()` equivalent via $collStats (collStats command is deprecated). */
export async function flightsSizes(db: Db): Promise<CollectionSizes> {
  const [stats] = await collections
    .flights(db)
    .aggregate<{ storageStats?: Document }>([{ $collStats: { storageStats: {} } }])
    .toArray();
  const storage = stats?.storageStats ?? {};
  const indexSizes: unknown = storage.indexSizes;
  return {
    count: typeof storage.count === 'number' ? storage.count : 0,
    dataSizeMb: toMb(storage.size),
    storageSizeMb: toMb(storage.storageSize),
    totalIndexSizeMb: toMb(storage.totalIndexSize),
    indexSizesMb:
      typeof indexSizes === 'object' && indexSizes !== null
        ? Object.fromEntries(Object.entries(indexSizes).map(([name, size]) => [name, toMb(size)]))
        : {},
  };
}
