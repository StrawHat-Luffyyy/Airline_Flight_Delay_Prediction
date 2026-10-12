import { ObjectId, type Db, type Filter } from 'mongodb';
import type { FlightItem, FlightsQuery, FlightsResponse } from '@flight-delay/shared';
import { collections, type FlightDoc } from '../db/collections.js';
import { STATS_RUNS, type StatsRunDoc } from '../stats/build.js';

const DAY_MS = 86_400_000;
const utcDay = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

export interface IdBounds {
  lo: ObjectId;
  hi: ObjectId;
}

export interface FilterOptions {
  /** Last `_id` of the previous page (keyset pagination over `_id`). */
  cursor?: ObjectId;
  /** Smallest and largest `_id` among the flights of the date window (from stats_daily). */
  idBounds?: IdBounds;
}

/**
 * Pure: the `flights` filter for GET /api/flights. FlightsQuerySchema already guarantees an
 * index-backed field (airline, origin, route or a closed date range); `to` is inclusive.
 * - origin + dest is the denormalized route key, served by route_1 instead of an unindexed dest.
 * - A date window gets `_id` bounds. Pages are read in `_id` order, and without the bounds a
 *   window late in the year makes the planner walk the `_id` index from the start (measured
 *   8.8 s for December). The bounds are the true min/max `_id` of the window's flights, so they
 *   never exclude a matching flight.
 */
export function flightsFilter(query: FlightsQuery, options: FilterOptions = {}): Filter<FlightDoc> {
  const filter: Filter<FlightDoc> = {};
  if (query.airline) filter.airline = query.airline;
  if (query.route) {
    filter.route = query.route;
    if (query.origin) filter.origin = query.origin;
    if (query.dest) filter.dest = query.dest;
  } else if (query.origin && query.dest) {
    filter.route = `${query.origin}-${query.dest}`;
  } else if (query.origin) {
    filter.origin = query.origin;
  }
  if (query.from && query.to) {
    filter.date = { $gte: utcDay(query.from), $lt: new Date(utcDay(query.to).getTime() + DAY_MS) };
  }
  const idRange = {
    ...(options.idBounds ? { $gte: options.idBounds.lo, $lte: options.idBounds.hi } : {}),
    ...(options.cursor ? { $gt: options.cursor } : {}),
  };
  if (Object.keys(idRange).length > 0) filter._id = idRange;
  return filter;
}

/**
 * `_id` bounds of a date window from stats_daily (minId/maxId per day). Used only when the stats
 * were built after the last completed ingest, so they cover every current flight; otherwise
 * null (the query still runs, unbounded). 'empty' when no flight falls in the window.
 */
export async function dateWindowIdBounds(
  db: Db,
  from: string,
  to: string,
): Promise<IdBounds | null | 'empty'> {
  const [lastStats, lastIngest] = await Promise.all([
    db
      .collection<StatsRunDoc>(STATS_RUNS)
      .findOne({ status: 'completed' }, { sort: { finishedAt: -1 } }),
    collections
      .ingestRuns(db)
      .findOne({ file: 'flights.csv', status: 'completed' }, { sort: { finishedAt: -1 } }),
  ]);
  if (!lastStats || (lastIngest && lastIngest.finishedAt > lastStats.startedAt)) return null;

  const [bounds] = await db
    .collection('stats_daily')
    .aggregate<{ lo: unknown; hi: unknown }>([
      { $match: { date: { $gte: utcDay(from), $lt: new Date(utcDay(to).getTime() + DAY_MS) } } },
      { $group: { _id: null, lo: { $min: '$minId' }, hi: { $max: '$maxId' } } },
    ])
    .toArray();
  if (!bounds) return 'empty';
  return bounds.lo instanceof ObjectId && bounds.hi instanceof ObjectId
    ? { lo: bounds.lo, hi: bounds.hi }
    : null;
}

export class InvalidCursorError extends Error {
  constructor() {
    super('cursor must be a value returned as nextCursor');
  }
}

export function parseCursor(cursor: string | undefined): ObjectId | undefined {
  if (cursor === undefined) return undefined;
  if (!ObjectId.isValid(cursor) || String(new ObjectId(cursor)) !== cursor) {
    throw new InvalidCursorError();
  }
  return new ObjectId(cursor);
}

const PROJECTION = {
  date: 1,
  airline: 1,
  flightNumber: 1,
  origin: 1,
  dest: 1,
  schedDepMin: 1,
  depDelay: 1,
  arrDelay: 1,
  cancelled: 1,
  diverted: 1,
  isDelayed: 1,
} as const;

type ProjectedFlight = Pick<FlightDoc, keyof typeof PROJECTION> & { _id: ObjectId };

const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function toFlightItem(doc: ProjectedFlight): FlightItem {
  return {
    id: doc._id.toHexString(),
    date: doc.date.toISOString().slice(0, 10),
    airline: doc.airline,
    flightNumber: doc.flightNumber,
    origin: doc.origin,
    dest: doc.dest,
    schedDep: hhmm(doc.schedDepMin),
    depDelay: doc.depDelay,
    arrDelay: doc.arrDelay,
    cancelled: doc.cancelled,
    diverted: doc.diverted,
    isDelayed: doc.isDelayed,
  };
}

/** Builds the filter, including `_id` bounds for a date window when the stats are current. */
export async function resolveFlightsFilter(
  db: Db,
  query: FlightsQuery,
): Promise<Filter<FlightDoc> | 'empty'> {
  const cursor = parseCursor(query.cursor);
  const bounds = query.from && query.to ? await dateWindowIdBounds(db, query.from, query.to) : null;
  if (bounds === 'empty') return 'empty';
  return flightsFilter(query, { cursor, ...(bounds ? { idBounds: bounds } : {}) });
}

export async function getFlights(db: Db, query: FlightsQuery): Promise<FlightsResponse> {
  const filter = await resolveFlightsFilter(db, query);
  if (filter === 'empty') return { items: [], nextCursor: null };
  const docs = await collections
    .flights(db)
    .find<ProjectedFlight>(filter, { projection: PROJECTION })
    .sort({ _id: 1 })
    .limit(query.limit + 1)
    .toArray();
  const page = docs.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toFlightItem),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}
