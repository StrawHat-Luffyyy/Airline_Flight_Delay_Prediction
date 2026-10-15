import type { AddressInfo } from 'node:net';
import type { Db, Document } from 'mongodb';
import { CAUSE_SOURCES, causesPipeline } from '../analytics/causes.js';
import { DELAY_RATE_SOURCES, delayRatePipeline } from '../analytics/delay-rate.js';
import { getFlights, resolveFlightsFilter } from '../analytics/flights.js';
import {
  CANCELLATIONS_SOURCE,
  CASCADE_SOURCE,
  cancellationsPipeline,
  cascadePipeline,
  trendPipeline,
  trendSource,
} from '../analytics/series.js';
import { SUMMARY_SOURCE, summaryPipeline } from '../analytics/summary.js';
import { createApp } from '../app.js';
import { collections } from './collections.js';
import { summarizeExplain, type ExplainSummary } from './explain.js';
import {
  CausesQuerySchema,
  DelayRateQuerySchema,
  FlightsQuerySchema,
  TrendQuerySchema,
} from '@flight-delay/shared';
import { HEATMAP_SOURCE, heatmapPipeline } from '../analytics/heatmap.js';

export const API_LIMIT_MS = 1_000;

interface ApiCheck {
  path: string;
  /** Collection the endpoint reads. */
  source: string;
  explain?: (db: Db) => Promise<ExplainSummary>;
}

export interface ApiTiming extends ApiCheck {
  status: number;
  medianMs: number;
  maxMs: number;
  plan: ExplainSummary | null;
}

const aggregate =
  (collection: string, pipeline: Document[]) =>
  async (db: Db): Promise<ExplainSummary> =>
    summarizeExplain(await db.collection(collection).aggregate(pipeline).explain('executionStats'));

const flightsFind =
  (query: Record<string, string>) =>
  async (db: Db): Promise<ExplainSummary> => {
    const parsed = FlightsQuerySchema.parse(query);
    const filter = await resolveFlightsFilter(db, parsed);
    return summarizeExplain(
      await collections
        .flights(db)
        .find(filter === 'empty' ? { _id: { $exists: false } } : filter)
        .sort({ _id: 1 })
        .limit(parsed.limit + 1)
        .explain('executionStats'),
    );
  };

function checks(page2Cursor: string | null): ApiCheck[] {
  const causes = (['overall', 'airline', 'airport', 'month', 'hour'] as const).map((by) => {
    const query = CausesQuerySchema.parse({ by });
    return {
      path: `/api/analytics/causes?by=${by}`,
      source: CAUSE_SOURCES[by].collection,
      explain: aggregate(CAUSE_SOURCES[by].collection, causesPipeline(query)),
    };
  });
  const delayRates = (['airline', 'origin', 'route', 'dow', 'hour'] as const).map((by) => {
    const query = DelayRateQuerySchema.parse({ by });
    return {
      path: `/api/analytics/delay-rate?by=${by}`,
      source: DELAY_RATE_SOURCES[by].collection,
      explain: aggregate(DELAY_RATE_SOURCES[by].collection, delayRatePipeline(query)),
    };
  });
  const trendInputs: Record<string, string>[] = [
    { granularity: 'month' },
    { granularity: 'day', airline: 'AA' },
    { granularity: 'day', origin: 'ORD' },
    { granularity: 'day', airline: 'DL', origin: 'ATL' },
  ];
  const trends = trendInputs.map((raw) => {
    const query = TrendQuerySchema.parse(raw);
    return {
      path: `/api/analytics/trend?${new URLSearchParams(raw).toString()}`,
      source: trendSource(query),
      explain: aggregate(trendSource(query), trendPipeline(query)),
    };
  });
  const flightQueries: Record<string, string>[] = [
    { airline: 'AA' },
    { origin: 'ATL' },
    { route: 'LAX-SFO' },
    { from: '2015-12-24', to: '2015-12-26' },
    // Worst cases found while reviewing Phase 3 (see DECISIONS): late windows, rare matches.
    { from: '2015-12-01', to: '2015-12-31' },
    { from: '2015-10-01', to: '2015-12-31' },
    { airline: 'HA', from: '2015-01-01', to: '2015-12-31' },
    { origin: 'ADK', from: '2015-12-01', to: '2015-12-31' },
    { origin: 'JFK', dest: 'HNL' },
    { route: 'ORD-ASE' },
    { airline: 'HA', origin: 'ATL' },
    { airline: 'DL', origin: 'ATL' },
    { route: 'JFK-LAX', from: '2015-12-30', to: '2015-12-31' },
  ];
  const flights = flightQueries.map((query) => ({
    path: `/api/flights?${new URLSearchParams(query).toString()}`,
    source: 'flights',
    explain: flightsFind(query),
  }));
  return [
    { path: '/api/meta', source: 'flights (date_1) + reference' },
    {
      path: '/api/analytics/summary',
      source: SUMMARY_SOURCE,
      explain: aggregate(SUMMARY_SOURCE, summaryPipeline()),
    },
    ...causes,
    ...delayRates,
    ...trends,
    {
      path: '/api/analytics/cascade',
      source: CASCADE_SOURCE,
      explain: aggregate(CASCADE_SOURCE, cascadePipeline()),
    },
    {
      path: '/api/analytics/cancellations?by=airline',
      source: CANCELLATIONS_SOURCE,
      explain: aggregate(CANCELLATIONS_SOURCE, cancellationsPipeline({ by: 'airline' })),
    },
    { path: '/api/analytics/delay-distribution', source: 'stats_delay_buckets' },
    {
      path: '/api/analytics/heatmap',
      source: HEATMAP_SOURCE,
      explain: aggregate(HEATMAP_SOURCE, heatmapPipeline()),
    },
    ...flights,
    ...(page2Cursor
      ? [
          {
            path: `/api/flights?airline=AA&cursor=${page2Cursor}`,
            source: 'flights',
            explain: flightsFind({ airline: 'AA', cursor: page2Cursor }),
          },
        ]
      : []),
  ];
}

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/**
 * Times every API endpoint over real HTTP against `db` with the response cache disabled, so
 * each request runs its query (PROJECT_OVERVIEW Phase 3: < 1 s on the full dataset).
 */
export async function measureApi(db: Db, runs = 3): Promise<ApiTiming[]> {
  const page1 = await getFlights(db, FlightsQuerySchema.parse({ airline: 'AA' }));
  const app = createApp({ pingMongo: async () => true, getDb: () => db, cacheTtlMs: 0 });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const results: ApiTiming[] = [];
    for (const check of checks(page1.nextCursor)) {
      const times: number[] = [];
      let status = 0;
      for (let i = 0; i < runs; i += 1) {
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${port}${check.path}`);
        await response.arrayBuffer();
        times.push(performance.now() - started);
        status = response.status;
      }
      results.push({
        ...check,
        status,
        medianMs: Math.round(median(times)),
        maxMs: Math.round(Math.max(...times)),
        plan: check.explain ? await check.explain(db) : null,
      });
    }
    return results;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
