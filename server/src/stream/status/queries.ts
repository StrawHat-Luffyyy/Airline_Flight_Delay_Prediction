/**
 * MongoDB reads behind GET /api/stream/status. Every metric comes from stream_flights (one document
 * per flight, however often it was delivered), never from consumer counters or `deliveries`.
 *
 * - Whole collection: confusion-matrix and scored/refused counts, one COUNT_SCAN each on
 *   COUNTS_INDEX, per (modelVersion, threshold). The counts are separate reads, so while a consumer
 *   is writing they can be a few flights apart (e.g. `stored.flights` vs a group's `n`); with the
 *   consumer idle they are exact (checked by `npm run stream:verify-status`).
 * - Rolling window: the newest `windowSize` judged flights in REPLAY order (firstWrittenAt, then
 *   _id), read through WINDOW_INDEX with a LIMIT. It fetches windowSize documents plus any unjudged
 *   ones (cancelled, diverted, refused) interleaved with them.
 *
 * "Judged" has one meaning in both: a stored prediction and an arrival outcome. The window filters on
 * `correct != null`, which the scorer sets exactly then; the totals count label x isDelayed cells.
 */
import type { Db, Document, Filter } from 'mongodb';
import { WINDOW_INDEX, streamConsumers, streamFlights, type StreamFlightDoc } from '../store.js';
import { deriveMetrics, rocAuc, type DerivedMetrics, type ScoredPair } from './metrics.js';
import type { Heartbeat } from './state.js';

/** Bound on each MongoDB operation, so a slow server degrades the status instead of hanging it. */
export const QUERY_MAX_TIME_MS = 2_000;

/** Flights that have a verdict: scored, with an arrival outcome (not cancelled or diverted). */
const JUDGED: Filter<StreamFlightDoc> = { correct: { $ne: null } };

export function rollingWindowPipeline(windowSize: number): Document[] {
  const cell = (label: 'delayed' | 'on-time', delayed: boolean) => ({
    $sum: {
      $cond: [
        {
          $and: [{ $eq: ['$prediction.label', label] }, { $eq: ['$outcome.isDelayed', delayed] }],
        },
        1,
        0,
      ],
    },
  });
  return [
    { $match: JUDGED },
    { $sort: { ...WINDOW_INDEX } },
    { $limit: windowSize },
    {
      $group: {
        _id: { modelVersion: '$prediction.modelVersion', threshold: '$prediction.threshold' },
        tp: cell('delayed', true),
        fp: cell('delayed', false),
        fn: cell('on-time', true),
        tn: cell('on-time', false),
        windowStart: { $min: '$pre.date' },
        windowEnd: { $max: '$pre.date' },
        writtenFrom: { $min: '$firstWrittenAt' },
        writtenTo: { $max: '$firstWrittenAt' },
        depHourMin: { $min: '$pre.schedDepHour' },
        depHourMax: { $max: '$pre.schedDepHour' },
        // At most windowSize pairs: what ROC-AUC needs, in bounded memory.
        pairs: { $push: { p: '$prediction.probability', y: '$outcome.isDelayed' } },
      },
    },
    { $sort: { '_id.modelVersion': 1, '_id.threshold': 1 } },
  ];
}

/** Equality filters on the COUNTS_INDEX prefix, one per confusion cell plus no-outcome flights. */
export function confusionFilters(modelVersion: string, threshold: number) {
  const scored = { 'prediction.modelVersion': modelVersion, 'prediction.threshold': threshold };
  const cell = (
    label: 'delayed' | 'on-time',
    delayed: boolean | null,
  ): Filter<StreamFlightDoc> => ({
    ...scored,
    'prediction.label': label,
    'outcome.isDelayed': delayed,
  });
  return {
    tp: cell('delayed', true),
    fp: cell('delayed', false),
    fn: cell('on-time', true),
    tn: cell('on-time', false),
    noOutcomeDelayed: cell('delayed', null),
    noOutcomeOnTime: cell('on-time', null),
  };
}

/** No prediction stored: refused by the scorer (scoreError set) or not scored yet. */
export const NO_PREDICTION: Filter<StreamFlightDoc> = { 'prediction.modelVersion': null };
export const REFUSED: Filter<StreamFlightDoc> = {
  'prediction.modelVersion': null,
  scoreError: { $type: 'string' },
};

/**
 * Flights without a prediction, and how many of those were refused, in one read. Two separate
 * counts raced a consumer inserting refused flights: `refused` overtook the total, `unscored` went
 * negative and the status response failed validation (found in reliability run R1).
 */
export function noPredictionPipeline(): Document[] {
  return [
    { $match: NO_PREDICTION },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        refused: { $sum: { $cond: [{ $eq: [{ $type: '$scoreError' }, 'string'] }, 1, 0] } },
      },
    },
  ];
}

export interface ModelKey {
  modelVersion: string;
  threshold: number;
}

export type TotalsGroup = ModelKey & DerivedMetrics & { scored: number; noOutcome: number };
export type WindowGroup = ModelKey & DerivedMetrics & { rocAuc: number | null };

export interface StreamMetrics {
  stored: { flights: number; scored: number; refused: number; unscored: number };
  totals: { groups: TotalsGroup[] };
  window: {
    size: number;
    n: number;
    windowStart: string | null;
    windowEnd: string | null;
    writtenFrom: string | null;
    writtenTo: string | null;
    /** Scheduled departure hours covered: the replay order makes the window a slice of the day. */
    departureHours: { min: number; max: number } | null;
    groups: WindowGroup[];
  };
}

interface WindowRow {
  _id: ModelKey;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  windowStart: string;
  windowEnd: string;
  writtenFrom: Date;
  writtenTo: Date;
  depHourMin: number;
  depHourMax: number;
  pairs: ScoredPair[];
}

const minOf = <T>(values: T[]): T | null =>
  values.length === 0 ? null : values.reduce((a, b) => (b < a ? b : a));
const maxOf = <T>(values: T[]): T | null =>
  values.length === 0 ? null : values.reduce((a, b) => (b > a ? b : a));

async function loadTotals(db: Db): Promise<Pick<StreamMetrics, 'stored' | 'totals'>> {
  const flights = streamFlights(db);
  const count = (filter: Filter<StreamFlightDoc>) =>
    flights.countDocuments(filter, { maxTimeMS: QUERY_MAX_TIME_MS });
  const options = { maxTimeMS: QUERY_MAX_TIME_MS };

  // DISTINCT_SCANs on COUNTS_INDEX: the (modelVersion, threshold) pairs present. Unfiltered on
  // purpose: a `$type: "string"` filter turns the DISTINCT_SCAN into an IXSCAN + FETCH of every
  // document (measured ~0.8 s on 479,230); the null of unscored flights is dropped here instead.
  const versions = (
    (await flights.distinct('prediction.modelVersion', {}, options)) as unknown[]
  ).filter((value): value is string => typeof value === 'string');
  const keys = (
    await Promise.all(
      versions.map(async (modelVersion) => {
        const thresholds = (
          (await flights.distinct(
            'prediction.threshold',
            { 'prediction.modelVersion': modelVersion },
            options,
          )) as unknown[]
        ).filter((value): value is number => typeof value === 'number');
        return thresholds.map((threshold) => ({ modelVersion, threshold }));
      }),
    )
  ).flat();

  const [groups, withoutPrediction] = await Promise.all([
    Promise.all(
      keys.map(async (key): Promise<TotalsGroup> => {
        const f = confusionFilters(key.modelVersion, key.threshold);
        const [tp, fp, fn, tn, noOutcomeDelayed, noOutcomeOnTime] = await Promise.all([
          count(f.tp),
          count(f.fp),
          count(f.fn),
          count(f.tn),
          count(f.noOutcomeDelayed),
          count(f.noOutcomeOnTime),
        ]);
        const metrics = deriveMetrics({ tp, fp, fn, tn });
        const noOutcome = noOutcomeDelayed + noOutcomeOnTime;
        return { ...key, ...metrics, scored: metrics.n + noOutcome, noOutcome };
      }),
    ),
    flights
      .aggregate<{ total: number; refused: number }>(noPredictionPipeline(), options)
      .toArray()
      .then(([row]) => row ?? { total: 0, refused: 0 }),
  ]);
  const scored = groups.reduce((sum, group) => sum + group.scored, 0);
  return {
    stored: {
      flights: scored + withoutPrediction.total,
      scored,
      refused: withoutPrediction.refused,
      unscored: withoutPrediction.total - withoutPrediction.refused,
    },
    totals: { groups },
  };
}

async function loadWindow(db: Db, windowSize: number): Promise<StreamMetrics['window']> {
  const rows = await streamFlights(db)
    .aggregate<WindowRow>(rollingWindowPipeline(windowSize), { maxTimeMS: QUERY_MAX_TIME_MS })
    .toArray();
  const groups = rows.map((row): WindowGroup => ({
    ...row._id,
    ...deriveMetrics({ tp: row.tp, fp: row.fp, fn: row.fn, tn: row.tn }),
    rocAuc: rocAuc(row.pairs),
  }));
  return {
    size: windowSize,
    n: groups.reduce((sum, group) => sum + group.n, 0),
    windowStart: minOf(rows.map((row) => row.windowStart)),
    windowEnd: maxOf(rows.map((row) => row.windowEnd)),
    writtenFrom: minOf(rows.map((row) => row.writtenFrom))?.toISOString() ?? null,
    writtenTo: maxOf(rows.map((row) => row.writtenTo))?.toISOString() ?? null,
    departureHours:
      rows.length === 0
        ? null
        : {
            min: Math.min(...rows.map((row) => row.depHourMin)),
            max: Math.max(...rows.map((row) => row.depHourMax)),
          },
    groups,
  };
}

/**
 * The newest heartbeat of the group. Old ones may linger until the TTL monitor runs (about once a
 * minute), so this never relies on them being gone. Read on every status request (not cached):
 * liveness is the age of lastSeenAt.
 */
export async function loadHeartbeat(db: Db, groupId: string): Promise<Heartbeat | null> {
  const doc = await streamConsumers(db).findOne(
    { kind: 'consumer', groupId },
    { sort: { lastSeenAt: -1 }, maxTimeMS: QUERY_MAX_TIME_MS },
  );
  if (doc === null) return null;
  return {
    status: doc.status,
    lastSeenAt: doc.lastSeenAt,
    instanceId: doc.instanceId,
    throughput: doc.throughput,
    ...(doc.lastBatchAt === undefined ? {} : { lastBatchAt: doc.lastBatchAt }),
    ...(doc.error === undefined ? {} : { error: doc.error }),
  };
}

/** The cached part of a status read: totals and the rolling window. */
export async function loadStreamMetrics(
  db: Db,
  { windowSize }: { windowSize: number },
): Promise<StreamMetrics> {
  const [totals, window] = await Promise.all([loadTotals(db), loadWindow(db, windowSize)]);
  return { ...totals, window };
}
