/**
 * Builds the GET /api/stream/status body. It never throws and never waits long: MongoDB metrics, the
 * heartbeat and the Kafka probe each run under their own timeout, and a failure of any becomes a
 * degraded state with a reason (HTTP 200), never a 500.
 */
import {
  POSITIVE_CLASS,
  STREAM_SOURCE,
  StreamStatusResponseSchema,
  THRESHOLD_SOURCE,
  TOTALS_SCOPE,
  WINDOW_ORDER,
  type StreamMetricGroup,
  type StreamStatusResponse,
} from '@flight-delay/shared';
import type { Logger } from 'pino';
import { TtlCache } from '../../cache.js';
import { TimeoutError, withTimeout, type KafkaProbe } from './kafka-probe.js';
import { LOW_SAMPLE_BELOW, type DerivedMetrics } from './metrics.js';
import type { ModelKey, StreamMetrics } from './queries.js';
import {
  HEARTBEAT_INTERVAL_MS,
  STALE_AFTER_MS,
  decideState,
  describeConsumer,
  type Heartbeat,
} from './state.js';

/** MongoDB part of one status read (each query also has its own maxTimeMS). */
export const METRICS_TIMEOUT_MS = 3_000;
/** Totals and window are reused this long, so a polling dashboard does not re-run the counts. */
export const METRICS_CACHE_MS = 3_000;

export const TOTALS_ROC_AUC_REASON =
  'Not computed for the whole collection: it needs every stored probability in memory. ' +
  'window.groups[].rocAuc is computed from at most window.size stored probabilities.';

export interface StreamStatusOptions {
  /** Totals and window (cached for metricsCacheMs). */
  loadMetrics: () => Promise<StreamMetrics>;
  /** The newest consumer heartbeat; read on every request, never cached. */
  loadHeartbeat: () => Promise<Heartbeat | null>;
  kafka: KafkaProbe;
  groupId: string;
  /** The model the API serves now; null when none is loaded. */
  servedModel: ModelKey | null;
  logger?: Pick<Logger, 'warn'>;
  metricsTimeoutMs?: number;
  metricsCacheMs?: number;
  now?: () => Date;
}

export interface StreamStatus {
  get(): Promise<StreamStatusResponse>;
}

/** Fixed wording for the public response; the driver's own message (hosts, ports) is only logged. */
function mongoReason(error: unknown): string {
  if (error instanceof TimeoutError) return error.message;
  const name = error instanceof Error ? error.name : 'Error';
  return `MongoDB query failed (${name})`;
}

export function createStreamStatus(options: StreamStatusOptions): StreamStatus {
  const { loadMetrics, loadHeartbeat, kafka, groupId, servedModel, logger } = options;
  const metricsTimeoutMs = options.metricsTimeoutMs ?? METRICS_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const cache = new TtlCache<StreamMetrics>({ ttlMs: options.metricsCacheMs ?? METRICS_CACHE_MS });
  /** When this API first saw lag above 0 in the current unbroken run of readings (epoch ms). */
  let lagSince: number | null = null;
  /** Start time of the newest read applied to lagSince, so an overlapping older read is ignored. */
  let lagReadAt = -Infinity;

  const group = <T extends ModelKey & DerivedMetrics>(metrics: T): T & StreamMetricGroup => ({
    ...metrics,
    servedModel:
      servedModel !== null &&
      metrics.modelVersion === servedModel.modelVersion &&
      metrics.threshold === servedModel.threshold,
  });
  /** More than one (modelVersion, threshold): the predictions come from different models. */
  const mixed = (groups: readonly ModelKey[]) =>
    new Set(groups.map((g) => `${g.modelVersion}|${g.threshold}`)).size > 1;
  const settle = <T>(promise: Promise<T>, what: string) =>
    withTimeout(promise, metricsTimeoutMs, what).then(
      (value) => ({ value, error: null }),
      (error: unknown) => {
        logger?.warn({ err: error }, `stream status: ${what} unavailable`);
        return { value: null, error: mongoReason(error) };
      },
    );

  return {
    async get() {
      const readAt = now().getTime();
      const [metricsResult, heartbeatResult, snapshot] = await Promise.all([
        settle(cache.getOrLoad('metrics', loadMetrics), 'MongoDB metrics'),
        settle(loadHeartbeat(), 'MongoDB heartbeat'),
        kafka.read(),
      ]);
      const at = now();
      // Track how long messages have been waiting. A reading with lag 0 resets it; an unreachable
      // Kafka leaves it unknown, so the next positive reading starts a new window. Overlapping
      // requests can finish out of order; a read that started before the last applied one is
      // stale and must not reset the window. The window is per API process.
      if (readAt >= lagReadAt) {
        lagReadAt = readAt;
        if (snapshot.lag === null || snapshot.lag.total === 0) lagSince = null;
        else lagSince ??= readAt;
      }
      const lagWaitingSeconds =
        lagSince === null ? null : Math.max(0, at.getTime() - lagSince) / 1000;
      const metrics = metricsResult.value;
      const metricsError = metricsResult.error ?? heartbeatResult.error;
      const consumer = describeConsumer(heartbeatResult.value, at);
      const { state, reason } = decideState({
        metricsError,
        kafka: {
          reachable: snapshot.reachable,
          reason: snapshot.reason,
          lag:
            snapshot.lag === null
              ? null
              : { total: snapshot.lag.total, waitingSeconds: lagWaitingSeconds },
        },
        consumer,
      });

      const body: StreamStatusResponse = {
        generatedAt: at.toISOString(),
        state,
        reason,
        source: STREAM_SOURCE,
        positiveClass: POSITIVE_CLASS,
        thresholdSource: THRESHOLD_SOURCE,
        servedModelVersion: servedModel?.modelVersion ?? null,
        servedThreshold: servedModel?.threshold ?? null,
        lowSampleBelow: LOW_SAMPLE_BELOW,
        consumer: {
          groupId,
          ...consumer,
          heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_MS / 1000,
          staleAfterSeconds: STALE_AFTER_MS / 1000,
        },
        kafka: {
          reachable: snapshot.reachable,
          reason: snapshot.reason,
          lag: snapshot.lag,
          dlqMessages: snapshot.dlqMessages,
        },
        metricsReason: metricsResult.error,
        stored: metrics?.stored ?? null,
        window:
          metrics === null
            ? null
            : {
                ...metrics.window,
                orderedBy: 'firstWrittenAt',
                order: WINDOW_ORDER,
                mixedModelVersions: mixed(metrics.window.groups),
                groups: metrics.window.groups.map(group),
              },
        totals:
          metrics === null
            ? null
            : {
                scope: TOTALS_SCOPE,
                n: metrics.totals.groups.reduce((sum, g) => sum + g.n, 0),
                mixedModelVersions: mixed(metrics.totals.groups),
                rocAuc: null,
                rocAucReason: TOTALS_ROC_AUC_REASON,
                groups: metrics.totals.groups.map(group),
              },
      };
      // The contract is checked on the way out, as the other routes do. Data that breaks it (e.g. a
      // malformed offset) degrades the response instead of turning it into a 500.
      const parsed = StreamStatusResponseSchema.safeParse(body);
      if (parsed.success) return parsed.data;
      logger?.warn({ issues: parsed.error.issues }, 'stream status: response failed validation');
      return StreamStatusResponseSchema.parse({
        ...body,
        state: 'degraded',
        reason: 'Status data failed validation (see API log)',
        kafka: { ...body.kafka, lag: null, dlqMessages: null },
        metricsReason: 'Status data failed validation',
        stored: null,
        window: null,
        totals: null,
      });
    },
  };
}
