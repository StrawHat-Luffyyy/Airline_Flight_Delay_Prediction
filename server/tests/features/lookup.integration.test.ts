import { MongoClient, type Db, type Document } from 'mongodb';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLookup, loadLookupTable } from '../../src/features/lookup.js';
import { useIntegrationTimeouts } from '../helpers/integration.js';

useIntegrationTimeouts();

// Needs a reachable MongoDB (MONGODB_URI from vitest.config.ts); skipped when there is none.
const TEST_DB = 'flight_delay_lookup_test';
const logger = pino({ level: 'silent' });

let client: MongoClient | undefined;
let db: Db;

interface Spec {
  month: number;
  airline: string;
  origin: string;
  dest: string;
  hour: number;
  isDelayed: boolean | null;
  split?: 'train' | 'test';
  originIsIata?: boolean;
}

function flight(s: Spec): Document {
  return {
    month: s.month,
    airline: s.airline,
    origin: s.origin,
    dest: s.dest,
    route: `${s.origin}-${s.dest}`,
    schedDepHour: s.hour,
    isDelayed: s.isDelayed,
    split: s.split ?? (s.month <= 9 ? 'train' : 'test'),
    originIsIata: s.originIsIata ?? true,
    destIsIata: true,
  };
}

/**
 * Completed train flights (the only rows that count):
 *   Jan: AA JFK-LAX h8 delayed, AA JFK-LAX h8 on time
 *   Apr: AA JFK-LAX h8 delayed, DL ATL-JFK h9 on time
 *   Jul: DL ATL-JFK h9 delayed, DL ATL-JFK h9 on time
 * Ignored: a cancelled train flight, an October (test) flight, an unresolved-origin flight.
 */
const FIXTURE = [
  flight({ month: 1, airline: 'AA', origin: 'JFK', dest: 'LAX', hour: 8, isDelayed: true }),
  flight({ month: 1, airline: 'AA', origin: 'JFK', dest: 'LAX', hour: 8, isDelayed: false }),
  flight({ month: 4, airline: 'AA', origin: 'JFK', dest: 'LAX', hour: 8, isDelayed: true }),
  flight({ month: 4, airline: 'DL', origin: 'ATL', dest: 'JFK', hour: 9, isDelayed: false }),
  flight({ month: 7, airline: 'DL', origin: 'ATL', dest: 'JFK', hour: 9, isDelayed: true }),
  flight({ month: 7, airline: 'DL', origin: 'ATL', dest: 'JFK', hour: 9, isDelayed: false }),
  flight({ month: 2, airline: 'AA', origin: 'JFK', dest: 'LAX', hour: 8, isDelayed: null }),
  flight({ month: 10, airline: 'AA', origin: 'JFK', dest: 'LAX', hour: 8, isDelayed: true }),
  flight({
    month: 2,
    airline: 'AA',
    origin: '10666',
    dest: 'LAX',
    hour: 8,
    isDelayed: true,
    originIsIata: false,
  }),
];

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
  await db.collection('delay_lookup').insertOne({ _id: 'stale' as never, buildId: 'old' });
});

afterAll(async () => {
  if (!client) return;
  await client.db(TEST_DB).dropDatabase();
  await client.close();
});

async function rate(scope: string, kind: string, key: string): Promise<number | undefined> {
  const doc = await db.collection('delay_lookup').findOne({ scope, kind, key });
  return typeof doc?.rate === 'number' ? doc.rate : undefined;
}

describe('buildLookup (MongoDB integration, m = 2)', () => {
  it('computes smoothed train-only rates for the full scope', async (context) => {
    if (!client) return context.skip();
    const run = await buildLookup(db, logger, { m: 2 });
    expect(run.status).toBe('completed');

    // full: 6 completed, 3 delayed -> p = 0.5; rate = (delayed + 2p) / (completed + 2)
    expect(await rate('full', 'global', '')).toBeCloseTo(0.5);
    expect(await rate('full', 'airline', 'AA')).toBeCloseTo((2 + 1) / (3 + 2)); // 0.6
    expect(await rate('full', 'airline', 'DL')).toBeCloseTo((1 + 1) / (3 + 2)); // 0.4
    expect(await rate('full', 'origin', 'JFK')).toBeCloseTo(0.6);
    expect(await rate('full', 'dest', 'JFK')).toBeCloseTo(0.4);
    expect(await rate('full', 'originHour', 'JFK|8')).toBeCloseTo(0.6);
    expect(await rate('full', 'route', 'ATL-JFK')).toBeCloseTo(0.4);
    // Excluded rows never become keys.
    expect(await rate('full', 'origin', '10666')).toBeUndefined();
  });

  it('builds each fold from the train months outside it (out-of-fold)', async (context) => {
    if (!client) return context.skip();
    // fold1 uses Apr-Sep: 4 completed, 2 delayed -> p 0.5. AA: Apr 1/1 -> (1+1)/(1+2)
    expect(await rate('fold1', 'global', '')).toBeCloseTo(0.5);
    expect(await rate('fold1', 'airline', 'AA')).toBeCloseTo(2 / 3);
    expect(await rate('fold1', 'airline', 'DL')).toBeCloseTo((1 + 1) / (3 + 2));
    // fold2 uses Jan + Jul: AA Jan 1/2 -> (1+1)/(2+2)
    expect(await rate('fold2', 'airline', 'AA')).toBeCloseTo(0.5);
    // fold3 uses Jan + Apr: DL Apr 0/1 -> (0+1)/(1+2); AA 2/3 -> (2+1)/(3+2)
    expect(await rate('fold3', 'airline', 'DL')).toBeCloseTo(1 / 3);
    expect(await rate('fold3', 'airline', 'AA')).toBeCloseTo(0.6);
  });

  it('removes stale documents and is idempotent', async (context) => {
    if (!client) return context.skip();
    expect(await db.collection('delay_lookup').findOne({ _id: 'stale' as never })).toBeNull();
    const before = await db.collection('delay_lookup').countDocuments();
    const run = await buildLookup(db, logger, { m: 2 });
    expect(await db.collection('delay_lookup').countDocuments()).toBe(before);
    expect(run.lookupDocs).toBe(before);
  });

  it('loads into a LookupTable with fallbacks', async (context) => {
    if (!client) return context.skip();
    const table = await loadLookupTable(db);
    expect(table.rate('full', 'airline', 'AA')).toBeCloseTo(0.6);
    expect(table.rate('full', 'airline', 'ZZ')).toBeCloseTo(0.5);
  });
});
