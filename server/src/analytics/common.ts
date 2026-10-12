import type { Db, Document } from 'mongodb';
import { collections } from '../db/collections.js';
import type { Coverage, DataQuality } from '@flight-delay/shared';
import { STATS_RUNS, type StatsRunDoc } from '../stats/build.js';
import { DERIVED_RATES } from '../stats/builders.js';

/** Re-aggregates stored outcome sums (stats_* documents) into coarser groups. */
export const SUM_OUTCOMES = {
  flights: { $sum: '$flights' },
  completed: { $sum: '$completed' },
  delayed: { $sum: '$delayed' },
  cancelled: { $sum: '$cancelled' },
  diverted: { $sum: '$diverted' },
  arrDelaySum: { $sum: '$arrDelaySum' },
} as const;

export { DERIVED_RATES };

/** `part / whole`, or null when the whole is 0. */
export function shareExpression(part: string, whole: string): Document {
  return { $cond: [{ $gt: [whole, 0] }, { $divide: [part, whole] }, null] };
}

export interface AirportLabel {
  name: string;
  city: string | null;
  state: string | null;
}

export interface Labels {
  airlines: ReadonlyMap<string, string>;
  airports: ReadonlyMap<string, AirportLabel>;
}

/** Display names from the small reference collections (14 airlines, 322 airports). */
export async function loadLabels(db: Db): Promise<Labels> {
  const [airlines, airports] = await Promise.all([
    collections.airlines(db).find().toArray(),
    collections.airports(db).find().toArray(),
  ]);
  return {
    airlines: new Map(airlines.map((a) => [a._id, a.name])),
    airports: new Map(airports.map((a) => [a._id, { name: a.name, city: a.city, state: a.state }])),
  };
}

export const DAY_NAMES = [
  '',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
export const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

export function airportLabel(labels: Labels, code: string): string {
  const airport = labels.airports.get(code);
  return airport?.city ? `${code} (${airport.city})` : code;
}

/** Which unresolved-airport rows an airport-keyed result leaves out (null = every flight counted). */
export type CoverageScope = 'origin' | 'route' | null;

/**
 * Coverage note for a result. Airport-keyed stats exclude flights whose airport is still a
 * numeric BTS id (resolve:airport-ids could not map it), so the response says how many.
 */
export function coverageFor(scope: CoverageScope, quality: DataQuality | null): Coverage {
  if (scope === null || quality === null) return null;
  const excluded =
    scope === 'origin' ? quality.unresolvedOriginFlights : quality.unresolvedRouteFlights;
  const which = scope === 'origin' ? 'origin airport' : 'origin or destination airport';
  return {
    excludedUnresolvedFlights: excluded,
    note: `Excludes ${excluded.toLocaleString('en-US')} flights whose ${which} is still an unresolved numeric BTS id (October 2015).`,
  };
}

/** Unresolved-airport counts recorded by the latest completed build:stats run. */
export async function loadDataQuality(db: Db): Promise<DataQuality | null> {
  const run = await db
    .collection<StatsRunDoc>(STATS_RUNS)
    .findOne({ status: 'completed' }, { sort: { finishedAt: -1 } });
  return run?.dataQuality ?? null;
}
