import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import { collections, type FlightDoc } from '../db/collections.js';
import { RssMonitor } from '../ingest/rss.js';
import { EXPORT_COLUMNS, FEATURE_COLUMNS } from './feature-list.js';
import { LOOKUP_RUNS, loadLookupWithFingerprint, type LookupRunDoc } from './lookup.js';
import { buildFeatureRow, lookupScopeFor } from './row.js';
import { fromRepoRoot } from '../paths.js';

export const DEFAULT_EXPORT_DIR = fromRepoRoot('data', 'export');
export const EXPORT_RUNS = 'export_runs';
const PROGRESS_EVERY = 500_000;

/** Flights the model trains and is evaluated on: an arrival outcome and IATA codes at both ends. */
export const EXPORT_POPULATION = {
  isDelayed: { $ne: null },
  originIsIata: true,
  destIsIata: true,
} as const;

/** Only pre-departure fields plus the label: no forbidden field is ever read (§7). */
const PROJECTION = {
  date: 1,
  month: 1,
  dayOfWeek: 1,
  schedDepHour: 1,
  airline: 1,
  origin: 1,
  dest: 1,
  distance: 1,
  scheduledTime: 1,
  split: 1,
  isDelayed: 1,
} as const;

type ExportFlight = Pick<FlightDoc, keyof typeof PROJECTION> & { _id: ObjectId };

export interface ExportRunDoc {
  startedAt: Date;
  finishedAt: Date;
  status: 'completed' | 'failed';
  dir: string;
  trainRows: number;
  testRows: number;
  /** Completed flights left out because an airport is still a numeric BTS id. */
  excludedUnresolvedAirport: number;
  /** Cancelled or diverted flights (no arrival outcome; §7 excludes them). */
  excludedNoOutcome: number;
  nullScheduledTime: number;
  peakRssMb: number;
  /** lookupFingerprint of the delay_lookup these rows' rates came from (absent on older runs). */
  lookupFingerprint?: string;
  error?: string;
}

/** CSV cell; values are IATA codes and numbers, so anything needing quoting is a bug. */
function cell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    throw new Error(`Value needs CSV quoting, which the export does not do: ${text}`);
  }
  return text;
}

/**
 * A CSV file written to <name>.tmp and renamed into place only after a complete export, so
 * ml/train.py can never read a half-written file. Stream errors are captured, not unhandled.
 */
class CsvFile {
  private readonly stream: WriteStream;
  private failure: Error | undefined;

  constructor(readonly path: string) {
    this.stream = createWriteStream(`${path}.tmp`);
    this.stream.on('error', (error) => {
      this.failure = error;
    });
  }

  async writeLine(line: string): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.stream.write(`${line}\n`)) {
      await Promise.race([once(this.stream, 'drain'), once(this.stream, 'error')]);
      if (this.failure) throw this.failure;
    }
  }

  async commit(): Promise<void> {
    this.stream.end();
    await once(this.stream, 'finish');
    if (this.failure) throw this.failure;
    await rename(`${this.path}.tmp`, this.path);
  }

  async discard(): Promise<void> {
    this.stream.destroy();
    await rm(`${this.path}.tmp`, { force: true });
  }
}

/**
 * Streams the export population to train.csv / test.csv (header = EXPORT_COLUMNS). Training rows
 * use their out-of-fold lookup scope, test rows the full-train scope. Memory stays bounded: one
 * cursor, the in-memory lookup table, and file streams that respect backpressure.
 */
export async function exportTraining(
  db: Db,
  logger: Logger,
  options: { dir?: string } = {},
): Promise<ExportRunDoc> {
  const dir = options.dir ?? DEFAULT_EXPORT_DIR;
  const startedAt = new Date();
  const monitor = new RssMonitor();
  const flights = collections.flights(db);
  const counts = { trainRows: 0, testRows: 0, nullScheduledTime: 0 };
  await mkdir(dir, { recursive: true });
  const header = EXPORT_COLUMNS.join(',');
  const train = new CsvFile(join(dir, 'train.csv'));
  const test = new CsvFile(join(dir, 'test.csv'));

  try {
    const lastLookup = await db
      .collection<LookupRunDoc>(LOOKUP_RUNS)
      .findOne({}, { sort: { finishedAt: -1 } });
    if (lastLookup?.status !== 'completed') {
      throw new Error(
        'The latest build:lookup run did not complete. Run npm run build:lookup first.',
      );
    }
    const { table: lookups, fingerprint: lookupFingerprint } = await loadLookupWithFingerprint(db);
    logger.info(
      { entries: lookups.size, lookupBuildId: lastLookup.buildId, lookupFingerprint },
      'Loaded delay_lookup',
    );
    await train.writeLine(header);
    await test.writeLine(header);

    const cursor = flights.find<ExportFlight>(EXPORT_POPULATION, { projection: PROJECTION });
    for await (const flight of cursor) {
      const row = buildFeatureRow(flight, lookups, lookupScopeFor(flight.split, flight.month));
      if (flight.scheduledTime === null) counts.nullScheduledTime += 1;
      const line = [
        flight._id.toHexString(),
        flight.split,
        String(flight.month),
        flight.isDelayed ? '1' : '0',
        ...FEATURE_COLUMNS.map((column) => cell(row[column])),
      ].join(',');
      if (flight.split === 'train') {
        counts.trainRows += 1;
        await train.writeLine(line);
      } else {
        counts.testRows += 1;
        await test.writeLine(line);
      }
      const total = counts.trainRows + counts.testRows;
      if (total % PROGRESS_EVERY === 0) {
        monitor.sample();
        logger.info(
          { rows: total, rssMb: Math.round(process.memoryUsage().rss / 1048576) },
          'Export progress',
        );
      }
    }
    await Promise.all([train.commit(), test.commit()]);

    const [excludedUnresolvedAirport, excludedNoOutcome] = await Promise.all([
      flights.countDocuments({
        isDelayed: { $ne: null },
        $or: [{ originIsIata: false }, { destIsIata: false }],
      }),
      flights.countDocuments({ isDelayed: null }),
    ]);
    const run: ExportRunDoc = {
      startedAt,
      finishedAt: new Date(),
      status: 'completed',
      dir,
      ...counts,
      excludedUnresolvedAirport,
      excludedNoOutcome,
      peakRssMb: monitor.stop(),
      lookupFingerprint,
    };
    await writeFile(
      join(dir, 'manifest.json'),
      `${JSON.stringify(
        {
          generatedAt: run.finishedAt.toISOString(),
          columns: [...EXPORT_COLUMNS],
          trainRows: run.trainRows,
          testRows: run.testRows,
          excludedUnresolvedAirport,
          excludedNoOutcome,
          nullScheduledTime: run.nullScheduledTime,
          lookupFingerprint,
        },
        null,
        2,
      )}\n`,
    );
    await db.collection<ExportRunDoc>(EXPORT_RUNS).insertOne(run);
    return run;
  } catch (error) {
    await Promise.all([train.discard(), test.discard()]);
    await db
      .collection<ExportRunDoc>(EXPORT_RUNS)
      .insertOne({
        startedAt,
        finishedAt: new Date(),
        status: 'failed',
        dir,
        ...counts,
        excludedUnresolvedAirport: 0,
        excludedNoOutcome: 0,
        peakRssMb: monitor.stop(),
        error: error instanceof Error ? error.message : String(error),
      })
      .catch((recordError: unknown) =>
        logger.error({ err: recordError }, 'Could not record failed export run'),
      );
    throw error;
  }
}
