import { flightKey, type FlightEvent } from '@flight-delay/shared';
import { MongoClient, type Db, type Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScoreResult } from '../../src/stream/score.js';
import {
  confusionFilters,
  loadStreamMetrics,
  noPredictionPipeline,
  rollingWindowPipeline,
} from '../../src/stream/status/queries.js';
import { ensureStreamIndexes, streamFlights, upsertEvents } from '../../src/stream/store.js';

// Needs a reachable MongoDB (MONGODB_URI from vitest.config.ts); skipped when there is none.
const TEST_DB = 'flight_delay_stream_status_test';
const MODEL = 'lightgbm-test';
const THRESHOLD = 0.2;
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

interface Spec {
  n: number;
  date: string;
  /** Predicted probability; the label is "delayed" at or above THRESHOLD. */
  p: number;
  /** Actual outcome; null = cancelled (no arrival outcome). */
  delayed: boolean | null;
}

function event({ n, date, delayed }: Spec): FlightEvent {
  const pre = {
    date,
    airline: 'AA',
    flightNumber: n,
    origin: 'ORD',
    dest: 'LAX',
    schedDepMin: 600,
    schedDepHour: 10,
  };
  return {
    v: 1,
    key: flightKey(pre),
    runId: 'run-1',
    producedAt: 1_700_000_000_000,
    pre,
    outcome: {
      depDelay: delayed === null ? null : 0,
      arrDelay: delayed === null ? null : delayed ? 30 : 0,
      isDelayed: delayed,
      cancelled: delayed === null,
      diverted: false,
    },
  };
}

function score(spec: Spec): ScoreResult {
  const label = spec.p >= THRESHOLD ? 'delayed' : 'on-time';
  return {
    key: event(spec).key,
    prediction: { probability: spec.p, label, threshold: THRESHOLD, modelVersion: MODEL },
    scoreError: null,
    correct: spec.delayed === null ? null : (label === 'delayed') === spec.delayed,
  };
}

async function store(specs: Spec[], writtenAt: Date): Promise<void> {
  await upsertEvents(
    streamFlights(db),
    specs.map(event),
    writtenAt,
    new Map(specs.map((spec) => [event(spec).key, score(spec)])),
  );
}

// Written first (older): two TPs and a cancelled flight on Dec 1.
const early: Spec[] = [
  { n: 1, date: '2015-12-01', p: 0.9, delayed: true },
  { n: 2, date: '2015-12-01', p: 0.8, delayed: true },
  { n: 3, date: '2015-12-01', p: 0.7, delayed: null },
];
// Written last (newest): FP, FN, TN, TN across Dec 30 and Dec 31.
const late: Spec[] = [
  { n: 4, date: '2015-12-30', p: 0.6, delayed: false },
  { n: 5, date: '2015-12-31', p: 0.1, delayed: true },
  { n: 6, date: '2015-12-31', p: 0.05, delayed: false },
  { n: 7, date: '2015-12-31', p: 0.15, delayed: false },
  // Cancelled, written with the newest batch: scored, but never in the window or the verdicts.
  { n: 9, date: '2015-12-31', p: 0.5, delayed: null },
];

describe('loadStreamMetrics (MongoDB integration)', () => {
  it('computes whole-collection totals and a rolling window in replay order', async (context) => {
    if (!client) return context.skip();
    await store(early, new Date('2026-10-22T10:00:00Z'));
    await store(late, new Date('2026-10-22T10:00:05Z'));
    // One flight refused by the scorer.
    await upsertEvents(
      streamFlights(db),
      [event({ n: 8, date: '2015-12-31', p: 0, delayed: false })],
      new Date('2026-10-22T10:00:06Z'),
      new Map([
        [
          event({ n: 8, date: '2015-12-31', p: 0, delayed: false }).key,
          {
            key: event({ n: 8, date: '2015-12-31', p: 0, delayed: false }).key,
            prediction: null,
            scoreError: 'UNKNOWN_ROUTE',
            correct: null,
          },
        ],
      ]),
    );

    const metrics = await loadStreamMetrics(db, { windowSize: 4 });
    expect(metrics.stored).toEqual({ flights: 9, scored: 8, refused: 1, unscored: 0 });

    expect(metrics.totals.groups).toHaveLength(1);
    expect(metrics.totals.groups[0]).toMatchObject({
      modelVersion: MODEL,
      threshold: THRESHOLD,
      scored: 8,
      noOutcome: 2,
      tp: 2,
      fp: 1,
      fn: 1,
      tn: 2,
      n: 6,
    });

    // The window is the 4 newest judged flights by firstWrittenAt: the "late" batch.
    expect(metrics.window).toMatchObject({
      size: 4,
      n: 4,
      windowStart: '2015-12-30',
      windowEnd: '2015-12-31',
      departureHours: { min: 10, max: 10 },
    });
    expect(metrics.window.groups[0]).toMatchObject({ tp: 0, fp: 1, fn: 1, tn: 2, n: 4 });
    // Positive 0.1 vs negatives 0.6, 0.05, 0.15: beats one of three.
    expect(metrics.window.groups[0]!.rocAuc).toBeCloseTo(1 / 3, 12);
  });

  it('leaves n unchanged when the same flights are redelivered', async (context) => {
    if (!client) return context.skip();
    const before = await loadStreamMetrics(db, { windowSize: 4 });
    await store([...early, ...late], new Date('2026-10-22T11:00:00Z'));
    const after = await loadStreamMetrics(db, { windowSize: 4 });
    expect(after.stored).toEqual(before.stored);
    expect(after.totals.groups[0]!.n).toBe(before.totals.groups[0]!.n);
    expect(after.window.n).toBe(before.window.n);
    const deliveries = await streamFlights(db).findOne({ _id: event(early[0]!).key });
    expect(deliveries?.deliveries).toBe(2);
  });

  it('uses the stream_flights indexes, never a collection scan', async (context) => {
    if (!client) return context.skip();
    const stagesOf = (plan: Document) => JSON.stringify(plan).match(/"stage":"[A-Z_]+"/g) ?? [];

    const windowPlan = await streamFlights(db)
      .aggregate(rollingWindowPipeline(4))
      .explain('executionStats');
    expect(stagesOf(windowPlan)).toContain('"stage":"IXSCAN"');
    expect(stagesOf(windowPlan)).not.toContain('"stage":"COLLSCAN"');
    expect(stagesOf(windowPlan)).not.toContain('"stage":"SORT"');

    for (const [key, query] of [
      ['prediction.modelVersion', {}],
      ['prediction.threshold', { 'prediction.modelVersion': MODEL }],
    ] as const) {
      const plan = await db.command({
        explain: { distinct: 'stream_flights', key, query },
        verbosity: 'executionStats',
      });
      expect(stagesOf(plan)).toContain('"stage":"DISTINCT_SCAN"');
      expect(stagesOf(plan)).not.toContain('"stage":"FETCH"');
    }

    const filters = confusionFilters(MODEL, THRESHOLD);
    for (const filter of [filters.tp, filters.fp, filters.fn, filters.tn]) {
      const plan = await db.command({
        explain: { count: 'stream_flights', query: filter },
        verbosity: 'executionStats',
      });
      expect(stagesOf(plan)).toContain('"stage":"COUNT_SCAN"');
    }
  });

  it('splits flights without a prediction into refused and unscored in one consistent read', async (context) => {
    if (!client) return context.skip();
    // Regression: two separate counts raced a consumer inserting refused flights, so `refused`
    // exceeded `noPrediction`, `unscored` went negative and the response failed validation.
    const before = await loadStreamMetrics(db, { windowSize: 4 });
    const unscored = event({ n: 50, date: '2015-12-31', p: 0, delayed: false });
    await upsertEvents(streamFlights(db), [unscored], new Date('2026-10-22T12:00:00Z'));
    const after = await loadStreamMetrics(db, { windowSize: 4 });
    expect(after.stored).toEqual({
      ...before.stored,
      flights: before.stored.flights + 1,
      unscored: before.stored.unscored + 1,
    });
    expect(noPredictionPipeline()[0]).toEqual({ $match: { 'prediction.modelVersion': null } });
  });
});
