import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStatsPipeline } from '../../src/stream/measure.js';

// Needs a reachable MongoDB 7+ (MONGODB_URI from vitest.config.ts); skipped when there is none.
const TEST_DB = 'flight_delay_stream_measure_test';
let client: MongoClient | undefined;
let db: Db;

interface Flight {
  _id: string;
  runId: string;
  producedAt: Date;
  firstWrittenAt: Date;
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
  const produced = Date.UTC(2026, 9, 22, 10, 0, 0);
  // 100 flights of run-a with latencies 1..100 ms, plus one flight of another run.
  await db.collection<Flight>('stream_flights').insertMany([
    ...Array.from({ length: 100 }, (_, i) => ({
      _id: `k${i}`,
      runId: 'run-a',
      producedAt: new Date(produced + i * 10),
      firstWrittenAt: new Date(produced + i * 10 + i + 1),
    })),
    {
      _id: 'other',
      runId: 'run-b',
      producedAt: new Date(produced),
      firstWrittenAt: new Date(produced + 9999),
    },
  ]);
});

afterAll(async () => {
  if (!client) return;
  await client.db(TEST_DB).dropDatabase();
  await client.close();
});

describe('runStatsPipeline (MongoDB integration)', () => {
  it('summarises one run: counts, span and latency percentiles', async (context) => {
    if (!client) return context.skip();
    const [stats] = await db
      .collection('stream_flights')
      .aggregate(runStatsPipeline('run-a'))
      .toArray();
    expect(stats).toMatchObject({
      flights: 100,
      latencyMin: 1,
      latencyMax: 100,
      latencyMean: 50.5,
    });
    const [p50, p95, p99] = stats?.latency as number[];
    // t-digest is approximate; on 100 evenly spread values it lands within one step.
    expect(Math.abs(p50! - 50)).toBeLessThanOrEqual(1);
    expect(Math.abs(p95! - 95)).toBeLessThanOrEqual(1);
    expect(Math.abs(p99! - 99)).toBeLessThanOrEqual(1);
    expect(
      (stats?.lastWrittenAt as Date).getTime() - (stats?.firstWrittenAt as Date).getTime(),
    ).toBe(99 * 10 + 99);
  });

  it('returns no row for a run that stored nothing (the report then has no timing)', async (context) => {
    if (!client) return context.skip();
    const rows = await db
      .collection('stream_flights')
      .aggregate(runStatsPipeline('run-none'))
      .toArray();
    expect(rows).toEqual([]);
  });
});
