import { describe, expect, it } from 'vitest';
import { computeLag } from '../../src/stream/status/kafka-probe.js';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TTL_SECONDS,
  STALE_AFTER_MS,
  describeConsumer,
  decideState,
} from '../../src/stream/status/state.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('heartbeat timing', () => {
  it('beats at least three times per stale threshold, and expires old beats after hours', () => {
    expect(HEARTBEAT_INTERVAL_MS * 3).toBeLessThanOrEqual(STALE_AFTER_MS);
    expect(HEARTBEAT_TTL_SECONDS).toBeGreaterThanOrEqual(60 * 60);
    expect(HEARTBEAT_TTL_SECONDS * 1000).toBeGreaterThan(STALE_AFTER_MS);
  });
});

describe('describeConsumer', () => {
  it('judges liveness by lastSeenAt age, not by the stored status', () => {
    const fresh = describeConsumer(
      { status: 'running', lastSeenAt: ago(3_000), instanceId: 'h-1', throughput: 420 },
      NOW,
    );
    expect(fresh).toMatchObject({ fresh: true, ageSeconds: 3, throughput: 420 });

    // A hard-killed process leaves status "running" behind.
    const killed = describeConsumer(
      {
        status: 'running',
        lastSeenAt: ago(STALE_AFTER_MS + 1),
        instanceId: 'h-1',
        throughput: 420,
      },
      NOW,
    );
    expect(killed).toMatchObject({ fresh: false, status: 'running', throughput: null });
  });

  it('reports no consumer when there is no heartbeat', () => {
    expect(describeConsumer(null, NOW)).toMatchObject({
      fresh: false,
      status: null,
      lastSeenAt: null,
      ageSeconds: null,
      throughput: null,
    });
  });
});

describe('decideState', () => {
  const up = { reachable: true, reason: null };
  const live = describeConsumer(
    { status: 'running', lastSeenAt: ago(1_000), instanceId: 'h-1', throughput: 10 },
    NOW,
  );

  it('is live with a fresh running consumer and Kafka reachable', () => {
    expect(decideState({ metricsError: null, kafka: up, consumer: live })).toEqual({
      state: 'live',
      reason: null,
    });
  });

  it('is degraded with a reason when Kafka is unreachable', () => {
    const result = decideState({
      metricsError: null,
      kafka: { reachable: false, reason: 'timed out after 1000 ms' },
      consumer: live,
    });
    expect(result.state).toBe('degraded');
    expect(result.reason).toContain('Kafka unreachable');
  });

  it('is degraded when MongoDB metrics could not be read', () => {
    const result = decideState({ metricsError: 'MongoDB timed out', kafka: up, consumer: live });
    expect(result.state).toBe('degraded');
    expect(result.reason).toContain('MongoDB');
  });

  it('is degraded when the newest heartbeat went stale without a clean stop', () => {
    const consumer = describeConsumer(
      { status: 'running', lastSeenAt: ago(60_000), instanceId: 'h-1', throughput: 0 },
      NOW,
    );
    const result = decideState({ metricsError: null, kafka: up, consumer });
    expect(result.state).toBe('degraded');
    expect(result.reason).toContain('60 s');
  });

  it('is degraded when the consumer reports failing batches', () => {
    const consumer = describeConsumer(
      {
        status: 'failed',
        lastSeenAt: ago(1_000),
        instanceId: 'h-1',
        throughput: 0,
        error: 'connection refused',
      },
      NOW,
    );
    const result = decideState({ metricsError: null, kafka: up, consumer });
    expect(result.state).toBe('degraded');
    expect(result.reason).toContain('connection refused');
  });

  it('treats a stale "failed" heartbeat as a dead consumer, not a failing one', () => {
    const consumer = describeConsumer(
      {
        status: 'failed',
        lastSeenAt: ago(3_600_000),
        instanceId: 'h-1',
        throughput: 0,
        error: 'x',
      },
      NOW,
    );
    const result = decideState({ metricsError: null, kafka: up, consumer });
    expect(result.state).toBe('degraded');
    expect(result.reason).toContain('without a clean stop');
  });

  it('is idle after a clean stop, or when no consumer has run', () => {
    const stopped = describeConsumer(
      { status: 'stopped', lastSeenAt: ago(120_000), instanceId: 'h-1', throughput: 0 },
      NOW,
    );
    expect(decideState({ metricsError: null, kafka: up, consumer: stopped }).state).toBe('idle');
    const none = describeConsumer(null, NOW);
    expect(decideState({ metricsError: null, kafka: up, consumer: none })).toMatchObject({
      state: 'idle',
    });
  });
});

describe('computeLag', () => {
  it('subtracts the committed offset from the end offset per partition', () => {
    const lag = computeLag(
      [
        { partition: 0, offset: '90' },
        { partition: 1, offset: '-1' },
        { partition: 2, offset: '5' },
      ],
      [
        { partition: 0, high: '100', low: '0' },
        { partition: 1, high: '40', low: '10' },
        { partition: 2, high: '50', low: '20' },
      ],
    );
    expect(lag.partitions).toEqual([
      // Nothing committed yet: the whole retained partition is unread.
      { partition: 0, committed: 90, end: 100, lag: 10 },
      { partition: 1, committed: null, end: 40, lag: 30 },
      // Committed below the retained start: only the retained messages can still be read.
      { partition: 2, committed: 5, end: 50, lag: 30 },
    ]);
    expect(lag.total).toBe(70);
  });
});
