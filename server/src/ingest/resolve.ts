import { writeFile } from 'node:fs/promises';
import type { AnyBulkWriteOperation, Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import { collections, type FlightDoc, type ResolveRunDoc } from '../db/collections.js';
import {
  DEFAULT_THRESHOLDS,
  ReferenceIndex,
  VoteTally,
  decideMappings,
  scheduleKey,
  type AirportIdDecision,
  type MappingThresholds,
} from './airport-ids.js';
import { inBatches } from './batch.js';
import { RssMonitor } from './rss.js';

export const DEFAULT_REFERENCE_MONTHS: readonly number[] = [9, 11];
const UPDATE_BATCH_SIZE = 10_000;

export interface ResolveOptions {
  apply: boolean;
  thresholds?: MappingThresholds;
  referenceMonths?: readonly number[];
  /** Where to write the mapping report as JSON; omitted = not written. */
  mapFile?: string;
}

export interface ResolveResult {
  run: ResolveRunDoc;
  decisions: AirportIdDecision[];
}

type AirportLocation = { city: string | null; state: string | null };

/** Rows that carried a numeric id in either role (both before and after resolution). */
const HAS_NUMERIC_ID = {
  $or: [{ originAirportId: { $ne: null } }, { destAirportId: { $ne: null } }],
};

const KEY_PROJECTION = {
  airline: 1,
  flightNumber: 1,
  schedDepMin: 1,
  schedArrMin: 1,
  origin: 1,
  dest: 1,
  originAirportId: 1,
  destAirportId: 1,
} as const;

type KeyedRow = Pick<
  FlightDoc,
  | 'airline'
  | 'flightNumber'
  | 'schedDepMin'
  | 'schedArrMin'
  | 'origin'
  | 'dest'
  | 'originAirportId'
  | 'destAirportId'
> & { _id: ObjectId };

async function buildReferenceIndex(
  db: Db,
  months: readonly number[],
  monitor: RssMonitor,
): Promise<ReferenceIndex> {
  const index = new ReferenceIndex();
  const cursor = collections.flights(db).find<KeyedRow>(
    {
      month: { $in: [...months] },
      originIsIata: true,
      destIsIata: true,
      originAirportId: null,
      destAirportId: null,
    },
    { projection: KEY_PROJECTION },
  );
  let rows = 0;
  for await (const row of cursor) {
    index.add(scheduleKey(row), row.origin, row.dest);
    rows += 1;
    if (rows % 100_000 === 0) monitor.sample();
  }
  return index;
}

interface VoteScan {
  tally: VoteTally;
  rows: number;
  matched: number;
  /** "originId|destId" -> row count; ids are '' when that role was already IATA. */
  pairs: Map<string, number>;
}

async function voteOnNumericRows(
  db: Db,
  index: ReferenceIndex,
  monitor: RssMonitor,
): Promise<VoteScan> {
  const scan: VoteScan = { tally: new VoteTally(), rows: 0, matched: 0, pairs: new Map() };
  const cursor = collections
    .flights(db)
    .find<KeyedRow>(HAS_NUMERIC_ID, { projection: KEY_PROJECTION });
  for await (const row of cursor) {
    scan.rows += 1;
    if (row.originAirportId) scan.tally.seen(row.originAirportId);
    if (row.destAirportId) scan.tally.seen(row.destAirportId);
    const pair = `${row.originAirportId ?? ''}|${row.destAirportId ?? ''}`;
    scan.pairs.set(pair, (scan.pairs.get(pair) ?? 0) + 1);

    const route = index.get(scheduleKey(row));
    if (route) {
      scan.matched += 1;
      if (row.originAirportId) scan.tally.addOrigin(row.originAirportId, route.origin);
      if (row.destAirportId) scan.tally.addDest(row.destAirportId, route.dest);
    }
    if (scan.rows % 100_000 === 0) monitor.sample();
  }
  return scan;
}

/** Resolved-row counts implied by a mapping, from the (originId, destId) pair counts. */
function coverage(pairs: Map<string, number>, mapping: ReadonlyMap<string, string>) {
  let full = 0;
  let origin = 0;
  let dest = 0;
  for (const [pair, count] of pairs) {
    const [originId = '', destId = ''] = pair.split('|');
    const originOk = originId === '' || mapping.has(originId);
    const destOk = destId === '' || mapping.has(destId);
    if (originOk) origin += count;
    if (destOk) dest += count;
    if (originOk && destOk) full += count;
  }
  return { full, origin, dest };
}

function roleFields(
  role: 'origin' | 'dest',
  id: string,
  mapping: ReadonlyMap<string, string>,
  airports: ReadonlyMap<string, AirportLocation>,
): Record<string, unknown> {
  const iata = mapping.get(id);
  const location = iata === undefined ? undefined : airports.get(iata);
  return {
    [role]: iata ?? id,
    [`${role}IsIata`]: iata !== undefined,
    [`${role}IataDerived`]: iata !== undefined,
    [`${role}City`]: location?.city ?? null,
    [`${role}State`]: location?.state ?? null,
  };
}

/**
 * Rewrites every row with a numeric id from its original id, so re-runs are idempotent.
 * The raw `originAirportId` / `destAirportId` are never modified.
 */
// Safe to update while iterating: the cursor filters on the raw-id fields, which updates never change.
async function* updatesFor(
  db: Db,
  mapping: ReadonlyMap<string, string>,
  airports: ReadonlyMap<string, AirportLocation>,
): AsyncGenerator<AnyBulkWriteOperation<FlightDoc>> {
  const cursor = collections
    .flights(db)
    .find<KeyedRow>(HAS_NUMERIC_ID, { projection: KEY_PROJECTION });
  for await (const row of cursor) {
    const set: Record<string, unknown> = {};
    if (row.originAirportId)
      Object.assign(set, roleFields('origin', row.originAirportId, mapping, airports));
    if (row.destAirportId)
      Object.assign(set, roleFields('dest', row.destAirportId, mapping, airports));
    const origin = typeof set.origin === 'string' ? set.origin : row.origin;
    const dest = typeof set.dest === 'string' ? set.dest : row.dest;
    set.route = `${origin}-${dest}`;
    yield { updateOne: { filter: { _id: row._id }, update: { $set: set } } };
  }
}

function mappingReport(
  decisions: AirportIdDecision[],
  thresholds: MappingThresholds,
  referenceMonths: readonly number[],
  run: Omit<ResolveRunDoc, 'finishedAt' | 'peakRssMb' | 'status'>,
) {
  const round = (share: number) => Math.round(share * 10_000) / 10_000;
  return {
    description:
      'Numeric BTS airport ids in flights.csv resolved to IATA codes by resolve:airport-ids. ' +
      'Derived offline from schedule matches, not from an official crosswalk.',
    method:
      'Key = (airline, flightNumber, schedDepMin, schedArrMin). Reference months with IATA codes ' +
      'give key -> (origin, dest); keys seen with more than one pair are discarded. Each row with a ' +
      'numeric id whose key matches votes id -> IATA (origin and dest roles counted together).',
    thresholds,
    referenceMonths,
    counts: {
      referenceRows: run.referenceRows,
      referenceKeys: run.referenceKeys,
      ambiguousKeys: run.ambiguousKeys,
      rowsWithNumericIds: run.rowsWithNumericIds,
      rowsMatched: run.rowsMatched,
      distinctIds: run.distinctIds,
      mappedIds: run.mappedIds,
      rowsFullyResolved: run.rowsFullyResolved,
    },
    mappings: Object.fromEntries(decisions.filter((d) => d.accepted).map((d) => [d.id, d.iata])),
    details: decisions.map((d) => ({ ...d, topShare: round(d.topShare) })),
  };
}

export async function resolveAirportIds(
  db: Db,
  options: ResolveOptions,
  logger: Logger,
): Promise<ResolveResult> {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const referenceMonths = options.referenceMonths ?? DEFAULT_REFERENCE_MONTHS;
  const startedAt = new Date();
  const monitor = new RssMonitor();
  const mode: ResolveRunDoc['mode'] = options.apply ? 'apply' : 'dry-run';

  try {
    // Data ingested before raw ids were stored would silently resolve nothing: refuse instead.
    const stale = await collections.flights(db).findOne(
      {
        $or: [
          { originIsIata: false, originAirportId: null },
          { destIsIata: false, destAirportId: null },
        ],
      },
      { projection: { _id: 1 } },
    );
    if (stale) {
      throw new Error(
        "flights has numeric airport codes without originAirportId/destAirportId. Re-run 'npm run ingest -- --drop' first.",
      );
    }

    const index = await buildReferenceIndex(db, referenceMonths, monitor);
    const indexStats = index.stats();
    logger.info(indexStats, 'Built schedule reference index');

    const scan = await voteOnNumericRows(db, index, monitor);
    const decisions = decideMappings(scan.tally, thresholds);
    const mapping = new Map(
      decisions.flatMap((d) => (d.accepted && d.iata ? [[d.id, d.iata] as const] : [])),
    );
    const projected = coverage(scan.pairs, mapping);

    let rowsUpdated = 0;
    if (options.apply) {
      // Small reference collection (322 airports), so loading it whole is bounded.
      const airportDocs = await collections.airports(db).find().toArray();
      const airports = new Map(airportDocs.map((a) => [a._id, { city: a.city, state: a.state }]));
      for await (const batch of inBatches(updatesFor(db, mapping, airports), UPDATE_BATCH_SIZE)) {
        rowsUpdated += (await collections.flights(db).bulkWrite(batch, { ordered: false }))
          .modifiedCount;
        monitor.sample();
      }
    }

    const body = {
      startedAt,
      mode,
      thresholds,
      referenceMonths: [...referenceMonths],
      referenceRows: indexStats.rows,
      referenceKeys: indexStats.keys,
      ambiguousKeys: indexStats.ambiguousKeys,
      rowsWithNumericIds: scan.rows,
      rowsMatched: scan.matched,
      distinctIds: decisions.length,
      mappedIds: mapping.size,
      unmappedIds: decisions.filter((d) => !d.accepted).map((d) => d.id),
      rowsFullyResolved: projected.full,
      rowsOriginResolved: projected.origin,
      rowsDestResolved: projected.dest,
      rowsUpdated,
    };
    // A dry run reports only; it must not replace the committed mapping file.
    if (options.apply && options.mapFile) {
      const report = mappingReport(decisions, thresholds, referenceMonths, body);
      await writeFile(options.mapFile, `${JSON.stringify(report, null, 2)}\n`);
    }
    const run: ResolveRunDoc = {
      ...body,
      status: 'completed',
      finishedAt: new Date(),
      peakRssMb: monitor.stop(),
    };
    await collections.resolveRuns(db).insertOne(run);
    return { run, decisions };
  } catch (error) {
    try {
      await collections.resolveRuns(db).insertOne({
        startedAt,
        finishedAt: new Date(),
        status: 'failed',
        mode,
        thresholds,
        referenceMonths: [...referenceMonths],
        referenceRows: 0,
        referenceKeys: 0,
        ambiguousKeys: 0,
        rowsWithNumericIds: 0,
        rowsMatched: 0,
        distinctIds: 0,
        mappedIds: 0,
        unmappedIds: [],
        rowsFullyResolved: 0,
        rowsOriginResolved: 0,
        rowsDestResolved: 0,
        rowsUpdated: 0,
        peakRssMb: monitor.stop(),
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (recordError) {
      logger.error({ err: recordError }, 'Could not record failed resolve run');
    }
    throw error;
  }
}
