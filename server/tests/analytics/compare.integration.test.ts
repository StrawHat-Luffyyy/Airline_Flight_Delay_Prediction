import { MongoClient, MongoNetworkError, type Db, type Document } from 'mongodb';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CompareResponseSchema,
  ErrorResponseSchema,
  SummaryResponseSchema,
  type CompareResponse,
} from '@flight-delay/shared';
import { createApp } from '../../src/app.js';
import type { CancellationReason, DelayCauses, FlightDoc } from '../../src/db/collections.js';
import { buildStats } from '../../src/stats/build.js';
import { useIntegrationTimeouts } from '../helpers/integration.js';

useIntegrationTimeouts();

// Needs a reachable MongoDB (MONGODB_URI from vitest.config.ts); skipped when there is none.
const TEST_DB = 'flight_delay_compare_test';
const logger = pino({ level: 'silent' });

let client: MongoClient | undefined;
let db: Db;
let app: ReturnType<typeof createApp>;

const CITIES: Record<string, string> = {
  JFK: 'New York',
  LAX: 'Los Angeles',
  ATL: 'Atlanta',
  ORD: 'Chicago',
};
const DOW: Record<string, number> = { '2015-01-05': 1, '2015-03-02': 1 };

interface Spec {
  n: number;
  airline: 'AA' | 'DL';
  route: string;
  date: string;
  hour: number;
  arrDelay?: number;
  causes?: [number | null, number | null, number | null, number | null, number | null];
  cancelled?: CancellationReason;
  diverted?: boolean;
}

function flight(s: Spec): FlightDoc {
  const [origin = '', dest = ''] = s.route.split('-');
  const [year, month, day] = s.date.split('-').map(Number) as [number, number, number];
  const originIsIata = /^[A-Z]{3}$/.test(origin);
  const completed = s.arrDelay !== undefined;
  const causes: DelayCauses | null = s.causes
    ? {
        carrier: s.causes[0],
        weather: s.causes[1],
        nas: s.causes[2],
        security: s.causes[3],
        lateAircraft: s.causes[4],
      }
    : null;
  return {
    date: new Date(`${s.date}T00:00:00.000Z`),
    year,
    month,
    day,
    dayOfWeek: DOW[s.date] as number,
    airline: s.airline,
    airlineName: s.airline,
    flightNumber: s.n,
    tailNumber: null,
    origin,
    originIsIata,
    originAirportId: originIsIata ? null : origin,
    originIataDerived: false,
    originCity: CITIES[origin] ?? null,
    originState: null,
    dest,
    destIsIata: true,
    destAirportId: null,
    destIataDerived: false,
    destCity: CITIES[dest] ?? null,
    destState: null,
    route: s.route,
    schedDepMin: s.hour * 60,
    schedDepHour: s.hour,
    schedArrMin: (s.hour * 60 + 300) % 1440,
    distance: 1000,
    scheduledTime: 300,
    depDelay: null,
    arrDelay: s.arrDelay ?? null,
    taxiOut: null,
    taxiIn: null,
    airTime: null,
    elapsedTime: null,
    cancelled: s.cancelled !== undefined,
    cancellationReason: s.cancelled ?? null,
    diverted: s.diverted ?? false,
    isDelayed: completed ? (s.arrDelay ?? 0) >= 15 : null,
    causes,
    split: month <= 9 ? 'train' : 'test',
  };
}

// AA flies JFK-LAX; DL flies ATL-JFK plus one flight from an unresolved numeric origin.
const FIXTURE: FlightDoc[] = [
  flight({
    n: 1,
    airline: 'AA',
    route: 'JFK-LAX',
    date: '2015-01-05',
    hour: 8,
    arrDelay: 30,
    causes: [10, null, 5, null, 15],
  }),
  flight({ n: 2, airline: 'AA', route: 'JFK-LAX', date: '2015-01-05', hour: 8, arrDelay: -5 }),
  flight({
    n: 3,
    airline: 'AA',
    route: 'JFK-LAX',
    date: '2015-03-02',
    hour: 17,
    arrDelay: 60,
    causes: [0, 20, 0, 0, 40],
  }),
  flight({ n: 4, airline: 'AA', route: 'JFK-LAX', date: '2015-03-02', hour: 17, cancelled: 'B' }),
  flight({
    n: 5,
    airline: 'DL',
    route: 'ATL-JFK',
    date: '2015-01-05',
    hour: 8,
    arrDelay: 15,
    causes: [15, 0, 0, 0, 0],
  }),
  flight({ n: 6, airline: 'DL', route: 'ATL-JFK', date: '2015-01-05', hour: 8, diverted: true }),
  flight({ n: 7, airline: 'DL', route: 'ATL-JFK', date: '2015-03-02', hour: 20, arrDelay: -12 }),
  flight({
    n: 8,
    airline: 'DL',
    route: '10666-JFK',
    date: '2015-03-02',
    hour: 8,
    arrDelay: 20,
    causes: [20, 0, 0, 0, 0],
  }),
  flight({ n: 9, airline: 'DL', route: 'ATL-JFK', date: '2015-03-02', hour: 20, cancelled: 'A' }),
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
  // UA and ORD exist in the reference data but have no flights.
  await db.collection('airlines').insertMany([
    { _id: 'AA', name: 'American Airlines Inc.' },
    { _id: 'DL', name: 'Delta Air Lines Inc.' },
    { _id: 'UA', name: 'United Air Lines Inc.' },
  ] as unknown as Document[]);
  await db.collection('airports').insertMany(
    Object.entries(CITIES).map(([code, city]) => ({
      _id: code,
      name: `${city} Airport`,
      city,
      state: null,
      country: 'USA',
      latitude: null,
      longitude: null,
    })) as unknown as Document[],
  );
  await db.collection('flights').insertMany(FIXTURE.map((f) => ({ ...f })));
  await buildStats(db, logger);
  app = createApp({ pingMongo: async () => true, getDb: () => db, cacheTtlMs: 0 });
});

afterAll(async () => {
  if (!client) return;
  await client.db(TEST_DB).dropDatabase();
  await client.close();
});

async function compare(query: string): Promise<CompareResponse> {
  const response = await request(app).get(`/api/analytics/compare?${query}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return CompareResponseSchema.parse(response.body);
}

async function failure(query: string, status: number) {
  const response = await request(app).get(`/api/analytics/compare?${query}`);
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return ErrorResponseSchema.parse(response.body).error;
}

const entity = (body: CompareResponse, id: string) => body.entities.find((e) => e.id === id);

describe('GET /api/analytics/compare (MongoDB integration)', () => {
  it('compares airlines from summed stats_daily counts', async (context) => {
    if (!client) return context.skip();
    const body = await compare('type=airline&ids=AA,DL&minFlights=1');
    expect(body).toMatchObject({ type: 'airline', baselineId: 'AA', coverage: null });
    const aa = entity(body, 'AA');
    const dl = entity(body, 'DL');
    expect(aa?.label).toBe('American Airlines Inc.');
    // AA: 4 flights, completed 1,2,3; delayed 1,3; arrival sum 30 - 5 + 60 = 85; 1 cancelled.
    expect(aa?.totals).toMatchObject({
      flights: 4,
      completed: 3,
      delayed: 2,
      cancelled: 1,
      diverted: 0,
    });
    expect(aa?.totals.delayRate).toBeCloseTo(2 / 3);
    expect(aa?.totals.avgArrDelay).toBeCloseTo(85 / 3);
    expect(aa?.totals.cancelRate).toBeCloseTo(1 / 4);
    expect(aa?.totals.divertRate).toBe(0);
    // DL: 5 flights, completed 5,7,8; delayed 5,8; arrival sum 15 - 12 + 20 = 23; 1 cancelled, 1 diverted.
    expect(dl?.totals).toMatchObject({
      flights: 5,
      completed: 3,
      delayed: 2,
      cancelled: 1,
      diverted: 1,
    });
    expect(dl?.totals.avgArrDelay).toBeCloseTo(23 / 3);
    expect(dl?.differences?.flights).toBe(1);
    expect(dl?.differences?.delayRate).toBe(0);
    expect(dl?.differences?.avgArrDelay).toBeCloseTo(-62 / 3);
    expect(dl?.differences?.cancelRate).toBeCloseTo(0.2 - 0.25);
    expect(dl?.differences?.divertRate).toBeCloseTo(0.2);
    // 2/3 against 2/3 is a tie; the rest have one leader each.
    expect(body.leaders).toEqual({
      delayRate: ['AA', 'DL'],
      avgArrDelay: ['DL'],
      cancelRate: ['DL'],
      divertRate: ['AA'],
    });
  });

  it('adds up to the dashboard summary across all airlines', async (context) => {
    if (!client) return context.skip();
    const body = await compare('type=airline&ids=AA,DL&minFlights=1');
    const summary = SummaryResponseSchema.parse(
      (await request(app).get('/api/analytics/summary')).body,
    );
    const sum = (field: 'flights' | 'completed' | 'delayed' | 'cancelled' | 'diverted') =>
      body.entities.reduce((total, e) => total + e.totals[field], 0);
    expect([
      sum('flights'),
      sum('completed'),
      sum('delayed'),
      sum('cancelled'),
      sum('diverted'),
    ]).toEqual([
      summary.flights,
      summary.completed,
      summary.delayed,
      summary.cancelled,
      summary.diverted,
    ]);
  });

  it('breaks down cause minutes, counting a null cause as zero', async (context) => {
    if (!client) return context.skip();
    const body = await compare('type=airline&ids=AA,DL&minFlights=1');
    const aa = entity(body, 'AA')?.causes;
    expect(aa).toMatchObject({
      flightsWithCauses: 2,
      totalMinutes: 90,
      minutes: { carrier: 10, weather: 20, nas: 5, security: 0, lateAircraft: 55 },
    });
    expect(aa?.shares.lateAircraft).toBeCloseTo(55 / 90);
    expect(entity(body, 'DL')?.causes).toMatchObject({ totalMinutes: 35, flightsWithCauses: 2 });
  });

  it('returns twelve months per airline, empty months with null rates', async (context) => {
    if (!client) return context.skip();
    const body = await compare('type=airline&ids=AA,DL&minFlights=1');
    const aa = entity(body, 'AA')?.monthly ?? [];
    expect(aa).toHaveLength(12);
    expect(aa[0]).toMatchObject({
      month: 1,
      flights: 2,
      completed: 2,
      delayed: 1,
      delayRate: 0.5,
      cancelRate: 0,
    });
    expect(aa[0]?.avgArrDelay).toBeCloseTo(12.5);
    expect(aa[1]).toMatchObject({ month: 2, flights: 0, delayRate: null, avgArrDelay: null });
    expect(aa[2]).toMatchObject({
      month: 3,
      flights: 2,
      completed: 1,
      delayed: 1,
      delayRate: 1,
      cancelRate: 0.5,
    });
    const dlMarch = entity(body, 'DL')?.monthly?.[2];
    expect(dlMarch).toMatchObject({ flights: 3, completed: 2, delayed: 1, delayRate: 0.5 });
  });

  it('flags an airline with no flights and keeps insufficient samples out of the leaders', async (context) => {
    if (!client) return context.skip();
    const body = await compare('type=airline&ids=DL,AA,UA&minFlights=5');
    expect(body.entities.map((e) => [e.id, e.sample])).toEqual([
      ['DL', 'ok'],
      ['AA', 'low'],
      ['UA', 'none'],
    ]);
    expect(entity(body, 'UA')?.totals).toMatchObject({
      flights: 0,
      delayRate: null,
      cancelRate: null,
    });
    expect(entity(body, 'UA')?.differences).toMatchObject({ flights: -5, delayRate: null });
    // Only DL has an ok sample, so no metric has a leader.
    expect(Object.values(body.leaders).every((ids) => ids.length === 0)).toBe(true);
  });

  it('compares airports by departures, with coverage for unresolved origins', async (context) => {
    if (!client) return context.skip();
    const body = await compare('type=airport&ids=JFK,ATL,ORD&minFlights=1');
    expect(body.coverage?.excludedUnresolvedFlights).toBe(1);
    expect(entity(body, 'JFK')?.label).toBe('JFK (New York)');
    expect(entity(body, 'JFK')?.totals).toMatchObject({ flights: 4, completed: 3, delayed: 2 });
    // ATL: flights 5,6,7,9; completed 5,7; delayed 5; arrival sum 15 - 12 = 3.
    const atl = entity(body, 'ATL');
    expect(atl?.totals).toMatchObject({
      flights: 4,
      completed: 2,
      delayed: 1,
      cancelled: 1,
      diverted: 1,
    });
    expect(atl?.totals.avgArrDelay).toBeCloseTo(1.5);
    expect(atl?.causes).toMatchObject({ totalMinutes: 15, minutes: { carrier: 15 } });
    expect(entity(body, 'ORD')?.sample).toBe('none');
    // Totals (stats_airport_hour) and the monthly series (stats_daily_origin) agree.
    for (const e of body.entities) {
      const monthlyFlights = (e.monthly ?? []).reduce((total, m) => total + m.flights, 0);
      expect(monthlyFlights, e.id).toBe(e.totals.flights);
    }
    expect(atl?.monthly?.[2]).toMatchObject({ flights: 2, completed: 1, delayed: 0, delayRate: 0 });
  });

  it('compares routes on outcomes only and says why causes and months are missing', async (context) => {
    if (!client) return context.skip();
    const body = await compare('type=route&ids=JFK-LAX,ATL-JFK,LAX-JFK&minFlights=1');
    expect(body.coverage?.excludedUnresolvedFlights).toBe(1);
    expect(entity(body, 'JFK-LAX')).toMatchObject({
      label: 'JFK → LAX',
      detail: 'New York → Los Angeles',
      totals: { flights: 4, completed: 3, delayed: 2 },
      causes: null,
      monthly: null,
    });
    expect(entity(body, 'ATL-JFK')?.totals).toMatchObject({ flights: 4, completed: 2, delayed: 1 });
    expect(entity(body, 'ATL-JFK')?.differences?.delayRate).toBeCloseTo(0.5 - 2 / 3);
    // Both airports are real, but nobody flew LAX-JFK in the fixture.
    expect(entity(body, 'LAX-JFK')?.sample).toBe('none');
    expect(body.availability.causes).not.toBeNull();
    expect(body.availability.monthly).not.toBeNull();
  });

  it('answers 422 UNKNOWN_ENTITY for codes not in the reference data', async (context) => {
    if (!client) return context.skip();
    const airline = await failure('type=airline&ids=AA,ZZ', 422);
    expect(airline).toMatchObject({
      code: 'UNKNOWN_ENTITY',
      message: 'Unknown airline: ZZ',
      details: { type: 'airline', ids: ['ZZ'] },
    });
    const route = await failure('type=route&ids=JFK-LAX,JFK-XYZ', 422);
    expect(route.details).toEqual({ type: 'route', ids: ['JFK-XYZ'] });
  });

  it('answers 400 VALIDATION_ERROR for a malformed query', async (context) => {
    if (!client) return context.skip();
    expect((await failure('type=airline&ids=AA', 400)).code).toBe('VALIDATION_ERROR');
    expect((await failure('type=airport&ids=JFK,JFK', 400)).message).toBe('JFK is listed twice');
    expect((await failure('type=airline&ids=AA,DL&sort=x', 400)).code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/analytics/compare without a database', () => {
  it('answers 503 DATABASE_UNAVAILABLE without leaking driver details', async () => {
    const down = createApp({
      pingMongo: async () => false,
      cacheTtlMs: 0,
      getDb: () => {
        throw new MongoNetworkError('connect ECONNREFUSED 127.0.0.1:27017');
      },
    });
    const response = await request(down).get('/api/analytics/compare?type=airline&ids=AA,DL');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is unavailable' },
    });
  });
});
