import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, type Db, type Document } from 'mongodb';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportTraining } from '../../src/features/export.js';
import { EXPORT_COLUMNS } from '../../src/features/feature-list.js';
import { buildLookup, loadLookupTable } from '../../src/features/lookup.js';

// Needs a reachable MongoDB (MONGODB_URI from vitest.config.ts); skipped when there is none.
const TEST_DB = 'flight_delay_export_test';
const logger = pino({ level: 'silent' });

let client: MongoClient | undefined;
let db: Db;
let dir: string;

interface Spec {
  day: string;
  airline: string;
  origin: string;
  dest: string;
  isDelayed: boolean | null;
  originIsIata?: boolean;
}

function flight(s: Spec): Document {
  const date = new Date(`${s.day}T00:00:00.000Z`);
  const month = date.getUTCMonth() + 1;
  return {
    date,
    month,
    dayOfWeek: date.getUTCDay() === 0 ? 7 : date.getUTCDay(),
    schedDepHour: 8,
    schedDepMin: 480,
    airline: s.airline,
    origin: s.origin,
    dest: s.dest,
    route: `${s.origin}-${s.dest}`,
    distance: 1000,
    scheduledTime: 150,
    isDelayed: s.isDelayed,
    cancelled: s.isDelayed === null,
    // Forbidden fields exist on the documents; the export must never read them.
    depDelay: 99,
    arrDelay: s.isDelayed ? 60 : 0,
    split: month <= 9 ? 'train' : 'test',
    originIsIata: s.originIsIata ?? true,
    destIsIata: true,
  };
}

const FIXTURE = [
  flight({ day: '2015-01-05', airline: 'AA', origin: 'JFK', dest: 'LAX', isDelayed: true }),
  flight({ day: '2015-01-06', airline: 'AA', origin: 'JFK', dest: 'LAX', isDelayed: false }),
  flight({ day: '2015-04-07', airline: 'AA', origin: 'JFK', dest: 'LAX', isDelayed: true }),
  flight({ day: '2015-07-08', airline: 'DL', origin: 'ATL', dest: 'JFK', isDelayed: false }),
  flight({ day: '2015-02-09', airline: 'AA', origin: 'JFK', dest: 'LAX', isDelayed: null }), // cancelled
  flight({ day: '2015-11-25', airline: 'AA', origin: 'JFK', dest: 'LAX', isDelayed: true }), // test
  flight({
    day: '2015-10-02',
    airline: 'DL',
    origin: '10666',
    dest: 'JFK',
    isDelayed: true,
    originIsIata: false,
  }),
];

function parseCsv(text: string): string[][] {
  return text
    .trim()
    .split('\n')
    .map((line) => line.split(','));
}

beforeAll(async () => {
  const candidate = new MongoClient(process.env.MONGODB_URI ?? '', {
    serverSelectionTimeoutMS: 2_000,
  });
  try {
    await candidate.connect();
    client = candidate;
  } catch {
    await candidate.close();
    return;
  }
  db = client.db(TEST_DB);
  await db.dropDatabase();
  await db.collection('flights').insertMany(FIXTURE);
  await buildLookup(db, logger, { m: 2 });
  dir = await mkdtemp(join(tmpdir(), 'flight-export-'));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  if (!client) return;
  await client.db(TEST_DB).dropDatabase();
  await client.close();
});

describe('exportTraining (MongoDB integration)', () => {
  it('writes train/test CSVs with the contract header and only completed IATA flights', async (context) => {
    if (!client) return context.skip();
    const run = await exportTraining(db, logger, { dir });
    const train = parseCsv(await readFile(join(dir, 'train.csv'), 'utf8'));
    const test = parseCsv(await readFile(join(dir, 'test.csv'), 'utf8'));

    expect(train[0]).toEqual([...EXPORT_COLUMNS]);
    expect(test[0]).toEqual([...EXPORT_COLUMNS]);
    expect(train).toHaveLength(1 + 4);
    expect(test).toHaveLength(1 + 1);
    expect(run).toMatchObject({
      status: 'completed',
      trainRows: 4,
      testRows: 1,
      excludedUnresolvedAirport: 1,
      excludedNoOutcome: 1,
    });
    for (const header of [train[0], test[0]]) {
      expect(header).not.toContain('depDelay');
      expect(header).not.toContain('arrDelay');
    }
  });

  it('uses out-of-fold rates for training rows and full-train rates for test rows', async (context) => {
    if (!client) return context.skip();
    const table = await loadLookupTable(db);
    const train = parseCsv(await readFile(join(dir, 'train.csv'), 'utf8'));
    const test = parseCsv(await readFile(join(dir, 'test.csv'), 'utf8'));
    const header = train[0] ?? [];
    const col = (row: string[] | undefined, name: string): string =>
      row?.[header.indexOf(name)] ?? '';

    const january = train.find((row) => col(row, 'month') === '1');
    expect(Number(col(january, 'airlineRate'))).toBeCloseTo(table.rate('fold1', 'airline', 'AA'));
    expect(Number(col(test[1], 'airlineRate'))).toBeCloseTo(table.rate('full', 'airline', 'AA'));
    expect(col(test[1], 'split')).toBe('test');
    expect(col(test[1], 'label')).toBe('1');
    expect(col(test[1], 'isHolidayWeek')).toBe('1'); // day before Thanksgiving
  });

  it('writes a manifest that train.py reads for its counts', async (context) => {
    if (!client) return context.skip();
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      trainRows: 4,
      testRows: 1,
      excludedUnresolvedAirport: 1,
      excludedNoOutcome: 1,
      columns: [...EXPORT_COLUMNS],
    });
  });
});
