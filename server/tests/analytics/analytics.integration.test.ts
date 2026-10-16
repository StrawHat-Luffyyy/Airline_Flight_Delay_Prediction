import { MongoClient, type Db, type Document } from 'mongodb';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CancellationsResponseSchema,
  CascadeResponseSchema,
  CausesResponseSchema,
  DelayDistributionResponseSchema,
  DelayRateResponseSchema,
  FlightsResponseSchema,
  HeatmapResponseSchema,
  RoutesResponseSchema,
  MetaResponseSchema,
  SummaryResponseSchema,
  TrendResponseSchema,
} from '@flight-delay/shared';
import { createApp } from '../../src/app.js';
import type { CancellationReason, DelayCauses, FlightDoc } from '../../src/db/collections.js';
import { buildStats } from '../../src/stats/build.js';

// Needs a reachable MongoDB (MONGODB_URI from vitest.config.ts); skipped when there is none.
const TEST_DB = 'flight_delay_analytics_test';
const logger = pino({ level: 'silent' });

let client: MongoClient | undefined;
let db: Db;
let app: ReturnType<typeof createApp>;

interface Spec {
  airline: 'AA' | 'DL';
  origin: string;
  dest: string;
  date: string;
  hour: number;
  arrDelay: number | null;
  isDelayed: boolean | null;
  causes: DelayCauses | null;
  cancelled?: CancellationReason;
  diverted?: boolean;
  flightNumber: number;
}

const AIRLINE_NAMES = { AA: 'American Airlines Inc.', DL: 'Delta Air Lines Inc.' } as const;
const CITIES: Record<string, [string, string]> = {
  JFK: ['New York', 'NY'],
  LAX: ['Los Angeles', 'CA'],
  ATL: ['Atlanta', 'GA'],
};
const DOW: Record<string, number> = {
  '2015-01-05': 1,
  '2015-01-06': 2,
  '2015-02-02': 1,
  '2015-10-01': 4,
};

function causes(
  carrier: number | null,
  weather: number | null,
  nas: number | null,
  security: number | null,
  lateAircraft: number | null,
): DelayCauses {
  return { carrier, weather, nas, security, lateAircraft };
}

function flight(s: Spec): FlightDoc {
  const [year, month, day] = s.date.split('-').map(Number) as [number, number, number];
  const originIsIata = /^[A-Z]{3}$/.test(s.origin);
  const [originCity, originState] = CITIES[s.origin] ?? [null, null];
  const [destCity, destState] = CITIES[s.dest] ?? [null, null];
  return {
    date: new Date(`${s.date}T00:00:00.000Z`),
    year,
    month,
    day,
    dayOfWeek: DOW[s.date] as number,
    airline: s.airline,
    airlineName: AIRLINE_NAMES[s.airline],
    flightNumber: s.flightNumber,
    tailNumber: null,
    origin: s.origin,
    originIsIata,
    originAirportId: originIsIata ? null : s.origin,
    originIataDerived: false,
    originCity: originIsIata ? (originCity ?? null) : null,
    originState: originIsIata ? (originState ?? null) : null,
    dest: s.dest,
    destIsIata: true,
    destAirportId: null,
    destIataDerived: false,
    destCity: destCity ?? null,
    destState: destState ?? null,
    route: `${s.origin}-${s.dest}`,
    schedDepMin: s.hour * 60,
    schedDepHour: s.hour,
    schedArrMin: (s.hour * 60 + 300) % 1440,
    distance: 1000,
    scheduledTime: 300,
    depDelay: null,
    arrDelay: s.arrDelay,
    taxiOut: null,
    taxiIn: null,
    airTime: null,
    elapsedTime: null,
    cancelled: s.cancelled !== undefined,
    cancellationReason: s.cancelled ?? null,
    diverted: s.diverted ?? false,
    isDelayed: s.isDelayed,
    causes: s.causes,
    split: month <= 9 ? 'train' : 'test',
  };
}

function aa(n: number, date: string, hour: number, rest: Partial<Spec>): FlightDoc {
  return flight({
    flightNumber: n,
    airline: 'AA',
    origin: 'JFK',
    dest: 'LAX',
    date,
    hour,
    arrDelay: null,
    isDelayed: null,
    causes: null,
    ...rest,
  });
}

function dl(n: number, origin: string, date: string, hour: number, rest: Partial<Spec>): FlightDoc {
  return flight({
    flightNumber: n,
    airline: 'DL',
    origin,
    dest: 'JFK',
    date,
    hour,
    arrDelay: null,
    isDelayed: null,
    causes: null,
    ...rest,
  });
}

const FIXTURE: FlightDoc[] = [
  aa(1, '2015-01-05', 8, { arrDelay: 30, isDelayed: true, causes: causes(10, null, 5, null, 15) }),
  aa(2, '2015-01-05', 8, { arrDelay: -5, isDelayed: false }),
  aa(3, '2015-01-06', 17, { arrDelay: 60, isDelayed: true, causes: causes(0, 20, 0, 0, 40) }),
  aa(4, '2015-01-06', 17, { cancelled: 'B' }),
  dl(5, 'ATL', '2015-02-02', 8, { arrDelay: 15, isDelayed: true, causes: causes(15, 0, 0, 0, 0) }),
  dl(6, 'ATL', '2015-02-02', 8, { diverted: true }),
  dl(7, 'ATL', '2015-02-02', 20, { arrDelay: 0, isDelayed: false }),
  dl(8, '10666', '2015-10-01', 8, {
    arrDelay: 20,
    isDelayed: true,
    causes: causes(20, 0, 0, 0, 0),
  }),
  dl(9, 'ATL', '2015-10-01', 20, { cancelled: 'A' }),
];

beforeAll(async () => {
  const candidate = new MongoClient(process.env.MONGODB_URI ?? '', {
    serverSelectionTimeoutMS: 2_000,
  });
  try {
    await candidate.connect();
    client = candidate;
  } catch {
    await candidate.close();
    return;
  }
  db = client.db(TEST_DB);
  await db.dropDatabase();
  await db.collection('airlines').insertMany([
    { _id: 'AA', name: AIRLINE_NAMES.AA },
    { _id: 'DL', name: AIRLINE_NAMES.DL },
  ] as unknown as Document[]);
  await db.collection('airports').insertMany(
    Object.entries(CITIES).map(([code, [city, state]]) => ({
      _id: code,
      name: code,
      city,
      state,
      country: 'USA',
      latitude: null,
      longitude: null,
    })) as unknown as Document[],
  );
  await db.collection('flights').insertMany(FIXTURE.map((f) => ({ ...f })));
  await db.collection('stats_route').insertOne({ _id: 'OLD-OLD', buildId: 'old' } as never);
  app = createApp({ pingMongo: async () => true, getDb: () => db, cacheTtlMs: 0 });
});

afterAll(async () => {
  if (!client) return;
  await client.db(TEST_DB).dropDatabase();
  await client.close();
});

async function get(path: string, status = 200): Promise<unknown> {
  const response = await request(app).get(path);
  expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(status);
  return response.body;
}

async function delayRows(query: string) {
  return DelayRateResponseSchema.parse(await get(`/api/analytics/delay-rate?${query}`)).rows;
}

async function causeRows(by: string) {
  return CausesResponseSchema.parse(await get(`/api/analytics/causes?by=${by}`)).rows;
}

describe('analytics API (MongoDB integration)', () => {
  it('buildStats removes stale docs and is idempotent', async (context) => {
    if (!client) return context.skip();
    const first = await buildStats(db, logger);
    const route = first.collections.find((c) => c.collection === 'stats_route');
    expect(route?.staleRemoved).toBeGreaterThanOrEqual(1);
    expect(await db.collection('stats_route').countDocuments({ _id: 'OLD-OLD' as never })).toBe(0);
    const firstCounts = Object.fromEntries(first.collections.map((c) => [c.collection, c.docs]));

    const second = await buildStats(db, logger);
    expect(Object.fromEntries(second.collections.map((c) => [c.collection, c.docs]))).toEqual(
      firstCounts,
    );
  });

  it('stats_route carries the schedule fields /predict derives (distance, scheduledTime)', async (context) => {
    if (!client) return context.skip();
    await buildStats(db, logger);
    const route = await db.collection('stats_route').findOne({ _id: 'JFK-LAX' as never });
    expect(route).toMatchObject({ distance: 1000, scheduledTime: 300 });
  });

  it('summary', async (context) => {
    if (!client) return context.skip();
    const body = SummaryResponseSchema.parse(await get('/api/analytics/summary'));
    // 9 flights; completed = 9 - 2 cancelled - 1 diverted = 6; delayed = flights 1,3,5,8 = 4
    // arrDelay sum over completed = 30 - 5 + 60 + 15 + 0 + 20 = 120 -> avg 20
    expect(body).toMatchObject({ flights: 9, completed: 6, delayed: 4, cancelled: 2, diverted: 1 });
    expect(body.delayRate).toBeCloseTo(4 / 6);
    expect(body.cancelRate).toBeCloseTo(2 / 9);
    expect(body.avgArrDelay).toBeCloseTo(20);
  });

  describe('delay-rate', () => {
    it('by airline, with ties and minFlights', async (context) => {
      if (!client) return context.skip();
      const rows = await delayRows('by=airline&minFlights=1');
      // AA: 4 flights, 3 completed, 2 delayed, arr sum 30-5+60=85. DL: 5 flights, 3 completed
      // (5,7,8), 2 delayed, arr sum 15+0+20=35. Both rate 2/3 -> tie, AA first.
      expect(rows.map((r) => r.key)).toEqual(['AA', 'DL']);
      expect(rows.map((r) => r.label)).toEqual([AIRLINE_NAMES.AA, AIRLINE_NAMES.DL]);
      expect(rows[0]).toMatchObject({ flights: 4, completed: 3, delayed: 2 });
      expect(rows[0]?.avgArrDelay).toBeCloseTo(85 / 3);
      expect(rows[1]).toMatchObject({ flights: 5, completed: 3, delayed: 2 });
      expect(rows[1]?.avgArrDelay).toBeCloseTo(35 / 3);
      expect(rows[0]?.delayRate).toBeCloseTo(2 / 3);

      const filtered = await delayRows('by=airline&minFlights=5');
      expect(filtered.map((r) => r.key)).toEqual(['DL']);
    });

    it('by origin excludes non-IATA origins and honours order', async (context) => {
      if (!client) return context.skip();
      const worst = await delayRows('by=origin&minFlights=1&order=worst');
      // JFK: flights 1-4 -> 4, completed 3, delayed 2 (2/3). ATL: 5,6,7,9 -> 4, completed 2, delayed 1 (.5)
      expect(worst.map((r) => r.key)).toEqual(['JFK', 'ATL']);
      expect(worst[0]).toMatchObject({ flights: 4, completed: 3, delayed: 2 });
      expect(worst[1]).toMatchObject({ flights: 4, completed: 2, delayed: 1 });
      expect(worst[1]?.delayRate).toBeCloseTo(0.5);
      expect(worst.some((r) => r.key === '10666')).toBe(false);

      const best = await delayRows('by=origin&minFlights=1&order=best');
      expect(best.map((r) => r.key)).toEqual(['ATL', 'JFK']);
    });

    it('by route', async (context) => {
      if (!client) return context.skip();
      const rows = await delayRows('by=route&minFlights=1');
      expect(rows.map((r) => r.key)).toEqual(['JFK-LAX', 'ATL-JFK']);
      expect(rows[0]).toMatchObject({ flights: 4, completed: 3, delayed: 2 });
      expect(rows[1]).toMatchObject({ flights: 4, completed: 2, delayed: 1 });
      expect(rows.some((r) => r.key === '10666-JFK')).toBe(false);
    });

    it('by dow is the whole series sorted by key', async (context) => {
      if (!client) return context.skip();
      const rows = await delayRows('by=dow&minFlights=1');
      // Mon: flights 1,2,5,6,7 -> 5; completed 1,2,5,7 = 4; delayed 1,5 = 2
      // Tue: 3,4 -> 2 flights, 1 completed, 1 delayed. Thu: 8,9 -> 2, 1, 1
      expect(rows.map((r) => r.key)).toEqual([1, 2, 4]);
      expect(rows.map((r) => r.label)).toEqual(['Monday', 'Tuesday', 'Thursday']);
      expect(rows.map((r) => [r.flights, r.completed, r.delayed])).toEqual([
        [5, 4, 2],
        [2, 1, 1],
        [2, 1, 1],
      ]);
    });

    it('by hour excludes the non-IATA flight', async (context) => {
      if (!client) return context.skip();
      const rows = await delayRows('by=hour&minFlights=1');
      // h8: flights 1,2,5,6 (8 excluded) = 4, completed 1,2,5 = 3, delayed 1,5 = 2
      // h17: 3,4 -> 2,1,1. h20: 7,9 -> 2,1,0
      expect(rows.map((r) => [r.key, r.flights, r.completed, r.delayed])).toEqual([
        [8, 4, 3, 2],
        [17, 2, 1, 1],
        [20, 2, 1, 0],
      ]);
    });

    it('rejects an unknown enum value', async (context) => {
      if (!client) return context.skip();
      const body = (await get('/api/analytics/delay-rate?by=planet', 400)) as {
        error: { code: string };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('causes', () => {
    it('overall', async (context) => {
      if (!client) return context.skip();
      const [row] = await causeRows('overall');
      // carrier 10+0+15+20 = 45, weather 20, nas 5, security 0, lateAircraft 15+40 = 55 -> 125
      // null causes (flights 2,4,6,7,9) and null members count as nothing
      expect(row?.minutes).toEqual({
        carrier: 45,
        weather: 20,
        nas: 5,
        security: 0,
        lateAircraft: 55,
      });
      expect(row?.totalMinutes).toBe(125);
      expect(row?.shares.carrier).toBeCloseTo(45 / 125);
      expect(row?.shares.lateAircraft).toBeCloseTo(55 / 125);
      expect(row?.shares.security).toBeCloseTo(0);
    });

    it('by airline', async (context) => {
      if (!client) return context.skip();
      const rows = await causeRows('airline');
      // AA: carrier 10, weather 20, nas 5, late 55 = 90. DL: carrier 15+20 = 35
      expect(rows.map((r) => [r.key, r.totalMinutes])).toEqual([
        ['AA', 90],
        ['DL', 35],
      ]);
    });

    it('by month', async (context) => {
      if (!client) return context.skip();
      const rows = await causeRows('month');
      expect(rows.map((r) => [r.key, r.label, r.totalMinutes])).toEqual([
        [1, 'January', 90],
        [2, 'February', 15],
        [10, 'October', 20],
      ]);
    });

    it('by airport excludes non-IATA origins', async (context) => {
      if (!client) return context.skip();
      const rows = await causeRows('airport');
      expect(rows.map((r) => [r.key, r.totalMinutes])).toEqual([
        ['JFK', 90],
        ['ATL', 15],
      ]);
    });

    it('by hour, with zero-total shares null', async (context) => {
      if (!client) return context.skip();
      const rows = await causeRows('hour');
      const byHour = new Map(rows.map((r) => [Number(r.key), r]));
      expect(byHour.get(8)?.minutes).toEqual({
        carrier: 25,
        weather: 0,
        nas: 5,
        security: 0,
        lateAircraft: 15,
      });
      expect(byHour.get(8)?.totalMinutes).toBe(45);
      expect(byHour.get(17)?.minutes).toEqual({
        carrier: 0,
        weather: 20,
        nas: 0,
        security: 0,
        lateAircraft: 40,
      });
      expect(byHour.get(17)?.totalMinutes).toBe(60);
      expect(byHour.get(20)?.totalMinutes).toBe(0);
      expect(Object.values(byHour.get(20)?.shares ?? {})).toEqual([null, null, null, null, null]);
    });

    it('rejects an unknown enum value', async (context) => {
      if (!client) return context.skip();
      const body = (await get('/api/analytics/causes?by=planet', 400)) as {
        error: { code: string };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  it('cascade', async (context) => {
    if (!client) return context.skip();
    const { rows } = CascadeResponseSchema.parse(await get('/api/analytics/cascade'));
    const byHour = new Map(rows.map((r) => [r.hour, r]));
    expect(byHour.get(8)?.lateAircraftShare).toBeCloseTo(15 / 45);
    expect(byHour.get(17)?.lateAircraftShare).toBeCloseTo(40 / 60);
    expect(byHour.get(20)?.totalMinutes).toBe(0);
    expect(byHour.get(20)?.lateAircraftShare).toBeNull();
  });

  it('routes: the destinations flown from an origin, busiest first', async (context) => {
    if (!client) return context.skip();
    // ATL -> JFK: DL flights 5, 6, 7 (Feb) and 9 (Oct, cancelled) = 4 flights. JFK -> LAX: AA 1-4.
    expect(RoutesResponseSchema.parse(await get('/api/routes?origin=ATL'))).toEqual({
      origin: 'ATL',
      destinations: [{ dest: 'JFK', flights: 4 }],
    });
    expect(RoutesResponseSchema.parse(await get('/api/routes?origin=JFK')).destinations).toEqual([
      { dest: 'LAX', flights: 4 },
    ]);
    // A valid code with no departures is an empty list, not an error.
    expect(RoutesResponseSchema.parse(await get('/api/routes?origin=LAX')).destinations).toEqual(
      [],
    );
    expect(
      ((await get('/api/routes?origin=ab', 400)) as { error: { code: string } }).error.code,
    ).toBe('VALIDATION_ERROR');
    await get('/api/routes', 400);
  });

  it('heatmap: delay rate per (day of week, departure hour) cell', async (context) => {
    if (!client) return context.skip();
    const body = HeatmapResponseSchema.parse(await get('/api/analytics/heatmap'));
    // No airport key, so the numeric-origin flight 8 counts and coverage is complete.
    expect(body.coverage).toBeNull();
    // Mon 08: flights 1, 2, 5, 6 -> 3 completed (6 diverted), 2 delayed (1, 5).
    // Mon 20: flight 7 on time. Tue 17: flight 3 delayed, 4 cancelled.
    // Thu 08: flight 8 delayed. Thu 20: flight 9 cancelled -> no outcome, rate null.
    expect(body.cells).toEqual([
      { dow: 1, hour: 8, flights: 4, completed: 3, delayed: 2, delayRate: 2 / 3 },
      { dow: 1, hour: 20, flights: 1, completed: 1, delayed: 0, delayRate: 0 },
      { dow: 2, hour: 17, flights: 2, completed: 1, delayed: 1, delayRate: 1 },
      { dow: 4, hour: 8, flights: 1, completed: 1, delayed: 1, delayRate: 1 },
      { dow: 4, hour: 20, flights: 1, completed: 0, delayed: 0, delayRate: null },
    ]);
  });

  it('cancellations overall, by airline and by month', async (context) => {
    if (!client) return context.skip();
    const overall = CancellationsResponseSchema.parse(await get('/api/analytics/cancellations'));
    expect(overall.rows).toHaveLength(1);
    expect(overall.rows[0]?.total).toBe(2);
    expect(overall.rows[0]?.reasons).toEqual({ A: 1, B: 1, C: 0, D: 0, unknown: 0 });

    const airline = CancellationsResponseSchema.parse(
      await get('/api/analytics/cancellations?by=airline'),
    );
    expect(airline.rows.map((r) => [r.key, r.reasons.A, r.reasons.B])).toEqual([
      ['AA', 0, 1],
      ['DL', 1, 0],
    ]);

    const month = CancellationsResponseSchema.parse(
      await get('/api/analytics/cancellations?by=month'),
    );
    expect(month.rows.map((r) => [r.key, r.reasons.A, r.reasons.B])).toEqual([
      [1, 0, 1],
      [10, 1, 0],
    ]);
  });

  it('delay-distribution', async (context) => {
    if (!client) return context.skip();
    const body = DelayDistributionResponseSchema.parse(
      await get('/api/analytics/delay-distribution'),
    );
    // arrDelay of completed flights: -5, 0, 15, 20, 30, 60
    expect(body.completed).toBe(6);
    expect(body.buckets).toHaveLength(8);
    expect(body.buckets.at(-1)?.to).toBeNull();
    const count = (from: number) => body.buckets.find((b) => b.from === from)?.flights;
    expect(count(-15)).toBe(1); // -5
    expect(count(0)).toBe(1); // 0
    expect(count(15)).toBe(2); // 15, 20
    expect(count(30)).toBe(1); // 30
    expect(count(60)).toBe(1); // 60
    expect(body.buckets.reduce((sum, b) => sum + b.flights, 0)).toBe(6);
  });

  describe('trend', () => {
    it('month overall', async (context) => {
      if (!client) return context.skip();
      const body = TrendResponseSchema.parse(await get('/api/analytics/trend?granularity=month'));
      expect(
        body.points.map((p) => [p.period, p.flights, p.completed, p.delayed, p.cancelled]),
      ).toEqual([
        ['2015-01', 4, 3, 2, 1],
        ['2015-02', 3, 2, 1, 0],
        ['2015-10', 2, 1, 1, 1],
      ]);
    });

    it('filtered by airline', async (context) => {
      if (!client) return context.skip();
      const body = TrendResponseSchema.parse(await get('/api/analytics/trend?airline=AA'));
      expect(body.points.map((p) => p.period)).toEqual(['2015-01']);
    });

    it('daily for an origin', async (context) => {
      if (!client) return context.skip();
      const body = TrendResponseSchema.parse(
        await get('/api/analytics/trend?origin=JFK&granularity=day'),
      );
      expect(body.points.map((p) => [p.period, p.flights, p.completed, p.delayed])).toEqual([
        ['2015-01-05', 2, 2, 1],
        ['2015-01-06', 2, 1, 1],
      ]);
    });

    it('combines airline and origin (§9)', async (context) => {
      if (!client) return context.skip();
      const aaJfk = TrendResponseSchema.parse(
        await get('/api/analytics/trend?airline=AA&origin=JFK'),
      );
      expect(
        aaJfk.points.map((p) => [p.period, p.flights, p.completed, p.delayed, p.cancelled]),
      ).toEqual([['2015-01', 4, 3, 2, 1]]);

      // DL from ATL: flights 5,6,7 on 02-02 (completed 5,7; delayed 5) and 9 on 10-01 (cancelled)
      const dlAtl = TrendResponseSchema.parse(
        await get('/api/analytics/trend?airline=DL&origin=ATL&granularity=day'),
      );
      expect(
        dlAtl.points.map((p) => [p.period, p.flights, p.completed, p.delayed, p.cancelled]),
      ).toEqual([
        ['2015-02-02', 3, 2, 1, 0],
        ['2015-10-01', 1, 0, 0, 1],
      ]);
      expect(dlAtl.points[1]?.delayRate).toBeNull();

      const none = TrendResponseSchema.parse(
        await get('/api/analytics/trend?airline=DL&origin=JFK'),
      );
      expect(none.points).toEqual([]);
    });
  });

  describe('coverage of unresolved airports', () => {
    // Fixture flight 8 has the unresolved numeric origin 10666; it is the only one.
    it('is reported on every airport-keyed response and null elsewhere', async (context) => {
      if (!client) return context.skip();
      const excluded = async (path: string): Promise<number | null> => {
        const body = (await get(path)) as {
          coverage: { excludedUnresolvedFlights: number } | null;
        };
        return body.coverage ? body.coverage.excludedUnresolvedFlights : null;
      };
      expect(await excluded('/api/analytics/delay-rate?by=origin&minFlights=1')).toBe(1);
      expect(await excluded('/api/analytics/delay-rate?by=hour&minFlights=1')).toBe(1);
      expect(await excluded('/api/analytics/delay-rate?by=route&minFlights=1')).toBe(1);
      expect(await excluded('/api/analytics/causes?by=airport')).toBe(1);
      expect(await excluded('/api/analytics/causes?by=hour')).toBe(1);
      expect(await excluded('/api/analytics/cascade')).toBe(1);
      expect(await excluded('/api/analytics/trend?origin=JFK')).toBe(1);

      expect(await excluded('/api/analytics/delay-rate?by=airline&minFlights=1')).toBeNull();
      expect(await excluded('/api/analytics/causes?by=overall')).toBeNull();
      expect(await excluded('/api/analytics/trend?airline=AA')).toBeNull();
    });

    it('is summarised in /meta', async (context) => {
      if (!client) return context.skip();
      const body = MetaResponseSchema.parse(await get('/api/meta'));
      expect(body.dataQuality).toEqual({
        flights: 9,
        unresolvedOriginFlights: 1,
        unresolvedRouteFlights: 1,
      });
    });
  });

  it('meta', async (context) => {
    if (!client) return context.skip();
    const body = MetaResponseSchema.parse(await get('/api/meta'));
    expect(body.flights).toBe(9);
    expect(body.dateRange).toEqual({ from: '2015-01-05', to: '2015-10-01' });
    expect(body.airlines).toHaveLength(2);
    expect(body.airports).toHaveLength(3);
    expect(body.statsBuiltAt).not.toBeNull();
  });

  describe('flights', () => {
    it('paginates by keyset cursor', async (context) => {
      if (!client) return context.skip();
      const page1 = FlightsResponseSchema.parse(await get('/api/flights?airline=AA&limit=2'));
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = FlightsResponseSchema.parse(
        await get(`/api/flights?airline=AA&limit=2&cursor=${page1.nextCursor}`),
      );
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).toBeNull();
      const ids = [...page1.items, ...page2.items].map((i) => i.id);
      expect(new Set(ids).size).toBe(4);
      expect([...ids].sort()).toEqual(ids);
    });

    it('filters by route and date range, and shapes items', async (context) => {
      if (!client) return context.skip();
      const route = FlightsResponseSchema.parse(await get('/api/flights?route=JFK-LAX'));
      expect(route.items).toHaveLength(4);
      const day = FlightsResponseSchema.parse(
        await get('/api/flights?from=2015-02-02&to=2015-02-02'),
      );
      expect(day.items).toHaveLength(3);

      const first = route.items.find((i) => i.flightNumber === 1);
      expect(first).toMatchObject({ schedDep: '08:00', date: '2015-01-05', arrDelay: 30 });
      expect(first).not.toHaveProperty('originAirportId');
    });

    it('rejects unselective, malformed and oversize queries', async (context) => {
      if (!client) return context.skip();
      for (const query of ['dest=JFK', 'airline=AA&cursor=garbage', 'airline=AA&limit=101']) {
        const body = (await get(`/api/flights?${query}`, 400)) as { error: { code: string } };
        expect(body.error.code, query).toBe('VALIDATION_ERROR');
      }
    });
  });

  // Keep last: it mutates flights.
  it('caches responses for the TTL only', async (context) => {
    if (!client) return context.skip();
    const cachedApp = createApp({
      pingMongo: async () => true,
      getDb: () => db,
      cacheTtlMs: 60_000,
    });
    const summary = async (target: typeof app) =>
      SummaryResponseSchema.parse((await request(target).get('/api/analytics/summary')).body);

    expect((await summary(cachedApp)).flights).toBe(9);
    await db
      .collection('flights')
      .insertOne({ ...aa(10, '2015-01-05', 8, { arrDelay: 10, isDelayed: false }) });
    await buildStats(db, logger);
    expect((await summary(cachedApp)).flights).toBe(9);
    expect((await summary(app)).flights).toBe(10);
  });
});
