import { Router } from 'express';
import type { Db } from 'mongodb';
import {
  CancellationsQuerySchema,
  CausesQuerySchema,
  DelayRateQuerySchema,
  FlightsQuerySchema,
  TrendQuerySchema,
  type DataQuality,
} from '@flight-delay/shared';
import { getCauses } from '../analytics/causes.js';
import { loadDataQuality, loadLabels, type Labels } from '../analytics/common.js';
import { getDelayRate } from '../analytics/delay-rate.js';
import { getFlights } from '../analytics/flights.js';
import { getMeta } from '../analytics/meta.js';
import {
  getCancellations,
  getCascade,
  getDelayDistribution,
  getTrend,
} from '../analytics/series.js';
import { getSummary } from '../analytics/summary.js';
import { TtlCache } from '../cache.js';
import { parseQuery } from '../middleware/validate.js';

export interface ApiRouterOptions {
  getDb: () => Db;
  /** TTL for cached analytics, /meta and labels; 0 disables caching. */
  cacheTtlMs: number;
}

/**
 * GET routes from PROJECT_OVERVIEW §9. Handlers only validate, call the analytics service and
 * cache; every analytics read comes from a pre-aggregated stats_* collection.
 */
export function apiRouter({ getDb, cacheTtlMs }: ApiRouterOptions): Router {
  const router = Router();
  const cache = new TtlCache<unknown>({ ttlMs: cacheTtlMs });
  const labelsCache = new TtlCache<Labels>({ ttlMs: cacheTtlMs });
  const labels = (): Promise<Labels> => labelsCache.getOrLoad('labels', () => loadLabels(getDb()));
  const qualityCache = new TtlCache<DataQuality | null>({ ttlMs: cacheTtlMs });
  const quality = (): Promise<DataQuality | null> =>
    qualityCache.getOrLoad('quality', () => loadDataQuality(getDb()));
  const cached = (key: string, load: () => Promise<unknown>): Promise<unknown> =>
    cache.getOrLoad(key, load);

  router.get('/meta', async (_request, response) => {
    response.json(await cached('meta', () => getMeta(getDb())));
  });

  router.get('/analytics/summary', async (_request, response) => {
    response.json(await cached('summary', () => getSummary(getDb())));
  });

  router.get('/analytics/causes', async (request, response) => {
    const query = parseQuery(CausesQuerySchema, request.query);
    response.json(
      await cached(`causes:${JSON.stringify(query)}`, async () =>
        getCauses(getDb(), query, await labels(), await quality()),
      ),
    );
  });

  router.get('/analytics/delay-rate', async (request, response) => {
    const query = parseQuery(DelayRateQuerySchema, request.query);
    response.json(
      await cached(`delay-rate:${JSON.stringify(query)}`, async () =>
        getDelayRate(getDb(), query, await labels(), await quality()),
      ),
    );
  });

  router.get('/analytics/trend', async (request, response) => {
    const query = parseQuery(TrendQuerySchema, request.query);
    response.json(
      await cached(`trend:${JSON.stringify(query)}`, async () =>
        getTrend(getDb(), query, await quality()),
      ),
    );
  });

  router.get('/analytics/cascade', async (_request, response) => {
    response.json(await cached('cascade', async () => getCascade(getDb(), await quality())));
  });

  router.get('/analytics/cancellations', async (request, response) => {
    const query = parseQuery(CancellationsQuerySchema, request.query);
    response.json(
      await cached(`cancellations:${JSON.stringify(query)}`, async () =>
        getCancellations(getDb(), query, await labels()),
      ),
    );
  });

  router.get('/analytics/delay-distribution', async (_request, response) => {
    response.json(await cached('delay-distribution', () => getDelayDistribution(getDb())));
  });

  // Raw flight browsing is index-backed and paginated, so it is not cached.
  router.get('/flights', async (request, response) => {
    const query = parseQuery(FlightsQuerySchema, request.query);
    response.json(await getFlights(getDb(), query));
  });

  return router;
}
