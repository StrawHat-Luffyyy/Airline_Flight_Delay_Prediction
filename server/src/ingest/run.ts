import { createReadStream, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';
import { MongoBulkWriteError, type Collection, type Db, type Filter } from 'mongodb';
import type { OptionalUnlessRequiredId } from 'mongodb';
import type { Logger } from 'pino';
import {
  collections,
  type AirlineDoc,
  type AirportDoc,
  type FlightDoc,
  type IngestRunDoc,
} from '../db/collections.js';
import type { IngestArgs } from './args.js';
import { inBatches } from './batch.js';
import { transformAirlineRow, transformAirportRow } from './reference.js';
import { REQUIRED_FLIGHT_COLUMNS, transformFlightRow, type ReferenceData } from './transform.js';

export const BATCH_SIZE = 10_000;
const PROGRESS_EVERY_ROWS = 500_000;
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../data/raw', import.meta.url));
const MALFORMED_CSV = 'malformed_csv';

interface RunStats {
  rowsRead: number;
  rowsInserted: number;
  rowsRejected: number;
  rejectReasons: Record<string, number>;
}

function newStats(): RunStats {
  return { rowsRead: 0, rowsInserted: 0, rowsRejected: 0, rejectReasons: {} };
}

function reject(stats: RunStats, reason: string): void {
  stats.rowsRejected += 1;
  stats.rejectReasons[reason] = (stats.rejectReasons[reason] ?? 0) + 1;
}

/** Tracks peak resident set size while a load runs. */
class RssMonitor {
  private peakBytes = process.memoryUsage().rss;
  private readonly timer = setInterval(() => this.sample(), 1_000);

  constructor() {
    this.timer.unref();
  }

  sample(): void {
    this.peakBytes = Math.max(this.peakBytes, process.memoryUsage().rss);
  }

  stop(): number {
    clearInterval(this.timer);
    this.sample();
    return Math.round(this.peakBytes / 1024 / 1024);
  }
}

/**
 * Streams CSV records as objects keyed by header. A missing required column fails fast.
 * A record csv-parse cannot read (e.g. broken quoting) is skipped, counted via `onSkip`,
 * and does not abort the load. File read errors propagate to the consumer via `pipeline`.
 */
function csvRows(
  file: string,
  requiredColumns: readonly string[],
  onSkip: () => void,
): AsyncIterable<unknown> {
  const parser = parse({
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    skip_records_with_error: true,
    on_skip: () => {
      onSkip();
      return undefined;
    },
    columns: (header: string[]) => {
      const missing = requiredColumns.filter((column) => !header.includes(column));
      if (missing.length > 0) {
        throw new Error(`${basename(file)} is missing columns: ${missing.join(', ')}`);
      }
      return header;
    },
  });
  // pipeline destroys the parser with the source's error (and the source when iteration stops early).
  pipeline(createReadStream(file), parser, () => undefined);
  return parser;
}

function requireFile(dir: string, name: string): string {
  const file = join(dir, name);
  if (!existsSync(file)) {
    throw new Error(
      `${file} not found. See scripts/download-data.md for the manual Kaggle download.`,
    );
  }
  return file;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RunContext {
  db: Db;
  logger: Logger;
  file: string;
  mode: IngestArgs['mode'];
  startedAt: Date;
  monitor: RssMonitor;
}

async function recordRun(
  context: RunContext,
  stats: RunStats,
  status: IngestRunDoc['status'],
  error?: unknown,
): Promise<IngestRunDoc> {
  const doc: IngestRunDoc = {
    startedAt: context.startedAt,
    finishedAt: new Date(),
    file: basename(context.file),
    status,
    mode: context.mode,
    rowsRead: stats.rowsRead,
    rowsInserted: stats.rowsInserted,
    rowsRejected: stats.rowsRejected,
    rejectReasons: { ...stats.rejectReasons },
    peakRssMb: context.monitor.stop(),
    ...(error === undefined ? {} : { error: errorMessage(error) }),
  };
  await collections.ingestRuns(context.db).insertOne(doc);
  return doc;
}

/** Records a failed run without letting a second failure hide the original error. */
async function recordFailure(context: RunContext, stats: RunStats, error: unknown): Promise<void> {
  try {
    await recordRun(context, stats, 'failed', error);
  } catch (recordError) {
    context.logger.error({ err: recordError }, 'Could not record failed ingest run');
  }
}

function startRun(db: Db, logger: Logger, file: string, mode: IngestArgs['mode']): RunContext {
  return { db, logger, file, mode, startedAt: new Date(), monitor: new RssMonitor() };
}

/** Upserts every doc by `_id`; returns how many documents now hold the file's data. */
async function replaceById<T extends AirlineDoc | AirportDoc>(
  collection: Collection<T>,
  docs: T[],
): Promise<number> {
  if (docs.length === 0) return 0;
  const operations = docs.map((doc) => ({
    replaceOne: {
      filter: { _id: doc._id } as Filter<T>,
      replacement: doc as OptionalUnlessRequiredId<T>,
      upsert: true,
    },
  }));
  const result = await collection.bulkWrite(operations);
  return result.upsertedCount + result.matchedCount;
}

/** Reference files are tiny: read fully, then replace by `_id` so re-runs are idempotent. */
async function loadReference<T extends AirlineDoc | AirportDoc>(
  context: RunContext,
  requiredColumns: readonly string[],
  transform: (raw: unknown) => T | null,
  collection: Collection<T>,
): Promise<{ docs: T[]; run: IngestRunDoc }> {
  const stats = newStats();
  try {
    const docs: T[] = [];
    for await (const raw of csvRows(context.file, requiredColumns, () => {
      stats.rowsRead += 1;
      reject(stats, MALFORMED_CSV);
    })) {
      stats.rowsRead += 1;
      const doc = transform(raw);
      if (doc) docs.push(doc);
      else reject(stats, 'invalid_row');
    }
    stats.rowsInserted = await replaceById(collection, docs);
    return { docs, run: await recordRun(context, stats, 'completed') };
  } catch (error) {
    await recordFailure(context, stats, error);
    throw error;
  }
}

async function* acceptedFlights(
  file: string,
  refs: ReferenceData,
  stats: RunStats,
  limit: number | undefined,
): AsyncGenerator<FlightDoc> {
  for await (const raw of csvRows(file, REQUIRED_FLIGHT_COLUMNS, () => {
    stats.rowsRead += 1;
    reject(stats, MALFORMED_CSV);
  })) {
    if (limit !== undefined && stats.rowsRead >= limit) return;
    stats.rowsRead += 1;
    const result = transformFlightRow(raw, refs);
    if (result.ok) yield result.doc;
    else reject(stats, result.reason);
  }
}

export interface IngestSummary {
  airlines: IngestRunDoc;
  airports: IngestRunDoc;
  flights: IngestRunDoc;
}

export async function runIngest(db: Db, args: IngestArgs, logger: Logger): Promise<IngestSummary> {
  const dir = args.dir ?? DEFAULT_DATA_DIR;
  const flightsFile = requireFile(dir, 'flights.csv');
  const airlinesFile = requireFile(dir, 'airlines.csv');
  const airportsFile = requireFile(dir, 'airports.csv');
  const flights = collections.flights(db);

  const hasFlights = (await flights.findOne({}, { projection: { _id: 1 } })) !== null;
  if (hasFlights && args.mode === 'fresh') {
    throw new Error(
      'flights already has documents. Re-run with --drop to rebuild or --append to add.',
    );
  }

  // Reference data first: a bad airlines/airports file must not leave flights dropped.
  const airlines = await loadReference(
    startRun(db, logger, airlinesFile, args.mode),
    ['IATA_CODE', 'AIRLINE'],
    transformAirlineRow,
    collections.airlines(db),
  );
  const airports = await loadReference(
    startRun(db, logger, airportsFile, args.mode),
    ['IATA_CODE', 'AIRPORT', 'CITY', 'STATE', 'COUNTRY', 'LATITUDE', 'LONGITUDE'],
    transformAirportRow,
    collections.airports(db),
  );
  logger.info(
    { airlines: airlines.run.rowsInserted, airports: airports.run.rowsInserted },
    'Loaded reference data',
  );

  if (args.mode === 'drop' && hasFlights) {
    await flights.drop();
    logger.info('Dropped flights collection');
  }

  const refs: ReferenceData = {
    airlines: new Map(airlines.docs.map((doc) => [doc._id, doc.name])),
    airports: new Map(airports.docs.map((doc) => [doc._id, { city: doc.city, state: doc.state }])),
  };

  const context = startRun(db, logger, flightsFile, args.mode);
  const stats = newStats();
  let nextProgressAt = PROGRESS_EVERY_ROWS;

  try {
    for await (const batch of inBatches(
      acceptedFlights(flightsFile, refs, stats, args.limit),
      BATCH_SIZE,
    )) {
      try {
        stats.rowsInserted += (await flights.insertMany(batch, { ordered: false })).insertedCount;
      } catch (error) {
        // ordered:false keeps going past bad documents; count what did land before failing.
        if (error instanceof MongoBulkWriteError) stats.rowsInserted += error.insertedCount;
        throw error;
      }
      context.monitor.sample();
      if (stats.rowsRead >= nextProgressAt) {
        nextProgressAt += PROGRESS_EVERY_ROWS;
        logger.info(
          {
            rowsRead: stats.rowsRead,
            rowsInserted: stats.rowsInserted,
            rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
          'Ingest progress',
        );
      }
    }
  } catch (error) {
    await recordFailure(context, stats, error);
    throw error;
  }

  const flightsRun = await recordRun(context, stats, 'completed');
  return { airlines: airlines.run, airports: airports.run, flights: flightsRun };
}
