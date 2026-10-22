import { StreamStatusResponseSchema } from '@flight-delay/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { deriveMetrics } from '../../src/stream/status/metrics.js';
import type { StreamMetrics } from '../../src/stream/status/queries.js';
import type { KafkaProbe, KafkaSnapshot } from '../../src/stream/status/kafka-probe.js';
import { createStreamStatus } from '../../src/stream/status/service.js';
import type { Heartbeat } from '../../src/stream/status/state.js';
import { fixedKafka, kafkaDown, kafkaUp } from '../helpers/kafka.js';

const MODEL = 'lightgbm-a';

function metrics(overrides: Partial<StreamMetrics> = {}): StreamMetrics {
  const counts = deriveMetrics({ tp: 20, fp: 30, fn: 10, tn: 240 });
  return {
    stored: { flights: 310, scored: 309, refused: 1, unscored: 0 },
    totals: {
      groups: [{ modelVersion: MODEL, threshold: 0.2, ...counts, scored: 309, noOutcome: 9 }],
    },
    window: {
      size: 2000,
      n: 300,
      windowStart: '2015-12-30',
      windowEnd: '2015-12-31',
      writtenFrom: '2026-10-22T10:00:00.000Z',
      writtenTo: '2026-10-22T10:00:05.000Z',
      departureHours: { min: 13, max: 23 },
      groups: [{ modelVersion: MODEL, threshold: 0.2, ...counts, rocAuc: 0.61 }],
    },
    ...overrides,
  };
}

const running = (): Heartbeat => ({
  status: 'running',
  lastSeenAt: new Date(),
  instanceId: 'host-1',
  throughput: 512,
});

const app = (options: Parameters<typeof createApp>[0]) =>
  createApp({
    pingMongo: async () => true,
    model: null,
    loadStreamHeartbeat: async () => running(),
    ...options,
  });

describe('GET /api/stream/status', () => {
  it('reports live metrics with their sample sizes, model and window order', async () => {
    const response = await request(
      app({ kafkaProbe: kafkaUp, loadStreamMetrics: async () => metrics() }),
    ).get('/api/stream/status');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = StreamStatusResponseSchema.parse(response.body);
    expect(body).toMatchObject({
      state: 'live',
      reason: null,
      source: 'replay of Dec 2015 flights',
      consumer: {
        fresh: true,
        throughput: 512,
        heartbeatIntervalSeconds: 2,
        staleAfterSeconds: 10,
      },
      kafka: { reachable: true, lag: { total: 0 } },
      window: {
        orderedBy: 'firstWrittenAt',
        windowStart: '2015-12-30',
        windowEnd: '2015-12-31',
        mixedModelVersions: false,
      },
      totals: { n: 300, rocAuc: null, mixedModelVersions: false },
    });
    expect(body.window?.order).toContain('not flight date');
    expect(body.window?.groups[0]).toMatchObject({
      modelVersion: MODEL,
      threshold: 0.2,
      servedModel: false,
      n: 300,
      lowSample: false,
      precision: 0.4,
      recall: 20 / 30,
      accuracy: { value: 260 / 300, majorityBaseline: 0.9 },
      rocAuc: 0.61,
    });
  });

  it('is 200 degraded with lag null and a reason when Kafka is unreachable', async () => {
    const response = await request(
      app({ kafkaProbe: kafkaDown, loadStreamMetrics: async () => metrics() }),
    ).get('/api/stream/status');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      state: 'degraded',
      kafka: { reachable: false, lag: null, dlqMessages: null },
    });
    expect(response.body.reason).toContain('Kafka unreachable');
    expect(response.body.kafka.reason).toContain('timed out');
    // MongoDB metrics are still reported.
    expect(response.body.stored.flights).toBe(310);
  });

  it('is 200 degraded, not 500, when MongoDB metrics fail', async () => {
    const response = await request(
      app({
        kafkaProbe: kafkaUp,
        loadStreamMetrics: async () => {
          throw new Error('connection refused');
        },
      }),
    ).get('/api/stream/status');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      state: 'degraded',
      // The driver's message (hosts, ports) stays in the log; the response gets a fixed wording.
      metricsReason: 'MongoDB query failed (Error)',
      stored: null,
      window: null,
      totals: null,
    });
    expect(response.body.reason).toContain('MongoDB');
  });

  it('flags a window that mixes model versions', async () => {
    const base = metrics();
    const groups = [
      base.window.groups[0]!,
      { ...base.window.groups[0]!, modelVersion: 'lightgbm-b', threshold: 0.25 },
    ];
    const response = await request(
      app({
        kafkaProbe: kafkaUp,
        loadStreamMetrics: async () => ({ ...base, window: { ...base.window, groups } }),
      }),
    ).get('/api/stream/status');

    expect(response.body.window.mixedModelVersions).toBe(true);
    expect(
      response.body.window.groups.map((g: { modelVersion: string; threshold: number }) => [
        g.modelVersion,
        g.threshold,
      ]),
    ).toEqual([
      [MODEL, 0.2],
      ['lightgbm-b', 0.25],
    ]);
  });
});

describe('createStreamStatus', () => {
  it('never hangs: MongoDB metrics that never answer become degraded after the timeout', async () => {
    const status = createStreamStatus({
      loadMetrics: () => new Promise<StreamMetrics>(() => undefined),
      loadHeartbeat: async () => running(),
      kafka: kafkaUp,
      groupId: 'g',
      servedModel: { modelVersion: MODEL, threshold: 0.2 },
      metricsTimeoutMs: 50,
    });
    const started = Date.now();
    const body = await status.get();
    expect(Date.now() - started).toBeLessThan(500);
    expect(body.state).toBe('degraded');
    expect(body.metricsReason).toContain('timed out after 50 ms');
  });

  it('marks the group of the served model', async () => {
    const status = createStreamStatus({
      loadMetrics: async () => metrics(),
      loadHeartbeat: async () => running(),
      kafka: kafkaUp,
      groupId: 'g',
      servedModel: { modelVersion: MODEL, threshold: 0.2 },
    });
    const body = await status.get();
    expect(body.servedModelVersion).toBe(MODEL);
    expect(body.servedThreshold).toBe(0.2);
    expect(body.window?.groups[0]?.servedModel).toBe(true);
    expect(body.totals?.groups[0]?.servedModel).toBe(true);
  });

  it('reads the heartbeat on every request while totals stay cached', async () => {
    let loads = 0;
    let beats = 0;
    const status = createStreamStatus({
      loadMetrics: async () => {
        loads += 1;
        return metrics();
      },
      loadHeartbeat: async () => {
        beats += 1;
        return running();
      },
      kafka: kafkaUp,
      groupId: 'g',
      servedModel: null,
      metricsCacheMs: 60_000,
    });
    await status.get();
    await status.get();
    expect(loads).toBe(1);
    expect(beats).toBe(2);
  });

  it('does not count one model under another threshold as served, and flags the mix', async () => {
    const base = metrics();
    const status = createStreamStatus({
      loadMetrics: async () => ({
        ...base,
        totals: {
          groups: [base.totals.groups[0]!, { ...base.totals.groups[0]!, threshold: 0.3 }],
        },
      }),
      loadHeartbeat: async () => running(),
      kafka: kafkaUp,
      groupId: 'g',
      servedModel: { modelVersion: MODEL, threshold: 0.2 },
    });
    const body = await status.get();
    expect(body.totals?.mixedModelVersions).toBe(true);
    expect(body.totals?.groups.map((g) => g.servedModel)).toEqual([true, false]);
  });

  it('degrades instead of answering 500 when the data breaks the contract', async () => {
    const status = createStreamStatus({
      loadMetrics: async () =>
        metrics({ stored: { flights: -1, scored: 0, refused: 0, unscored: 0 } }),
      loadHeartbeat: async () => running(),
      kafka: kafkaUp,
      groupId: 'g',
      servedModel: null,
    });
    const body = await status.get();
    expect(body).toMatchObject({ state: 'degraded', stored: null, window: null, totals: null });
  });

  it('calls a stall only after lag has stayed above 0 for the stall window across reads', async () => {
    let clock = Date.parse('2026-10-22T18:40:00Z');
    const lagging = fixedKafka({
      reachable: true,
      reason: null,
      lag: { total: 9_000, partitions: [{ partition: 0, committed: 0, end: 9_000, lag: 9_000 }] },
      dlqMessages: 0,
    });
    const status = createStreamStatus({
      loadMetrics: async () => metrics(),
      // Fresh heartbeat; last batch long ago (an idle consumer that just got new messages).
      loadHeartbeat: async () => ({
        ...running(),
        lastSeenAt: new Date(clock - 1_000),
        throughput: 0,
        lastBatchAt: new Date(clock - 120_000),
      }),
      kafka: lagging,
      groupId: 'g',
      servedModel: null,
      now: () => new Date(clock),
    });
    expect((await status.get()).state).toBe('live');
    clock += 10_000;
    expect((await status.get()).state).toBe('live');
    clock += 6_000;
    const stalled = await status.get();
    expect(stalled.state).toBe('degraded');
    expect(stalled.reason).toContain('not making progress');
    expect(stalled.consumer.fresh).toBe(true);
    expect(stalled.consumer.lastBatchAgeSeconds).toBe(120);
  });

  it('restarts the stall window after a read with no lag or with Kafka unreachable', async () => {
    let clock = Date.parse('2026-10-22T18:40:00Z');
    const lagging: KafkaSnapshot = {
      reachable: true,
      reason: null,
      lag: { total: 9_000, partitions: [{ partition: 0, committed: 0, end: 9_000, lag: 9_000 }] },
      dlqMessages: 0,
    };
    const drained: KafkaSnapshot = {
      ...lagging,
      lag: { total: 0, partitions: [{ partition: 0, committed: 9_000, end: 9_000, lag: 0 }] },
    };
    const unreachable: KafkaSnapshot = {
      reachable: false,
      reason: 'Kafka unreachable',
      lag: null,
      dlqMessages: null,
    };
    let snapshot: KafkaSnapshot = lagging;
    const probe: KafkaProbe = {
      read: async () => snapshot,
      lastKnown: () => snapshot,
      close: async () => {},
    };
    const status = createStreamStatus({
      loadMetrics: async () => metrics(),
      loadHeartbeat: async () => ({
        ...running(),
        lastSeenAt: new Date(clock - 1_000),
        throughput: 0,
        lastBatchAt: new Date(clock - 120_000),
      }),
      kafka: probe,
      groupId: 'g',
      servedModel: null,
      now: () => new Date(clock),
    });
    for (const reset of [drained, unreachable]) {
      snapshot = drained;
      await status.get();
      snapshot = lagging;
      expect((await status.get()).state).toBe('live');
      clock += 10_000;
      snapshot = reset;
      await status.get();
      clock += 1_000;
      snapshot = lagging;
      // 11 s since lag was first seen, but the window restarted at the reset read.
      expect((await status.get()).state).toBe('live');
      clock += 10_000;
      expect((await status.get()).state).toBe('live');
      clock += 6_000;
      expect((await status.get()).state).toBe('degraded');
    }
  });
});
