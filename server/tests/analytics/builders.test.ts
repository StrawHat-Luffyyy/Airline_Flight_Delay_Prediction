import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { flightsFilter } from '../../src/analytics/flights.js';
import { delayRatePipeline } from '../../src/analytics/delay-rate.js';
import { causesPipeline } from '../../src/analytics/causes.js';
import { trendPipeline, trendSource } from '../../src/analytics/series.js';
import { heatmapPipeline } from '../../src/analytics/heatmap.js';
import { STATS_BUILDS } from '../../src/stats/builders.js';

const stageNames = (pipeline: object[]): string[] =>
  pipeline.map((stage) => Object.keys(stage)[0] ?? '');

describe('stats build pipelines', () => {
  it('every build ends in $merge into its own collection and stamps the buildId', () => {
    for (const build of STATS_BUILDS) {
      const pipeline = build.pipeline('run-1');
      const last = pipeline.at(-1);
      expect(last).toEqual({
        $merge: {
          into: build.collection,
          on: '_id',
          whenMatched: 'replace',
          whenNotMatched: 'insert',
        },
      });
      expect(JSON.stringify(pipeline)).toContain('"buildId":"run-1"');
    }
  });

  it('filters first wherever a subset of flights is aggregated', () => {
    const firstStage = Object.fromEntries(
      STATS_BUILDS.map((build) => [build.collection, stageNames(build.pipeline('x'))[0]]),
    );
    expect(firstStage).toEqual({
      stats_daily: '$group',
      stats_daily_origin: '$match',
      stats_route: '$match',
      stats_airport_hour: '$match',
      stats_cause_monthly: '$match',
      stats_cancellation: '$match',
      stats_delay_buckets: '$match',
      stats_dow_hour: '$group', // every flight; neither key depends on an airport id
    });
  });

  it('excludes unresolved numeric airport ids from airport-keyed collections', () => {
    const airportKeyed = STATS_BUILDS.filter((b) =>
      ['stats_daily_origin', 'stats_airport_hour', 'stats_route'].includes(b.collection),
    );
    for (const build of airportKeyed) {
      expect(build.pipeline('x')[0]).toMatchObject({ $match: { originIsIata: true } });
    }
  });
});

describe('read pipelines', () => {
  it('reads heatmap cells in day-of-week, hour order without _id', () => {
    expect(heatmapPipeline()).toEqual([
      { $sort: { dow: 1, hour: 1 } },
      { $project: { _id: 0, dow: 1, hour: 1, flights: 1, completed: 1, delayed: 1, delayRate: 1 } },
    ]);
  });

  it('ranks by delay rate with a key tiebreak and applies minFlights and limit', () => {
    const pipeline = delayRatePipeline({ by: 'route', minFlights: 500, limit: 5, order: 'worst' });
    expect(pipeline).toContainEqual({
      $match: { flights: { $gte: 500 }, completed: { $gt: 0 } },
    });
    expect(pipeline).toContainEqual({ $sort: { delayRate: -1, _id: 1 } });
    expect(pipeline).toContainEqual({ $limit: 5 });
  });

  it('returns hour and day-of-week as full series in key order', () => {
    const pipeline = delayRatePipeline({ by: 'hour', minFlights: 1, limit: 3, order: 'best' });
    expect(pipeline).toContainEqual({ $sort: { _id: 1 } });
    expect(stageNames(pipeline)).not.toContain('$limit');
  });

  it('limits airport cause rankings but not the monthly series', () => {
    expect(stageNames(causesPipeline({ by: 'airport', limit: 10 }))).toContain('$limit');
    expect(stageNames(causesPipeline({ by: 'month', limit: 10 }))).not.toContain('$limit');
  });

  it('reads the per-origin series only when an origin is given', () => {
    expect(trendSource({ granularity: 'month' })).toBe('stats_daily');
    expect(trendSource({ granularity: 'day', origin: 'ORD' })).toBe('stats_daily_origin');
    expect(trendPipeline({ granularity: 'day', airline: 'AA' })[0]).toEqual({
      $match: { airline: 'AA' },
    });
  });
});

describe('flightsFilter', () => {
  it('turns an inclusive from/to into a half-open UTC day range', () => {
    expect(flightsFilter({ from: '2015-12-24', to: '2015-12-26', limit: 20 })).toEqual({
      date: {
        $gte: new Date('2015-12-24T00:00:00.000Z'),
        $lt: new Date('2015-12-27T00:00:00.000Z'),
      },
    });
  });

  it('serves origin + dest as the indexed route key and continues after the cursor', () => {
    const cursor = new ObjectId('6acb8eb2f489b54247b90254');
    expect(
      flightsFilter({ airline: 'AA', origin: 'JFK', dest: 'ORD', limit: 20 }, { cursor }),
    ).toEqual({ airline: 'AA', route: 'JFK-ORD', _id: { $gt: cursor } });
  });

  it('keeps an explicit route and treats dest as a plain filter alongside it', () => {
    expect(flightsFilter({ route: 'LAX-SFO', dest: 'SFO', limit: 20 })).toEqual({
      route: 'LAX-SFO',
      dest: 'SFO',
    });
  });

  it('bounds a date window by the _id range of its days, combined with the cursor', () => {
    const cursor = new ObjectId('6acb8eb2f489b54247b90254');
    const lo = new ObjectId('6acb8eb2f489b54247b90000');
    const hi = new ObjectId('6acb8eb2f489b54247b9ffff');
    expect(
      flightsFilter(
        { from: '2015-12-24', to: '2015-12-24', limit: 20 },
        { cursor, idBounds: { lo, hi } },
      ),
    ).toEqual({
      date: {
        $gte: new Date('2015-12-24T00:00:00.000Z'),
        $lt: new Date('2015-12-25T00:00:00.000Z'),
      },
      _id: { $gte: lo, $lte: hi, $gt: cursor },
    });
  });
});
