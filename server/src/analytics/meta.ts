import type { Db } from 'mongodb';
import type { MetaResponse } from '@flight-delay/shared';
import { collections } from '../db/collections.js';
import { STATS_RUNS, type StatsRunDoc } from '../stats/build.js';

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Dataset overview for the dashboard: counts, date range (via date_1), reference lists. */
export async function getMeta(db: Db): Promise<MetaResponse> {
  const flights = collections.flights(db);
  const projection = { projection: { _id: 0, date: 1 } };
  const [count, first, last, airlines, airports, lastRun] = await Promise.all([
    flights.estimatedDocumentCount(),
    flights.findOne({}, { ...projection, sort: { date: 1 } }),
    flights.findOne({}, { ...projection, sort: { date: -1 } }),
    collections.airlines(db).find().sort({ _id: 1 }).toArray(),
    collections.airports(db).find().sort({ _id: 1 }).toArray(),
    db
      .collection<StatsRunDoc>(STATS_RUNS)
      .findOne({ status: 'completed' }, { sort: { finishedAt: -1 } }),
  ]);
  return {
    flights: count,
    dateRange: first && last ? { from: isoDay(first.date), to: isoDay(last.date) } : null,
    airlines: airlines.map((a) => ({ code: a._id, name: a.name })),
    airports: airports.map((a) => ({
      code: a._id,
      name: a.name,
      city: a.city,
      state: a.state,
      latitude: a.latitude,
      longitude: a.longitude,
    })),
    statsBuiltAt: lastRun ? lastRun.finishedAt.toISOString() : null,
    dataQuality: lastRun?.dataQuality ?? null,
  };
}
