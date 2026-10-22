import { z } from 'zod';

/** GET /api/stream/status (PROJECT_OVERVIEW §15.8). Every rate carries its sample size `n`. */

export const STREAM_SOURCE = 'replay of Dec 2015 flights';
export const WINDOW_ORDER =
  'replay order: when the consumer first stored each flight (firstWrittenAt, then _id), not flight ' +
  'date. The producer replays the source file in its own order (date, then scheduled departure), ' +
  'so after a full replay the window is the latest-departing flights of the last replayed day(s): ' +
  'a slice of the schedule, not a sample of the month (see windowStart/windowEnd, departureHours).';
export const TOTALS_SCOPE =
  'every flight stored in stream_flights, each once however often it was delivered';
export const POSITIVE_CLASS = 'delayed: arrival 15 or more minutes late';
export const THRESHOLD_SOURCE =
  'chosen at training (max F1 on September validation predictions of the Jan-Aug fit), then frozen ' +
  'for the Jan-Sep refit; never tuned on stream results';

const count = z.number().int().nonnegative();

/** One (modelVersion, threshold) pair: the metrics of the predictions that model made. */
export const StreamMetricGroupSchema = z.object({
  modelVersion: z.string(),
  threshold: z.number(),
  /** True when this modelVersion and threshold are the ones the API serves now. */
  servedModel: z.boolean(),
  /** Judged flights: scored, with an arrival outcome. */
  n: count,
  lowSample: z.boolean(),
  tp: count,
  fp: count,
  fn: count,
  tn: count,
  /** Null when a denominator is zero, never 0 or NaN. */
  precision: z.number().nullable(),
  recall: z.number().nullable(),
  f1: z.number().nullable(),
  /** Share of the n flights that were delayed. */
  baseRate: z.number().nullable(),
  /** Accuracy only beside the same-sample majority-class baseline, or not at all. */
  accuracy: z.object({ value: z.number(), majorityBaseline: z.number() }).nullable(),
});

export const StreamWindowGroupSchema = StreamMetricGroupSchema.extend({
  /** From the stored probabilities of this window; null when the window holds one class. */
  rocAuc: z.number().nullable(),
});

export const StreamTotalsGroupSchema = StreamMetricGroupSchema.extend({
  /** Flights this model scored, including cancelled or diverted ones (no verdict). */
  scored: count,
  noOutcome: count,
});

const PartitionLagSchema = z.object({
  partition: z.number().int().nonnegative(),
  committed: z.number().int().nonnegative().nullable(),
  end: count,
  lag: count,
});

export const StreamStatusResponseSchema = z.object({
  generatedAt: z.string(),
  state: z.enum(['live', 'idle', 'degraded']),
  reason: z.string().nullable(),
  source: z.literal(STREAM_SOURCE),
  positiveClass: z.literal(POSITIVE_CLASS),
  thresholdSource: z.literal(THRESHOLD_SOURCE),
  servedModelVersion: z.string().nullable(),
  servedThreshold: z.number().nullable(),
  lowSampleBelow: z.number().int().positive(),
  consumer: z.object({
    groupId: z.string(),
    instanceId: z.string().nullable(),
    status: z.enum(['running', 'stopped', 'failed']).nullable(),
    lastSeenAt: z.string().nullable(),
    ageSeconds: z.number().nullable(),
    /** Liveness: lastSeenAt is at most staleAfterSeconds old. */
    fresh: z.boolean(),
    /** Messages per second over the newest heartbeat's interval; null unless fresh. */
    throughput: z.number().nullable(),
    /** Seconds since the consumer last finished a batch (progress, not liveness); null if unknown. */
    lastBatchAgeSeconds: z.number().nullable(),
    error: z.string().nullable(),
    heartbeatIntervalSeconds: z.number().positive(),
    staleAfterSeconds: z.number().positive(),
  }),
  kafka: z.object({
    reachable: z.boolean(),
    reason: z.string().nullable(),
    lag: z.object({ total: count, partitions: z.array(PartitionLagSchema) }).nullable(),
    /** Messages retained on the DLQ topic (end minus start offsets); null if unreadable. */
    dlqMessages: count.nullable(),
  }),
  /** Why stored/window/totals are null (MongoDB unavailable). */
  metricsReason: z.string().nullable(),
  stored: z.object({ flights: count, scored: count, refused: count, unscored: count }).nullable(),
  window: z
    .object({
      size: count,
      orderedBy: z.literal('firstWrittenAt'),
      order: z.literal(WINDOW_ORDER),
      n: count,
      /** Earliest and latest flight dates (YYYY-MM-DD) in the window. */
      windowStart: z.string().nullable(),
      windowEnd: z.string().nullable(),
      writtenFrom: z.string().nullable(),
      writtenTo: z.string().nullable(),
      /** Earliest and latest scheduled departure hour (0-23) in the window. */
      departureHours: z
        .object({ min: z.number().int().min(0).max(23), max: z.number().int().min(0).max(23) })
        .nullable(),
      /** More than one (modelVersion, threshold) pair among the groups. */
      mixedModelVersions: z.boolean(),
      groups: z.array(StreamWindowGroupSchema),
    })
    .nullable(),
  totals: z
    .object({
      scope: z.literal(TOTALS_SCOPE),
      n: count,
      /** More than one (modelVersion, threshold) pair among the groups. */
      mixedModelVersions: z.boolean(),
      /** Whole-collection ROC-AUC is not returned: see rocAucReason. */
      rocAuc: z.null(),
      rocAucReason: z.string(),
      groups: z.array(StreamTotalsGroupSchema),
    })
    .nullable(),
});

export type StreamMetricGroup = z.infer<typeof StreamMetricGroupSchema>;
export type StreamWindowGroup = z.infer<typeof StreamWindowGroupSchema>;
export type StreamTotalsGroup = z.infer<typeof StreamTotalsGroupSchema>;
export type StreamStatusResponse = z.infer<typeof StreamStatusResponseSchema>;
