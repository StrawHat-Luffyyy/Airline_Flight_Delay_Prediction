import { MongoClient, type Db, type Document } from 'mongodb';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAirportIds } from '../../src/ingest/resolve.js';
import { useIntegrationTimeouts } from '../helpers/integration.js';

useIntegrationTimeouts();

// Needs a reachable MongoDB (MONGODB_URI from vitest.config.ts); skipped when there is none.
const TEST_DB = 'flight_delay_resolve_test';
const logger = pino({ level: 'silent' });

let client: MongoClient | undefined;
let db: Db;

interface ServiceSpec {
  month: number;
  flightNumber: number;
  origin: string;
  dest: string;
}

function flight({ month, flightNumber, origin, dest }: ServiceSpec): Document {
  const originIsIata = !/^\d{5}$/.test(origin);
  const destIsIata = !/^\d{5}$/.test(dest);
  return {
    month,
    airline: 'AA',
    flightNumber,
    schedDepMin: flightNumber,
    schedArrMin: flightNumber + 100,
    origin,
    dest,
    originIsIata,
    destIsIata,
    originAirportId: originIsIata ? null : origin,
    destAirportId: destIsIata ? null : dest,
    originIataDerived: false,
    destIataDerived: false,
    originCity: null,
    originState: null,
    destCity: null,
    destState: null,
    route: `${origin}-${dest}`,
  };
}

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}

/**
 * - 12478 (origin) and 12892 (dest): 25 October services that fly JFK-LAX in September.
 * - 11111: 30 October services whose reference origins split 18 ATL / 12 ORD (ambiguous, 60%).
 */
function fixture(): Document[] {
  const clear = range(1, 25);
  const atl = range(100, 18);
  const ord = range(200, 12);
  return [
    ...clear.map((n) => flight({ month: 9, flightNumber: n, origin: 'JFK', dest: 'LAX' })),
    ...atl.map((n) => flight({ month: 11, flightNumber: n, origin: 'ATL', dest: 'LAX' })),
    ...ord.map((n) => flight({ month: 11, flightNumber: n, origin: 'ORD', dest: 'LAX' })),
    ...clear.map((n) => flight({ month: 10, flightNumber: n, origin: '12478', dest: '12892' })),
    ...[...atl, ...ord].map((n) =>
      flight({ month: 10, flightNumber: n, origin: '11111', dest: '12892' }),
    ),
  ];
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
  await db.collection('airports').insertMany([
    { _id: 'JFK', name: 'JFK', city: 'New York', state: 'NY' },
    { _id: 'LAX', name: 'LAX', city: 'Los Angeles', state: 'CA' },
  ] as Document[]);
  await db.collection('flights').insertMany(fixture());
});

afterAll(async () => {
  if (!client) return;
  await client.db(TEST_DB).dropDatabase();
  await client.close();
});

async function octoberRow(flightNumber: number): Promise<Document | null> {
  return db.collection('flights').findOne({ month: 10, flightNumber }, { projection: { _id: 0 } });
}

describe('resolveAirportIds (MongoDB integration)', () => {
  it('dry run reports the mapping without touching flights', async (context) => {
    if (!client) return context.skip();
    const { run, decisions } = await resolveAirportIds(db, { apply: false }, logger);

    expect(run).toMatchObject({
      mode: 'dry-run',
      rowsWithNumericIds: 55,
      rowsMatched: 55,
      distinctIds: 3,
      mappedIds: 2,
      unmappedIds: ['11111'],
      rowsFullyResolved: 25,
      rowsUpdated: 0,
    });
    expect(decisions.find((d) => d.id === '11111')).toMatchObject({
      accepted: false,
      reason: 'low_top_share',
      candidates: { ATL: 18, ORD: 12 },
    });
    expect((await octoberRow(1))?.origin).toBe('12478');
  });

  it('applies only accepted ids, keeps raw ids, fills location and route', async (context) => {
    if (!client) return context.skip();
    const { run } = await resolveAirportIds(db, { apply: true }, logger);
    expect(run.rowsUpdated).toBe(55);

    expect(await octoberRow(1)).toMatchObject({
      origin: 'JFK',
      originAirportId: '12478',
      originIsIata: true,
      originIataDerived: true,
      originCity: 'New York',
      originState: 'NY',
      dest: 'LAX',
      destAirportId: '12892',
      destIataDerived: true,
      destCity: 'Los Angeles',
      route: 'JFK-LAX',
    });
    expect(await octoberRow(100)).toMatchObject({
      origin: '11111',
      originAirportId: '11111',
      originIsIata: false,
      originIataDerived: false,
      originCity: null,
      dest: 'LAX',
      destIataDerived: true,
      route: '11111-LAX',
    });
    // Reference months are never modified.
    expect(
      await db
        .collection('flights')
        .countDocuments({ month: { $ne: 10 }, originIataDerived: true }),
    ).toBe(0);
  });

  it('is idempotent: a second apply changes nothing and reports the same counts', async (context) => {
    if (!client) return context.skip();
    const before = await db
      .collection('flights')
      .find({}, { projection: { _id: 0 } })
      .sort({ month: 1, flightNumber: 1 })
      .toArray();
    const { run } = await resolveAirportIds(db, { apply: true }, logger);
    const after = await db
      .collection('flights')
      .find({}, { projection: { _id: 0 } })
      .sort({ month: 1, flightNumber: 1 })
      .toArray();

    expect(after).toEqual(before);
    expect(run).toMatchObject({
      mappedIds: 2,
      rowsFullyResolved: 25,
      unmappedIds: ['11111'],
      rowsUpdated: 0,
    });
  });

  it('refuses data ingested before raw airport ids were stored', async (context) => {
    if (!client) return context.skip();
    const legacy = flight({ month: 10, flightNumber: 999, origin: '99999', dest: 'LAX' });
    delete legacy.originAirportId;
    const { insertedId } = await db.collection('flights').insertOne(legacy);
    try {
      await expect(resolveAirportIds(db, { apply: true }, logger)).rejects.toThrow(
        /ingest -- --drop/,
      );
    } finally {
      await db.collection('flights').deleteOne({ _id: insertedId });
    }
  });
});
