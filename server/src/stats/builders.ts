import type { Document } from 'mongodb';

/**
 * Pure builders for the pre-aggregated "computed pattern" collections (PROJECT_OVERVIEW §6.1).
 * Each returns an aggregation over `flights` that ends in `$merge`, so dashboards read a few
 * thousand small documents instead of scanning 5.8M flights. Every output document carries the
 * run's `buildId`; build:stats deletes documents from older builds afterwards.
 *
 * Counts are stored as sums (flights, completed, delayed, ...), never only as averages, so any
 * coarser grouping at read time stays exact.
 */

export const STATS_COLLECTIONS = [
  'stats_daily',
  'stats_daily_origin',
  'stats_route',
  'stats_airport_hour',
  'stats_cause_monthly',
  'stats_cancellation',
  'stats_delay_buckets',
] as const;
export type StatsCollection = (typeof STATS_COLLECTIONS)[number];

/** A flight has an arrival outcome when isDelayed is set (not cancelled, diverted or unknown). */
const HAS_OUTCOME = { $ne: ['$isDelayed', null] };

/** Outcome counters shared by every delay-rate collection. */
export const OUTCOME_ACCUMULATORS = {
  flights: { $sum: 1 },
  completed: { $sum: { $cond: [HAS_OUTCOME, 1, 0] } },
  delayed: { $sum: { $cond: [{ $eq: ['$isDelayed', true] }, 1, 0] } },
  cancelled: { $sum: { $cond: ['$cancelled', 1, 0] } },
  diverted: { $sum: { $cond: ['$diverted', 1, 0] } },
  arrDelaySum: { $sum: { $cond: [HAS_OUTCOME, { $ifNull: ['$arrDelay', 0] }, 0] } },
} as const;

/** Cause minutes; a null cause counts as 0 only here, inside the analysis (§3). */
const CAUSE_ACCUMULATORS = {
  causeCarrier: { $sum: { $ifNull: ['$causes.carrier', 0] } },
  causeWeather: { $sum: { $ifNull: ['$causes.weather', 0] } },
  causeNas: { $sum: { $ifNull: ['$causes.nas', 0] } },
  causeSecurity: { $sum: { $ifNull: ['$causes.security', 0] } },
  causeLateAircraft: { $sum: { $ifNull: ['$causes.lateAircraft', 0] } },
  flightsWithCauses: { $sum: { $cond: [{ $eq: [{ $type: '$causes' }, 'object'] }, 1, 0] } },
} as const;

const CAUSE_FIELDS = Object.keys(CAUSE_ACCUMULATORS).filter((k) => k !== 'flightsWithCauses');

const causeMinutesObject = {
  carrier: '$causeCarrier',
  weather: '$causeWeather',
  nas: '$causeNas',
  security: '$causeSecurity',
  lateAircraft: '$causeLateAircraft',
};

/** delayRate, cancelRate and avgArrDelay derived from the stored sums (null when undefined). */
export const DERIVED_RATES = {
  delayRate: {
    $cond: [{ $gt: ['$completed', 0] }, { $divide: ['$delayed', '$completed'] }, null],
  },
  cancelRate: { $cond: [{ $gt: ['$flights', 0] }, { $divide: ['$cancelled', '$flights'] }, null] },
  avgArrDelay: {
    $cond: [{ $gt: ['$completed', 0] }, { $divide: ['$arrDelaySum', '$completed'] }, null],
  },
} as const;

function merge(into: StatsCollection): Document {
  return { $merge: { into, on: '_id', whenMatched: 'replace', whenNotMatched: 'insert' } };
}

/** (date, airline) daily series: summary, trend, delay rate by airline / day of week. */
export function statsDailyPipeline(buildId: string): Document[] {
  return [
    {
      $group: {
        _id: { date: '$date', airline: '$airline' },
        dayOfWeek: { $first: '$dayOfWeek' },
        month: { $first: '$month' },
        // _id range of the day, so /api/flights can bound date windows on the _id index.
        minId: { $min: '$_id' },
        maxId: { $max: '$_id' },
        ...OUTCOME_ACCUMULATORS,
        ...CAUSE_ACCUMULATORS,
      },
    },
    {
      $set: {
        date: '$_id.date',
        airline: '$_id.airline',
        ...DERIVED_RATES,
        causeMinutes: causeMinutesObject,
        buildId,
      },
    },
    { $unset: CAUSE_FIELDS },
    merge('stats_daily'),
  ];
}

/**
 * (date, origin, airline) daily series for trend ?origin= and ?airline=&origin= (§9).
 * Unresolved numeric airport ids are excluded.
 */
export function statsDailyOriginPipeline(buildId: string): Document[] {
  return [
    { $match: { originIsIata: true } },
    {
      $group: {
        _id: { date: '$date', origin: '$origin', airline: '$airline' },
        ...OUTCOME_ACCUMULATORS,
      },
    },
    {
      $set: {
        date: '$_id.date',
        origin: '$_id.origin',
        airline: '$_id.airline',
        ...DERIVED_RATES,
        buildId,
      },
    },
    merge('stats_daily_origin'),
  ];
}

/** One document per route with IATA codes on both ends. */
export function statsRoutePipeline(buildId: string): Document[] {
  return [
    { $match: { originIsIata: true, destIsIata: true } },
    {
      $group: {
        _id: '$route',
        origin: { $first: '$origin' },
        dest: { $first: '$dest' },
        ...OUTCOME_ACCUMULATORS,
      },
    },
    { $set: { route: '$_id', ...DERIVED_RATES, buildId } },
    merge('stats_route'),
  ];
}

/** (origin airport, scheduled departure hour): delay rate and cause minutes, incl. the cascade. */
export function statsAirportHourPipeline(buildId: string): Document[] {
  return [
    { $match: { originIsIata: true } },
    {
      $group: {
        _id: { airport: '$origin', hour: '$schedDepHour' },
        ...OUTCOME_ACCUMULATORS,
        ...CAUSE_ACCUMULATORS,
      },
    },
    {
      $set: {
        airport: '$_id.airport',
        hour: '$_id.hour',
        ...DERIVED_RATES,
        causeMinutes: causeMinutesObject,
        buildId,
      },
    },
    { $unset: CAUSE_FIELDS },
    merge('stats_airport_hour'),
  ];
}

/** (month, airline) cause minutes, over the flights that report causes (partial index). */
export function statsCauseMonthlyPipeline(buildId: string): Document[] {
  return [
    { $match: { causes: { $type: 'object' } } },
    {
      $group: {
        _id: { month: '$month', airline: '$airline' },
        carrier: { $sum: { $ifNull: ['$causes.carrier', 0] } },
        weather: { $sum: { $ifNull: ['$causes.weather', 0] } },
        nas: { $sum: { $ifNull: ['$causes.nas', 0] } },
        security: { $sum: { $ifNull: ['$causes.security', 0] } },
        lateAircraft: { $sum: { $ifNull: ['$causes.lateAircraft', 0] } },
        flightsWithCauses: { $sum: 1 },
      },
    },
    { $set: { month: '$_id.month', airline: '$_id.airline', buildId } },
    merge('stats_cause_monthly'),
  ];
}

/** (month, airline, reason) cancellation counts. */
export function statsCancellationPipeline(buildId: string): Document[] {
  return [
    { $match: { cancelled: true } },
    {
      $group: {
        _id: {
          month: '$month',
          airline: '$airline',
          reason: { $ifNull: ['$cancellationReason', 'unknown'] },
        },
        flights: { $sum: 1 },
      },
    },
    {
      $set: { month: '$_id.month', airline: '$_id.airline', reason: '$_id.reason', buildId },
    },
    merge('stats_cancellation'),
  ];
}

/** Arrival-delay severity histogram over completed flights (§8: $bucket). Bounds in minutes. */
export const DELAY_BUCKET_BOUNDARIES = [-100_000, -15, 0, 15, 30, 60, 120, 180, 100_000] as const;

export function statsDelayBucketsPipeline(buildId: string): Document[] {
  return [
    { $match: { isDelayed: { $ne: null } } },
    {
      $bucket: {
        groupBy: '$arrDelay',
        boundaries: [...DELAY_BUCKET_BOUNDARIES],
        default: 'outOfRange',
        output: { flights: { $sum: 1 } },
      },
    },
    { $set: { buildId } },
    merge('stats_delay_buckets'),
  ];
}

export interface StatsBuild {
  collection: StatsCollection;
  pipeline: (buildId: string) => Document[];
  /** Small read indexes on the output collection. */
  indexes: Record<string, 1 | -1>[];
}

export const STATS_BUILDS: readonly StatsBuild[] = [
  { collection: 'stats_daily', pipeline: statsDailyPipeline, indexes: [{ airline: 1, date: 1 }] },
  {
    collection: 'stats_daily_origin',
    pipeline: statsDailyOriginPipeline,
    indexes: [
      { origin: 1, date: 1 },
      { airline: 1, origin: 1, date: 1 },
    ],
  },
  { collection: 'stats_route', pipeline: statsRoutePipeline, indexes: [{ flights: -1 }] },
  { collection: 'stats_airport_hour', pipeline: statsAirportHourPipeline, indexes: [] },
  { collection: 'stats_cause_monthly', pipeline: statsCauseMonthlyPipeline, indexes: [] },
  { collection: 'stats_cancellation', pipeline: statsCancellationPipeline, indexes: [] },
  { collection: 'stats_delay_buckets', pipeline: statsDelayBucketsPipeline, indexes: [] },
];
