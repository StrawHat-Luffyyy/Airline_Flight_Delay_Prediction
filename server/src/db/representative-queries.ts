import type { Document } from 'mongodb';

interface QueryBase {
  id: string;
  title: string;
  /** The §6.2 index this query should use, or null when no index can help. */
  expectedIndex: string | null;
  why: string;
}

export type RepresentativeQuery =
  | (QueryBase & { kind: 'find'; filter: Document; projection?: Document })
  | (QueryBase & { kind: 'aggregate'; pipeline: Document[] });

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const delayRateGroup = {
  flights: { $sum: 1 },
  delayed: { $sum: { $cond: [{ $eq: ['$isDelayed', true] }, 1, 0] } },
  withOutcome: { $sum: { $cond: [{ $eq: ['$isDelayed', null] }, 0, 1] } },
};

/**
 * Queries used as index evidence for docs/EXPLAIN_RESULTS.md (PROJECT_OVERVIEW §6.2, Phase 2).
 * Airport-keyed queries filter `originIsIata: true`: 0.34% of October rows still carry numeric
 * BTS ids that resolve:airport-ids could not map, and airport analytics must exclude them.
 */
export const REPRESENTATIVE_QUERIES: readonly RepresentativeQuery[] = [
  {
    id: 'Q1',
    title: 'One airline over a month (American Airlines, March 2015)',
    kind: 'find',
    filter: { airline: 'AA', date: { $gte: utc('2015-03-01'), $lt: utc('2015-04-01') } },
    projection: { _id: 0, date: 1, flightNumber: 1, route: 1, arrDelay: 1 },
    expectedIndex: 'airline_1_date_1',
    why: 'Equality on airline, then a range on date: the compound index reads one contiguous key range.',
  },
  {
    id: 'Q2',
    title: 'Flights from one airport at one scheduled hour (ATL, 17:00), resolved codes only',
    kind: 'find',
    filter: { origin: 'ATL', schedDepHour: 17, originIsIata: true },
    projection: { _id: 0, date: 1, airline: 1, dest: 1, arrDelay: 1 },
    expectedIndex: 'origin_1_schedDepHour_1',
    why: 'Both index fields are equality matches; originIsIata is checked on the fetched documents.',
  },
  {
    id: 'Q3',
    title: 'Delay rate by scheduled hour for one airport (ORD), resolved codes only',
    kind: 'aggregate',
    pipeline: [
      { $match: { origin: 'ORD', originIsIata: true } },
      { $group: { _id: '$schedDepHour', ...delayRateGroup } },
      { $sort: { _id: 1 } },
    ],
    expectedIndex: 'origin_1_schedDepHour_1',
    why: 'The airport-x-hour analysis behind stats_airport_hour. $match comes first, so the origin prefix of the index is used, but isDelayed is not in the index: the pipeline must FETCH every ORD document, which is why the gain is smaller. Phase 3 serves this from the pre-aggregated stats_airport_hour instead of adding a covering index.',
  },
  {
    id: 'Q4',
    title: 'Delay rate for one route (LAX-SFO)',
    kind: 'aggregate',
    pipeline: [
      { $match: { route: 'LAX-SFO' } },
      { $group: { _id: '$route', ...delayRateGroup, avgArrDelay: { $avg: '$arrDelay' } } },
    ],
    expectedIndex: 'route_1',
    why: 'Route detail lookup; the denormalized route key avoids matching origin and dest separately.',
  },
  {
    id: 'Q5',
    title: 'Cause minutes by airline for one month (July), flights that report causes',
    kind: 'aggregate',
    pipeline: [
      { $match: { month: 7, causes: { $type: 'object' } } },
      {
        $group: {
          _id: '$airline',
          carrier: { $sum: { $ifNull: ['$causes.carrier', 0] } },
          weather: { $sum: { $ifNull: ['$causes.weather', 0] } },
          nas: { $sum: { $ifNull: ['$causes.nas', 0] } },
          security: { $sum: { $ifNull: ['$causes.security', 0] } },
          lateAircraft: { $sum: { $ifNull: ['$causes.lateAircraft', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ],
    expectedIndex: 'month_1_airline_1_with_causes',
    why: 'The filter repeats the partial-index condition (causes is an object), which lets the planner use the small partial index.',
  },
  {
    id: 'Q6',
    title: 'Number of delayed flights in December',
    kind: 'aggregate',
    pipeline: [{ $match: { isDelayed: true, month: 12 } }, { $count: 'delayed' }],
    expectedIndex: 'isDelayed_1_month_1',
    why: 'Both fields are in the index, so the count can be answered from index keys alone.',
  },
  {
    id: 'Q7',
    title: 'All flights over the Christmas period (24-26 Dec)',
    kind: 'find',
    filter: { date: { $gte: utc('2015-12-24'), $lt: utc('2015-12-27') } },
    projection: { _id: 0, date: 1, airline: 1, route: 1, isDelayed: 1 },
    expectedIndex: 'date_1',
    why: 'A pure date range, the access path for daily trends and the stats_daily build.',
  },
  {
    id: 'Q8',
    title: 'Control: delay-rate ranking over all routes (min 500 flights)',
    kind: 'aggregate',
    pipeline: [
      { $match: { originIsIata: true, destIsIata: true } },
      { $group: { _id: '$route', ...delayRateGroup } },
      { $match: { flights: { $gte: 500 } } },
      { $addFields: { delayRate: { $divide: ['$delayed', '$withOutcome'] } } },
      { $sort: { delayRate: -1, _id: 1 } },
      { $limit: 20 },
    ],
    expectedIndex: null,
    why: 'Ranking every route must read every flight, so no index helps; this is why Phase 3 pre-aggregates into stats_route.',
  },
];
