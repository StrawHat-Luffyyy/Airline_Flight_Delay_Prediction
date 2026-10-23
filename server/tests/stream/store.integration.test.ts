import { flightKey, type FlightEvent } from '@flight-delay/shared';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scoreMissing } from '../../src/stream/score-missing.js';
import type { Predictor, ScoreResult } from '../../src/stream/score.js';
import {
  ensureStreamIndexes,
  findStoredDeliveries,
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
    expect(names).toEqual(['_id_', 'firstWrittenAt_-1__id_-1', 'runId_1', 'stream_totals']);
    const ttl = (await db.collection('stream_stats').indexes()).find(
      (index) => index.name === 'lastSeenAt_ttl',
    );
    expect(ttl).toMatchObject({ key: { lastSeenAt: 1 }, expireAfterSeconds: 6 * 60 * 60 });
  });

  it('replaces the legacy firstWrittenAt index with the tie-broken one', async (context) => {
    if (!client) return context.skip();
    await streamFlights(db).dropIndex('firstWrittenAt_-1__id_-1');
    await streamFlights(db).createIndex({ firstWrittenAt: -1 }, { name: 'firstWrittenAt_-1' });
    await ensureStreamIndexes(db);
    const names = (await streamFlights(db).indexes()).map((index) => index.name);
    expect(names).not.toContain('firstWrittenAt_-1');
    expect(names).toContain('firstWrittenAt_-1__id_-1');
  });

  it('stores the live score with the first insert and never changes it on redelivery', async (context) => {
    if (!client) return context.skip();
    const scoreOf = (probability: number): ScoreResult => ({
      key: event(10).key,
      prediction: { probability, label: 'delayed', threshold: 0.2, modelVersion: 'm1' },
      scoreError: null,
      correct: true,
    });
    await upsertEvents(
      streamFlights(db),
      [event(10)],
      new Date(9000),
      new Map([[event(10).key, scoreOf(0.4)]]),
    );
    await upsertEvents(
      streamFlights(db),
      [event(10)],
      new Date(9500),
      new Map([[event(10).key, scoreOf(0.9)]]),
    );
    expect(await streamFlights(db).findOne({ _id: event(10).key })).toMatchObject({
      prediction: { probability: 0.4, label: 'delayed', threshold: 0.2, modelVersion: 'm1' },
      scoreError: null,
      correct: true,
      deliveries: 2,
    });
  });

  it('records the message that last wrote each flight, and finds stored flights with it', async (context) => {
    if (!client) return context.skip();
    const at = (offset: string) => ({ topic: 'flights.raw', partition: 2, offset });
    // Two messages for one flight in a batch: the later one is recorded.
    await upsertEvents(
      streamFlights(db),
      [event(20), event(20, 'run-2')],
      new Date(10_000),
      new Map(),
      [at('500'), at('501')],
    );
    const found = await findStoredDeliveries(streamFlights(db), [
      event(20).key,
      event(1).key,
      'nope',
      event(20).key,
    ]);
    expect([...found.keys()].sort()).toEqual([event(1).key, event(20).key].sort());
    expect(found.get(event(20).key)).toEqual({ lastSource: at('501') });
    // Stored without positions (before they were recorded): no lastSource.
    expect(found.get(event(1).key)).toEqual({ lastSource: null });
  });

  it('keeps the highest offset when a rewind re-reads an older message', async (context) => {
    if (!client) return context.skip();
    const at = (offset: string) => ({ topic: 'flights.raw', partition: 2, offset });
    // Offset 501 is stored; a rewind then re-reads 500 (the older message for the same flight).
    await upsertEvents(streamFlights(db), [event(20)], new Date(11_000), new Map(), [at('500')]);
    const found = await findStoredDeliveries(streamFlights(db), [event(20).key]);
    expect(found.get(event(20).key)?.lastSource).toEqual(at('501'));
  });

  it('backfills unscored flights once, through the same scorer, leaving scored ones alone', async (context) => {
    if (!client) return context.skip();
    const seen: string[] = [];
    const predict: Predictor = async (request) => {
      seen.push(JSON.stringify(Object.keys(request).sort()));
      return {
        probability: 0.1,
        label: 'on-time',
        threshold: 0.2,
        modelVersion: 'm2',
        derived: { dayOfWeek: 1, isHolidayWeek: true, distance: 1744, scheduledTime: 275 },
        topFactors: [],
      };
    };
    const unscoredBefore = await streamFlights(db).countDocuments({
      prediction: null,
      scoreError: null,
    });
    const first = await scoreMissing(streamFlights(db), predict, { batchSize: 1 });
    expect(first).toEqual({ scanned: unscoredBefore, scored: unscoredBefore, refused: 0 });
    // The flight scored at insert (probability 0.4) keeps its score.
    expect(await streamFlights(db).findOne({ _id: event(10).key })).toMatchObject({
      prediction: { probability: 0.4 },
    });
    expect(await streamFlights(db).findOne({ _id: event(1).key })).toMatchObject({
      prediction: { probability: 0.1, modelVersion: 'm2' },
      correct: false,
    });
    expect(new Set(seen)).toEqual(
      new Set([JSON.stringify(['airline', 'date', 'dest', 'origin', 'schedDepHour'])]),
    );
    expect(await scoreMissing(streamFlights(db), predict)).toEqual({
      scanned: 0,
      scored: 0,
      refused: 0,
    });
  });
});
