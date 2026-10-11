import { MongoClient, type Db } from 'mongodb';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLIGHT_INDEXES, ensureFlightIndexes } from '../../src/db/indexes.js';

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
  it('creates every §6.2 index, then skips them all on a second run', async (context) => {
    if (!client) return context.skip();
    const first = await ensureFlightIndexes(db, logger);
    const second = await ensureFlightIndexes(db, logger);

    expect(first.map((o) => o.status)).toEqual(FLIGHT_INDEXES.map(() => 'created'));
    expect(second.map((o) => o.status)).toEqual(FLIGHT_INDEXES.map(() => 'exists'));

    const indexes = await db.collection('flights').listIndexes().toArray();
    const partial = indexes.find((index) => index.name === 'month_1_airline_1_with_causes');
    expect(partial?.partialFilterExpression).toEqual({ causes: { $type: 'object' } });
    expect(indexes).toHaveLength(FLIGHT_INDEXES.length + 1); // + _id_
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
});
