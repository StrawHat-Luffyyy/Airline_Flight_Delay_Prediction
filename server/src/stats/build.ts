import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { DataQuality } from '@flight-delay/shared';
import type { Logger } from 'pino';
import { RssMonitor } from '../ingest/rss.js';
import { STATS_BUILDS, type StatsCollection } from './builders.js';

export interface StatsCollectionResult {
  collection: StatsCollection;
  ms: number;
  docs: number;
  /** Documents left over from earlier builds and removed by this one. */
  staleRemoved: number;
}

export interface StatsRunDoc {
  buildId: string;
  startedAt: Date;
  finishedAt: Date;
  status: 'completed' | 'failed';
  collections: StatsCollectionResult[];
  totalMs: number;
  peakRssMb: number;
  /** Unresolved-airport counts, derived from the stats themselves (completed runs only). */
  dataQuality?: DataQuality;
  error?: string;
}

export const STATS_RUNS = 'stats_runs';

async function sumFlights(db: Db, collection: string): Promise<number> {
  const [row] = await db
    .collection(collection)
    .aggregate<{ flights: number }>([{ $group: { _id: null, flights: { $sum: '$flights' } } }])
    .toArray();
  return row?.flights ?? 0;
}

/**
 * Flights left out of airport-keyed stats because an airport is still a numeric BTS id.
 * stats_daily covers every flight, stats_daily_origin those with an IATA origin, stats_route
 * those with IATA codes at both ends, so the differences are exact counts.
 */
export async function dataQuality(db: Db): Promise<DataQuality> {
  const [flights, originResolved, routeResolved] = await Promise.all([
    sumFlights(db, 'stats_daily'),
    sumFlights(db, 'stats_daily_origin'),
    sumFlights(db, 'stats_route'),
  ]);
  return {
    flights,
    unresolvedOriginFlights: flights - originResolved,
    unresolvedRouteFlights: flights - routeResolved,
  };
}

/**
 * Rebuilds every stats_* collection from `flights`. Each pipeline $merges into its target with
 * this run's buildId, then documents from older builds are deleted, so keys that no longer exist
 * disappear (idempotent; the collection is never empty mid-build).
 */
export async function buildStats(db: Db, logger: Logger): Promise<StatsRunDoc> {
  const buildId = randomUUID();
  const startedAt = new Date();
  const monitor = new RssMonitor();
  const results: StatsCollectionResult[] = [];

  try {
    for (const build of STATS_BUILDS) {
      const started = performance.now();
      await db
        .collection('flights')
        .aggregate(build.pipeline(buildId), { allowDiskUse: true })
        .toArray();
      const target = db.collection(build.collection);
      // Sweep only after a successful merge: if a later step throws, this collection keeps a
      // complete set of documents and the failed run is recorded in stats_runs.
      const { deletedCount } = await target.deleteMany({ buildId: { $ne: buildId } });
      for (const key of build.indexes) await target.createIndex(key);
      const result: StatsCollectionResult = {
        collection: build.collection,
        ms: Math.round(performance.now() - started),
        docs: await target.countDocuments(),
        staleRemoved: deletedCount,
      };
      results.push(result);
      monitor.sample();
      logger.info(result, 'Built stats collection');
    }
  } catch (error) {
    const failed: StatsRunDoc = {
      buildId,
      startedAt,
      finishedAt: new Date(),
      status: 'failed',
      collections: results,
      totalMs: Date.now() - startedAt.getTime(),
      peakRssMb: monitor.stop(),
      error: error instanceof Error ? error.message : String(error),
    };
    await db
      .collection<StatsRunDoc>(STATS_RUNS)
      .insertOne(failed)
      .catch((recordError: unknown) => {
        logger.error({ err: recordError }, 'Could not record failed stats run');
      });
    throw error;
  }

  const run: StatsRunDoc = {
    buildId,
    startedAt,
    finishedAt: new Date(),
    status: 'completed',
    dataQuality: await dataQuality(db),
    collections: results,
    totalMs: Date.now() - startedAt.getTime(),
    peakRssMb: monitor.stop(),
  };
  await db.collection<StatsRunDoc>(STATS_RUNS).insertOne(run);
  return run;
}
