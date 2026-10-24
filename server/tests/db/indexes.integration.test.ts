import { MongoClient, type Db } from 'mongodb';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_FLIGHT_INDEXES, ensureFlightIndexes } from '../../src/db/indexes.js';
import { useIntegrationTimeouts } from '../helpers/integration.js';

useIntegrationTimeouts();

// Needs a reachable MongoDB (MONGODB_URI from vitest.config.ts); skipped when there is none.
const TEST_DB = 'flight_delay_indexes_test';
const logger = pino({ level: 'silent' });

let client: MongoClient | undefined;
let db: Db;

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
  await db.collection('flights').insertOne({ month: 1, airline: 'AA', causes: null });
});

afterAll(async () => {
  if (!client) return;
  await client.db(TEST_DB).dropDatabase();
  await client.close();
});

describe('ensureFlightIndexes (MongoDB integration)', () => {
  it('creates every §6.2 and API index, then skips them all on a second run', async (context) => {
    if (!client) return context.skip();
    const first = await ensureFlightIndexes(db, logger);
    const second = await ensureFlightIndexes(db, logger);

    expect(first.map((o) => o.status)).toEqual(ALL_FLIGHT_INDEXES.map(() => 'created'));
    expect(second.map((o) => o.status)).toEqual(ALL_FLIGHT_INDEXES.map(() => 'exists'));

    const indexes = await db.collection('flights').listIndexes().toArray();
    const partial = indexes.find((index) => index.name === 'month_1_airline_1_with_causes');
    expect(partial?.partialFilterExpression).toEqual({ causes: { $type: 'object' } });
    expect(indexes).toHaveLength(ALL_FLIGHT_INDEXES.length + 1); // + _id_
  });

  it('refuses, without dropping, when an index name is taken by another definition', async (context) => {
    if (!client) return context.skip();
    await db.collection('flights').dropIndex('route_1');
    await db.collection('flights').createIndex({ route: -1 }, { name: 'route_1' });

    await expect(ensureFlightIndexes(db, logger)).rejects.toThrow(/not dropped automatically/);
    const route = (await db.collection('flights').listIndexes().toArray()).find(
      (index) => index.name === 'route_1',
    );
    expect(route?.key).toEqual({ route: -1 });
  });

  it('retires the superseded airline_1_origin_1 index, and only that exact definition', async (context) => {
    if (!client) return context.skip();
    const flights = db.collection('flights');
    await flights.dropIndexes();
    await flights.createIndex({ airline: 1, origin: 1 }, { name: 'airline_1_origin_1' });

    const outcomes = await ensureFlightIndexes(db, logger);
    const names = (await flights.listIndexes().toArray()).map((index) => index.name);
    expect(outcomes).toContainEqual(
      expect.objectContaining({ name: 'airline_1_origin_1', status: 'retired' }),
    );
    expect(names).not.toContain('airline_1_origin_1');
    expect(names).toContain('airline_1_origin_1__id_1');

    // A user index that merely reuses the retired name with another key is left alone.
    await flights.createIndex({ airline: -1, origin: 1 }, { name: 'airline_1_origin_1' });
    const again = await ensureFlightIndexes(db, logger);
    expect(again.find((o) => o.name === 'airline_1_origin_1')).toBeUndefined();
    expect((await flights.listIndexes().toArray()).map((index) => index.name)).toContain(
      'airline_1_origin_1',
    );
  });
});
