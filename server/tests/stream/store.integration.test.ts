import { flightKey, type FlightEvent } from '@flight-delay/shared';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureStreamIndexes,
  streamFlights,
  upsertEvents,
  type StreamFlightDoc,
} from '../../src/stream/store.js';

// Needs a reachable MongoDB (MONGODB_URI from vitest.config.ts); skipped when there is none.
const TEST_DB = 'flight_delay_stream_test';
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
  await ensureStreamIndexes(db);
});

afterAll(async () => {
  if (!client) return;
  await client.db(TEST_DB).dropDatabase();
  await client.close();
});

function event(flightNumber: number, runId = 'run-1', arrDelay = 20): FlightEvent {
  const pre = {
    date: '2015-12-21',
    airline: 'AA',
    flightNumber,
    origin: 'ORD',
    dest: 'LAX',
    schedDepMin: 1050,
    schedDepHour: 17,
  };
  return {
    v: 1,
    key: flightKey(pre),
    runId,
    producedAt: 1_700_000_000_000 + flightNumber,
    pre,
    outcome: {
      depDelay: 15,
      arrDelay,
      isDelayed: arrDelay >= 15,
      cancelled: false,
      diverted: false,
    },
  };
}

describe('upsertEvents (MongoDB integration)', () => {
  it('stores each flight once, keyed by its flight key', async (context) => {
    if (!client) return context.skip();
    const first = await upsertEvents(streamFlights(db), [event(1), event(2)], new Date(1000));
    expect(first).toEqual({ inserted: 2, redelivered: 0 });
    const doc = await streamFlights(db).findOne({ _id: event(1).key });
    expect(doc).toMatchObject<Partial<StreamFlightDoc>>({
      runId: 'run-1',
      lastRunId: 'run-1',
      deliveries: 1,
      prediction: null,
      scoreError: null,
      producedAt: new Date(1_700_000_000_001),
      firstWrittenAt: new Date(1000),
      lastWrittenAt: new Date(1000),
    });
  });

  it('is idempotent: a re-delivered or re-replayed event changes no counts and keeps the first write', async (context) => {
    if (!client) return context.skip();
    const before = await streamFlights(db).countDocuments();
    const again = await upsertEvents(
      streamFlights(db),
      [event(1, 'run-2', 99), event(2, 'run-2')],
      new Date(5000),
    );
    expect(again).toEqual({ inserted: 0, redelivered: 2 });
    expect(await streamFlights(db).countDocuments()).toBe(before);
    const doc = await streamFlights(db).findOne({ _id: event(1).key });
    expect(doc).toMatchObject({
      runId: 'run-1',
      lastRunId: 'run-2',
      deliveries: 2,
      firstWrittenAt: new Date(1000),
      lastWrittenAt: new Date(5000),
      // The first write wins: a later delivery never rewrites the stored event.
      outcome: { arrDelay: 20 },
    });
  });

  it('handles the same flight twice inside one batch', async (context) => {
    if (!client) return context.skip();
    const result = await upsertEvents(streamFlights(db), [event(3), event(3)], new Date(7000));
    expect(result).toEqual({ inserted: 1, redelivered: 1 });
    expect(await streamFlights(db).findOne({ _id: event(3).key })).toMatchObject({ deliveries: 2 });
  });

  it('creates its indexes idempotently', async (context) => {
    if (!client) return context.skip();
    await ensureStreamIndexes(db);
    const names = (await streamFlights(db).indexes()).map((index) => index.name).sort();
    expect(names).toEqual(['_id_', 'firstWrittenAt_-1', 'runId_1']);
  });
});
