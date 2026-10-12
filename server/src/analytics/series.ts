import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import {
  CascadeRowSchema,
  TrendPointSchema,
  type CancellationsQuery,
  type CancellationsResponse,
  type CascadeResponse,
  type DelayDistributionResponse,
  type TrendQuery,
  type TrendResponse,
} from '@flight-delay/shared';
import { DELAY_BUCKET_BOUNDARIES } from '../stats/builders.js';
import {
  DERIVED_RATES,
  MONTH_NAMES,
  SUM_OUTCOMES,
  shareExpression,
  type Labels,
} from './common.js';

// ---------- Trend (§9 /analytics/trend) ----------

/** stats_daily serves the overall and per-airline series; stats_daily_origin the per-origin one. */
export function trendSource(query: TrendQuery): string {
  return query.origin ? 'stats_daily_origin' : 'stats_daily';
}

export function trendPipeline(query: TrendQuery): Document[] {
  const match = query.origin
    ? { origin: query.origin }
    : query.airline
      ? { airline: query.airline }
      : {};
  const format = query.granularity === 'day' ? '%Y-%m-%d' : '%Y-%m';
  return [
    { $match: match },
    { $group: { _id: { $dateToString: { format, date: '$date' } }, ...SUM_OUTCOMES } },
    { $set: DERIVED_RATES },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        period: '$_id',
        flights: 1,
        completed: 1,
        delayed: 1,
        delayRate: 1,
        cancelled: 1,
        cancelRate: 1,
        avgArrDelay: 1,
      },
    },
  ];
}

export async function getTrend(db: Db, query: TrendQuery): Promise<TrendResponse> {
  const docs = await db.collection(trendSource(query)).aggregate(trendPipeline(query)).toArray();
  return {
    granularity: query.granularity,
    airline: query.airline ?? null,
    origin: query.origin ?? null,
    points: z.array(TrendPointSchema).parse(docs),
  };
}

// ---------- Cascade (§8.4) ----------

export const CASCADE_SOURCE = 'stats_airport_hour';

/** Late-aircraft share of all cause minutes by scheduled departure hour (delay propagation). */
export function cascadePipeline(): Document[] {
  return [
    {
      $group: {
        _id: '$hour',
        lateAircraftMinutes: { $sum: '$causeMinutes.lateAircraft' },
        totalMinutes: {
          $sum: {
            $add: [
              '$causeMinutes.carrier',
              '$causeMinutes.weather',
              '$causeMinutes.nas',
              '$causeMinutes.security',
              '$causeMinutes.lateAircraft',
            ],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        hour: '$_id',
        lateAircraftMinutes: 1,
        totalMinutes: 1,
        lateAircraftShare: shareExpression('$lateAircraftMinutes', '$totalMinutes'),
      },
    },
  ];
}

export async function getCascade(db: Db): Promise<CascadeResponse> {
  const docs = await db.collection(CASCADE_SOURCE).aggregate(cascadePipeline()).toArray();
  return { rows: z.array(CascadeRowSchema).parse(docs) };
}

// ---------- Cancellation reasons (§8.5) ----------

export const CANCELLATIONS_SOURCE = 'stats_cancellation';

export function cancellationsPipeline(query: CancellationsQuery): Document[] {
  const key = query.by === 'airline' ? '$airline' : query.by === 'month' ? '$month' : null;
  return [
    { $group: { _id: { key, reason: '$reason' }, flights: { $sum: '$flights' } } },
    {
      $group: {
        _id: '$_id.key',
        total: { $sum: '$flights' },
        reasons: { $push: { k: '$_id.reason', v: '$flights' } },
      },
    },
    { $sort: query.by === 'month' ? { _id: 1 } : { total: -1, _id: 1 } },
    {
      $project: {
        _id: 0,
        key: { $ifNull: ['$_id', 'overall'] },
        total: 1,
        reasons: { $arrayToObject: '$reasons' },
      },
    },
  ];
}

const CancellationAggregate = z.object({
  key: z.union([z.string(), z.number()]),
  total: z.number(),
  reasons: z.record(z.string(), z.number()),
});

export async function getCancellations(
  db: Db,
  query: CancellationsQuery,
  labels: Labels,
): Promise<CancellationsResponse> {
  const docs = await db
    .collection(CANCELLATIONS_SOURCE)
    .aggregate(cancellationsPipeline(query))
    .toArray();
  const rows = z.array(CancellationAggregate).parse(docs);
  return {
    by: query.by,
    rows: rows.map((row) => ({
      key: row.key,
      label:
        query.by === 'overall'
          ? 'All flights'
          : query.by === 'airline'
            ? (labels.airlines.get(String(row.key)) ?? String(row.key))
            : (MONTH_NAMES[Number(row.key)] ?? String(row.key)),
      total: row.total,
      reasons: {
        A: row.reasons.A ?? 0,
        B: row.reasons.B ?? 0,
        C: row.reasons.C ?? 0,
        D: row.reasons.D ?? 0,
        unknown: row.reasons.unknown ?? 0,
      },
    })),
  };
}

// ---------- Delay severity histogram ($bucket, §8) ----------

export const DELAY_DISTRIBUTION_SOURCE = 'stats_delay_buckets';

const BUCKET_LABELS = [
  '15+ min early',
  '0-15 min early',
  'On time (0-14 min late)',
  '15-29 min late',
  '30-59 min late',
  '1-2 h late',
  '2-3 h late',
  '3 h+ late',
];

const StoredBucket = z.object({ _id: z.union([z.number(), z.string()]), flights: z.number() });

export async function getDelayDistribution(db: Db): Promise<DelayDistributionResponse> {
  const stored = z
    .array(StoredBucket)
    .parse(await db.collection(DELAY_DISTRIBUTION_SOURCE).find().toArray());
  const counts = new Map(stored.map((bucket) => [bucket._id, bucket.flights]));
  const bounds = [...DELAY_BUCKET_BOUNDARIES];
  const buckets = bounds.slice(0, -1).map((from, index) => {
    const next = bounds[index + 1];
    const isLast = index === bounds.length - 2;
    return {
      from,
      to: isLast || next === undefined ? null : next,
      label: BUCKET_LABELS[index] ?? `${from}+`,
      flights: counts.get(from) ?? 0,
    };
  });
  return { completed: buckets.reduce((sum, b) => sum + b.flights, 0), buckets };
}
