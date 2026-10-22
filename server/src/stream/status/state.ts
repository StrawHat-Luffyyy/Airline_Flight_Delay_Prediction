/**
 * Consumer liveness and the overall stream state for GET /api/stream/status. Liveness is the age of
 * the newest heartbeat's lastSeenAt: a hard-killed consumer never writes "stopped", so its stored
 * status alone would read "running" forever.
 */

/** How often a running consumer rewrites its heartbeat (stream_stats, kind "consumer"). */
export const HEARTBEAT_INTERVAL_MS = 2_000;
/** A heartbeat older than this is stale: at least three missed beats. */
export const STALE_AFTER_MS = 10_000;
/**
 * TTL on heartbeat lastSeenAt. MongoDB's TTL monitor deletes only about once a minute, so status
 * reads never rely on old heartbeats being gone: they take the newest heartbeat per group.
 */
export const HEARTBEAT_TTL_SECONDS = 6 * 60 * 60;
/**
 * A fresh consumer with messages waiting that has stored nothing for this long is stalled: alive,
 * but not progressing (measured: 32 s after a broker restart, run G). A batch of 500 normally takes
 * well under a second, so this leaves room for start-up and a rebalance.
 */
export const STALL_AFTER_MS = 15_000;

export type ConsumerStatus = 'running' | 'stopped' | 'failed';

/** The fields of the newest heartbeat document that status needs. */
export interface Heartbeat {
  status: ConsumerStatus;
  lastSeenAt: Date;
  instanceId: string;
  /** Messages per second over the heartbeat's last interval. */
  throughput: number;
  /** When the consumer last finished a batch (its start until then); absent in older heartbeats. */
  lastBatchAt?: Date;
  error?: string;
}

export interface ConsumerView {
  instanceId: string | null;
  status: ConsumerStatus | null;
  lastSeenAt: string | null;
  ageSeconds: number | null;
  fresh: boolean;
  /** Only reported while the heartbeat is fresh; a stale rate describes the past. */
  throughput: number | null;
  /** Seconds since the consumer last finished a batch; null when unknown or not fresh. */
  lastBatchAgeSeconds: number | null;
  error: string | null;
}

export function describeConsumer(heartbeat: Heartbeat | null, now: Date): ConsumerView {
  if (heartbeat === null) {
    return {
      instanceId: null,
      status: null,
      lastSeenAt: null,
      ageSeconds: null,
      fresh: false,
      throughput: null,
      lastBatchAgeSeconds: null,
      error: null,
    };
  }
  const ageMs = Math.max(0, now.getTime() - heartbeat.lastSeenAt.getTime());
  const fresh = ageMs <= STALE_AFTER_MS;
  return {
    instanceId: heartbeat.instanceId,
    status: heartbeat.status,
    lastSeenAt: heartbeat.lastSeenAt.toISOString(),
    ageSeconds: Math.round(ageMs / 1000),
    fresh,
    throughput: fresh ? heartbeat.throughput : null,
    lastBatchAgeSeconds:
      fresh && heartbeat.lastBatchAt !== undefined
        ? Math.round(Math.max(0, now.getTime() - heartbeat.lastBatchAt.getTime()) / 1000)
        : null,
    error: heartbeat.error ?? null,
  };
}

export type StreamState = 'live' | 'idle' | 'degraded';

export interface StateInput {
  /** Why the MongoDB metrics could not be read; null when they were. */
  metricsError: string | null;
  /**
   * `lag.total`: messages behind; `lag.waitingSeconds`: how long lag has been above 0 without a
   * break, as seen by this API (null = not known yet). Without both, a stall is never called.
   */
  kafka: {
    reachable: boolean;
    reason: string | null;
    lag?: { total: number; waitingSeconds: number | null } | null;
  };
  consumer: ConsumerView;
}

/** Worst first: MongoDB, then Kafka, then the consumer. */
export function decideState({ metricsError, kafka, consumer }: StateInput): {
  state: StreamState;
  reason: string | null;
} {
  if (metricsError !== null) {
    return { state: 'degraded', reason: `MongoDB metrics unavailable: ${metricsError}` };
  }
  if (!kafka.reachable) {
    return { state: 'degraded', reason: `Kafka unreachable: ${kafka.reason ?? 'unknown error'}` };
  }
  if (consumer.status === null) {
    return { state: 'idle', reason: 'No consumer heartbeat: start npm run stream:consume' };
  }
  if (consumer.status === 'stopped') {
    return { state: 'idle', reason: `Consumer stopped cleanly at ${consumer.lastSeenAt}` };
  }
  // Freshness first: a stale "failed" or "running" heartbeat means the process is gone, whatever it
  // last reported.
  if (!consumer.fresh) {
    return {
      state: 'degraded',
      reason: `Consumer heartbeat is ${consumer.ageSeconds} s old without a clean stop (crashed or killed)`,
    };
  }
  if (consumer.status === 'failed') {
    return {
      state: 'degraded',
      reason: `Consumer batches are failing: ${consumer.error ?? 'unknown error'}`,
    };
  }
  // Alive is not the same as progressing: a fresh heartbeat, messages waiting for STALL_AFTER_MS
  // and no batch for as long (e.g. still rejoining the group after a broker restart). Both
  // windows are needed: an idle consumer's last batch is old the moment new messages arrive.
  // lastBatchAgeSeconds is rounded to whole seconds, so the batch side trips from 15.5 s.
  const waiting = kafka.lag?.total ?? 0;
  const waitingSeconds = kafka.lag?.waitingSeconds ?? null;
  if (
    waiting > 0 &&
    waitingSeconds !== null &&
    waitingSeconds * 1000 > STALL_AFTER_MS &&
    consumer.lastBatchAgeSeconds !== null &&
    consumer.lastBatchAgeSeconds * 1000 > STALL_AFTER_MS
  ) {
    return {
      state: 'degraded',
      reason: `Consumer is alive but not making progress: no batch for ${consumer.lastBatchAgeSeconds} s with ${waiting} messages waiting`,
    };
  }
  return { state: 'live', reason: null };
}
