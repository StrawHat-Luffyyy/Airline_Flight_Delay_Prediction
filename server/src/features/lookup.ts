import { randomUUID } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  FOLD_MONTHS,
  LookupTable,
  lookupFingerprint,
  type LookupEntry,
  type LookupKind,
  type LookupScope,
} from './row.js';

/**
 * delay_lookup: historical delay rates used as model features (PROJECT_OVERVIEW §6.1, §7),
 * computed from the TRAIN split only.
 *
 * Step 1 scans the train flights once into delay_lookup_cells, keyed by
 * (airline, origin, dest, hour, month). Step 2 derives every scope and key kind from those cells:
 * - full:   all train months (used by test rows and /predict);
 * - foldK:  the train months outside fold K (used by training rows of fold K), so no training
 *           row's rate includes its own label (out-of-fold target encoding).
 * Rates are m-estimate smoothed toward the scope's global rate: (delayed + m p) / (completed + m).
 */

export const LOOKUP_SMOOTHING_M = 50;
export const LOOKUP_SCOPES: readonly LookupScope[] = ['full', 'fold1', 'fold2', 'fold3'];
export const LOOKUP_KINDS: readonly Exclude<LookupKind, 'global'>[] = [
  'airline',
  'origin',
  'dest',
  'originHour',
  'route',
];
const CELLS = 'delay_lookup_cells';
const LOOKUP = 'delay_lookup';
export const LOOKUP_RUNS = 'lookup_runs';

/** Train flights with an outcome and IATA codes at both ends (unresolved ids never become keys). */
export const TRAIN_POPULATION = {
  split: 'train',
  isDelayed: { $ne: null },
  originIsIata: true,
  destIsIata: true,
} as const;

const KEY_EXPRESSIONS: Record<Exclude<LookupKind, 'global'>, unknown> = {
  airline: '$airline',
  origin: '$origin',
  dest: '$dest',
  originHour: { $concat: ['$origin', '|', { $toString: '$hour' }] },
  route: { $concat: ['$origin', '-', '$dest'] },
};

export function lookupCellsPipeline(buildId: string): Document[] {
  return [
    { $match: TRAIN_POPULATION },
    {
      $group: {
        _id: {
          airline: '$airline',
          origin: '$origin',
          dest: '$dest',
          hour: '$schedDepHour',
          month: '$month',
        },
        completed: { $sum: 1 },
        delayed: { $sum: { $cond: [{ $eq: ['$isDelayed', true] }, 1, 0] } },
      },
    },
    {
      $set: {
        airline: '$_id.airline',
        origin: '$_id.origin',
        dest: '$_id.dest',
        hour: '$_id.hour',
        month: '$_id.month',
        buildId,
      },
    },
    { $merge: { into: CELLS, on: '_id', whenMatched: 'replace', whenNotMatched: 'insert' } },
  ];
}

/** Cells that belong to a scope: every train month for full, the other folds for foldK. */
export function scopeMatch(scope: LookupScope): Document {
  return scope === 'full' ? {} : { month: { $nin: [...FOLD_MONTHS[scope]] } };
}

export function lookupPipeline(
  scope: LookupScope,
  kind: Exclude<LookupKind, 'global'>,
  globalRate: number,
  m: number,
  buildId: string,
): Document[] {
  return [
    { $match: scopeMatch(scope) },
    {
      $group: {
        _id: KEY_EXPRESSIONS[kind],
        completed: { $sum: '$completed' },
        delayed: { $sum: '$delayed' },
      },
    },
    {
      $project: {
        _id: { $concat: [`${scope}/${kind}/`, '$_id'] },
        scope,
        kind,
        key: '$_id',
        completed: 1,
        delayed: 1,
        rate: {
          $divide: [{ $add: ['$delayed', m * globalRate] }, { $add: ['$completed', m] }],
        },
        buildId,
      },
    },
    { $merge: { into: LOOKUP, on: '_id', whenMatched: 'replace', whenNotMatched: 'insert' } },
  ];
}

export interface ScopeSummary {
  scope: LookupScope;
  completed: number;
  delayed: number;
  globalRate: number;
}

export interface LookupRunDoc {
  buildId: string;
  startedAt: Date;
  finishedAt: Date;
  status: 'completed' | 'failed';
  m: number;
  cellsMs: number;
  cellsDocs: number;
  lookupDocs: number;
  scopes: ScopeSummary[];
  error?: string;
}

async function scopeTotals(db: Db, scope: LookupScope): Promise<ScopeSummary> {
  const [totals] = await db
    .collection(CELLS)
    .aggregate<{ completed: number; delayed: number }>([
      { $match: scopeMatch(scope) },
      {
        $group: { _id: null, completed: { $sum: '$completed' }, delayed: { $sum: '$delayed' } },
      },
    ])
    .toArray();
  const completed = totals?.completed ?? 0;
  const delayed = totals?.delayed ?? 0;
  if (completed === 0) throw new Error(`No completed train flights for lookup scope ${scope}`);
  return { scope, completed, delayed, globalRate: delayed / completed };
}

/** Rebuilds delay_lookup (and its cells) from the train split; idempotent via a buildId sweep. */
export async function buildLookup(
  db: Db,
  logger: Logger,
  options: { m?: number } = {},
): Promise<LookupRunDoc> {
  const m = options.m ?? LOOKUP_SMOOTHING_M;
  const buildId = randomUUID();
  const startedAt = new Date();
  const scopes: ScopeSummary[] = [];
  let cellsMs = 0;

  try {
    const started = performance.now();
    await db
      .collection('flights')
      .aggregate(lookupCellsPipeline(buildId), { allowDiskUse: true })
      .toArray();
    await db.collection(CELLS).deleteMany({ buildId: { $ne: buildId } });
    cellsMs = Math.round(performance.now() - started);
    logger.info({ ms: cellsMs }, 'Built delay_lookup_cells');

    for (const scope of LOOKUP_SCOPES) {
      const summary = await scopeTotals(db, scope);
      scopes.push(summary);
      await db.collection(LOOKUP).replaceOne(
        { _id: `${scope}/global/` as never },
        {
          scope,
          kind: 'global',
          key: '',
          completed: summary.completed,
          delayed: summary.delayed,
          rate: summary.globalRate,
          buildId,
        },
        { upsert: true },
      );
      for (const kind of LOOKUP_KINDS) {
        await db
          .collection(CELLS)
          .aggregate(lookupPipeline(scope, kind, summary.globalRate, m, buildId))
          .toArray();
      }
    }
    await db.collection(LOOKUP).deleteMany({ buildId: { $ne: buildId } });
    await db.collection(LOOKUP).createIndex({ scope: 1, kind: 1, key: 1 });
  } catch (error) {
    await db
      .collection<LookupRunDoc>(LOOKUP_RUNS)
      .insertOne({
        buildId,
        startedAt,
        finishedAt: new Date(),
        status: 'failed',
        m,
        cellsMs,
        cellsDocs: 0,
        lookupDocs: 0,
        scopes,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch((recordError: unknown) =>
        logger.error({ err: recordError }, 'Could not record failed lookup run'),
      );
    throw error;
  }

  const run: LookupRunDoc = {
    buildId,
    startedAt,
    finishedAt: new Date(),
    status: 'completed',
    m,
    cellsMs,
    cellsDocs: await db.collection(CELLS).countDocuments(),
    lookupDocs: await db.collection(LOOKUP).countDocuments(),
    scopes,
  };
  await db.collection<LookupRunDoc>(LOOKUP_RUNS).insertOne(run);
  return run;
}

const StoredEntry = z.object({
  scope: z.enum(['full', 'fold1', 'fold2', 'fold3']),
  kind: z.enum(['global', 'airline', 'origin', 'dest', 'originHour', 'route']),
  key: z.string(),
  rate: z.number(),
});

async function loadLookupEntries(db: Db): Promise<LookupEntry[]> {
  const docs = await db
    .collection(LOOKUP)
    .find({}, { projection: { _id: 0, scope: 1, kind: 1, key: 1, rate: 1 } })
    .toArray();
  return z.array(StoredEntry).parse(docs);
}

/** Loads delay_lookup into memory (tens of thousands of small entries). */
export async function loadLookupTable(db: Db): Promise<LookupTable> {
  return new LookupTable(await loadLookupEntries(db));
}

/** lookupFingerprint of the delay_lookup currently in the database. */
export async function loadLookupFingerprint(db: Db): Promise<string> {
  return lookupFingerprint(await loadLookupEntries(db));
}

/** The table and its fingerprint from one read, so both describe the same rates. */
export async function loadLookupWithFingerprint(
  db: Db,
): Promise<{ table: LookupTable; fingerprint: string }> {
  const entries = await loadLookupEntries(db);
  return { table: new LookupTable(entries), fingerprint: lookupFingerprint(entries) };
}
