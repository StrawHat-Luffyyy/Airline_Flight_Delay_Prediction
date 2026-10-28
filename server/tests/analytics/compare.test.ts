import { describe, expect, it } from 'vitest';
import { CompareQuerySchema, CompareResponseSchema, type CompareQuery } from '@flight-delay/shared';
import {
  assembleComparison,
  compareMonthlyPipeline,
  compareTotalsPipeline,
  type MonthlyRow,
  type TotalsRow,
} from '../../src/analytics/compare.js';

const parse = (query: Record<string, string>) => CompareQuerySchema.safeParse(query);

function issues(query: Record<string, string>): string[] {
  const result = parse(query);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('CompareQuerySchema', () => {
  it('splits ids, keeps their order and defaults minFlights to 500', () => {
    expect(CompareQuerySchema.parse({ type: 'airline', ids: 'DL, AA' })).toEqual({
      type: 'airline',
      ids: ['DL', 'AA'],
      minFlights: 500,
    });
    expect(
      CompareQuerySchema.parse({ type: 'route', ids: 'JFK-LAX,ATL-JFK', minFlights: '10' }),
    ).toMatchObject({ ids: ['JFK-LAX', 'ATL-JFK'], minFlights: 10 });
  });

  it('needs two to four entities', () => {
    expect(issues({ type: 'airline', ids: 'AA' })).toEqual(['ids needs at least 2 entities']);
    expect(issues({ type: 'airline', ids: 'AA,DL,UA,WN,B6' })).toEqual([
      'ids allows at most 4 entities',
    ]);
    expect(parse({ type: 'airline', ids: 'AA,DL,UA,WN' }).success).toBe(true);
  });

  it('checks every id against the format of its type', () => {
    expect(issues({ type: 'airline', ids: 'AA,JFK' })).toEqual([
      'JFK must be a 2-character IATA airline code',
    ]);
    expect(issues({ type: 'airport', ids: 'jfk,LAX' })).toEqual([
      'jfk must be a 3-character IATA airport code',
    ]);
    expect(issues({ type: 'route', ids: 'JFK-LAX,JFKLAX' })).toEqual([
      'JFKLAX must look like JFK-LAX',
    ]);
    expect(issues({ type: 'route', ids: 'JFK-LAX,ATL-ATL' })).toEqual([
      'ATL-ATL must join two different airports',
    ]);
    expect(issues({ type: 'airline', ids: 'AA,' })).toEqual([
      'An empty id must be a 2-character IATA airline code',
    ]);
  });

  it('rejects duplicates, unknown types and unknown keys', () => {
    expect(issues({ type: 'airline', ids: 'AA,AA' })).toEqual(['AA is listed twice']);
    expect(parse({ type: 'planet', ids: 'AA,DL' }).success).toBe(false);
    expect(parse({ type: 'airline', ids: 'AA,DL', id: 'UA' }).success).toBe(false);
    expect(parse({ ids: 'AA,DL' }).success).toBe(false);
    expect(parse({ type: 'airline', ids: 'AA,DL', minFlights: '0' }).success).toBe(false);
  });
});

describe('compare read pipelines', () => {
  const airline: CompareQuery = { type: 'airline', ids: ['AA', 'DL'], minFlights: 500 };

  it('match the requested ids first, on the indexed key of each stats collection', () => {
    expect(compareTotalsPipeline(airline).collection).toBe('stats_daily');
    expect(compareTotalsPipeline(airline).pipeline[0]).toEqual({
      $match: { airline: { $in: ['AA', 'DL'] } },
    });
    const airport = { ...airline, type: 'airport' as const, ids: ['JFK', 'ATL'] };
    expect(compareTotalsPipeline(airport).collection).toBe('stats_airport_hour');
    expect(compareMonthlyPipeline(airport)?.collection).toBe('stats_daily_origin');
    expect(compareMonthlyPipeline(airport)?.pipeline[0]).toEqual({
      $match: { origin: { $in: ['JFK', 'ATL'] } },
    });
    const route = { ...airline, type: 'route' as const, ids: ['JFK-LAX', 'ATL-JFK'] };
    expect(compareTotalsPipeline(route).collection).toBe('stats_route');
    expect(compareTotalsPipeline(route).pipeline[0]).toEqual({
      $match: { _id: { $in: ['JFK-LAX', 'ATL-JFK'] } },
    });
  });

  it('has no monthly or cause source for routes', () => {
    const route: CompareQuery = { type: 'route', ids: ['JFK-LAX', 'ATL-JFK'], minFlights: 1 };
    expect(compareMonthlyPipeline(route)).toBeNull();
    expect(JSON.stringify(compareTotalsPipeline(route).pipeline)).not.toContain('causeMinutes');
  });

  it('sums stored counts and derives rates from the sums, never averaging stored rates', () => {
    const text = JSON.stringify(compareTotalsPipeline(airline).pipeline);
    expect(text).toContain('{"$sum":"$completed"}');
    expect(text).toContain('{"$divide":["$delayed","$completed"]}');
    expect(text).not.toContain('$avg');
    expect(text).not.toContain('"$sum":"$delayRate"');
  });
});

// ---------- Assembly (pure) ----------

const describeId = (id: string) => ({ label: `Label ${id}`, detail: null });

function totals(key: string, sums: Partial<TotalsRow> = {}): TotalsRow {
  const base = {
    key,
    flights: 0,
    completed: 0,
    delayed: 0,
    cancelled: 0,
    diverted: 0,
    delayRate: null,
    avgArrDelay: null,
    cancelRate: null,
    divertRate: null,
    causes: null,
  };
  return { ...base, ...sums };
}

function assemble(
  query: CompareQuery,
  rows: TotalsRow[],
  monthly: MonthlyRow[] | null = query.type === 'route' ? null : [],
) {
  return CompareResponseSchema.parse(
    assembleComparison({ query, totals: rows, monthly, describe: describeId, coverage: null }),
  );
}

describe('assembleComparison', () => {
  const query: CompareQuery = { type: 'airline', ids: ['AA', 'DL', 'UA'], minFlights: 100 };

  it('keeps the requested order and measures differences from the first entity', () => {
    const body = assemble(query, [
      // Returned in a different order than requested.
      totals('DL', {
        flights: 1000,
        completed: 900,
        delayed: 90,
        cancelled: 80,
        diverted: 20,
        delayRate: 0.1,
        avgArrDelay: -2,
        cancelRate: 0.08,
        divertRate: 0.02,
      }),
      totals('AA', {
        flights: 800,
        completed: 760,
        delayed: 152,
        cancelled: 32,
        diverted: 8,
        delayRate: 0.2,
        avgArrDelay: 6.5,
        cancelRate: 0.04,
        divertRate: 0.01,
      }),
      totals('UA', {
        flights: 400,
        completed: 380,
        delayed: 76,
        cancelled: 16,
        diverted: 4,
        delayRate: 0.2,
        avgArrDelay: 6.5,
        cancelRate: 0.04,
        divertRate: 0.01,
      }),
    ]);
    expect(body.baselineId).toBe('AA');
    expect(body.entities.map((e) => e.id)).toEqual(['AA', 'DL', 'UA']);
    expect(body.entities[0]?.differences).toBeNull();
    const dl = body.entities[1]?.differences;
    expect(dl).toMatchObject({ flights: 200, completed: 140, delayed: -62, cancelled: 48 });
    expect(dl?.diverted).toBe(12);
    expect(dl?.delayRate).toBeCloseTo(-0.1);
    expect(dl?.avgArrDelay).toBeCloseTo(-8.5);
    expect(dl?.cancelRate).toBeCloseTo(0.04);
    expect(dl?.divertRate).toBeCloseTo(0.01);
    // UA ties AA on every rate: the differences are exactly zero.
    expect(body.entities[2]?.differences).toMatchObject({
      delayRate: 0,
      avgArrDelay: 0,
      cancelRate: 0,
      divertRate: 0,
    });
  });

  it('names every tied entity as a leader and the lowest value otherwise', () => {
    const body = assemble(query, [
      totals('AA', {
        flights: 500,
        completed: 300,
        delayRate: 1 / 3,
        avgArrDelay: 4,
        cancelRate: 0.1,
        divertRate: 0,
      }),
      totals('DL', {
        flights: 600,
        completed: 600,
        delayRate: 2 / 6,
        avgArrDelay: -1,
        cancelRate: 0,
        divertRate: 0,
      }),
      totals('UA', {
        flights: 700,
        completed: 700,
        delayRate: 0.5,
        avgArrDelay: 9,
        cancelRate: 0,
        divertRate: 0.01,
      }),
    ]);
    expect(body.leaders).toEqual({
      delayRate: ['AA', 'DL'],
      avgArrDelay: ['DL'],
      cancelRate: ['DL', 'UA'],
      divertRate: ['AA', 'DL'],
    });
  });

  it('flags low and empty samples, keeps them out of the leaders, and leaves their rates null', () => {
    const body = assemble(query, [
      totals('AA', {
        flights: 500,
        completed: 500,
        delayed: 50,
        delayRate: 0.1,
        avgArrDelay: 1,
        cancelRate: 0,
        divertRate: 0,
      }),
      // 99 flights < minFlights 100, but its lower rate must not win.
      totals('DL', {
        flights: 99,
        completed: 99,
        delayed: 0,
        delayRate: 0,
        avgArrDelay: -5,
        cancelRate: 0,
        divertRate: 0,
      }),
      // UA has no stats document at all.
    ]);
    expect(body.entities.map((e) => e.sample)).toEqual(['ok', 'low', 'none']);
    const ua = body.entities[2];
    expect(ua?.totals).toEqual({
      flights: 0,
      completed: 0,
      delayed: 0,
      delayRate: null,
      avgArrDelay: null,
      cancelled: 0,
      cancelRate: null,
      diverted: 0,
      divertRate: null,
    });
    expect(ua?.differences).toMatchObject({ flights: -500, delayRate: null, avgArrDelay: null });
    // Only AA has an ok sample, so there is nobody to compare it with.
    expect(body.leaders).toEqual({
      delayRate: [],
      avgArrDelay: [],
      cancelRate: [],
      divertRate: [],
    });
  });

  it('fills twelve months per entity, with null rates where a month has no flights', () => {
    const monthly: MonthlyRow[] = [
      {
        key: 'AA',
        month: 1,
        flights: 10,
        completed: 8,
        delayed: 2,
        delayRate: 0.25,
        avgArrDelay: 3,
        cancelRate: 0.2,
      },
      {
        key: 'AA',
        month: 3,
        flights: 5,
        completed: 5,
        delayed: 0,
        delayRate: 0,
        avgArrDelay: -4,
        cancelRate: 0,
      },
    ];
    const body = assemble({ ...query, ids: ['AA', 'DL'] }, [totals('AA'), totals('DL')], monthly);
    const aa = body.entities[0]?.monthly;
    expect(aa?.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(aa?.[0]).toMatchObject({ flights: 10, delayRate: 0.25 });
    expect(aa?.[1]).toEqual({
      month: 2,
      flights: 0,
      completed: 0,
      delayed: 0,
      delayRate: null,
      avgArrDelay: null,
      cancelRate: null,
    });
    expect(body.entities[1]?.monthly?.every((m) => m.flights === 0)).toBe(true);
    expect(body.availability).toEqual({ causes: null, monthly: null });
  });

  it('says why routes have no causes or monthly series', () => {
    const body = assemble({ type: 'route', ids: ['JFK-LAX', 'ATL-JFK'], minFlights: 1 }, [
      totals('JFK-LAX', {
        flights: 3,
        completed: 3,
        delayRate: 0,
        avgArrDelay: 0,
        cancelRate: 0,
        divertRate: 0,
      }),
      totals('ATL-JFK', {
        flights: 3,
        completed: 3,
        delayRate: 0,
        avgArrDelay: 0,
        cancelRate: 0,
        divertRate: 0,
      }),
    ]);
    expect(body.entities.every((e) => e.causes === null && e.monthly === null)).toBe(true);
    expect(body.availability.causes).toMatch(/not pre-aggregated by route/);
    expect(body.availability.monthly).toMatch(/not pre-aggregated by route/);
  });

  it('gives an entity with no stats row empty cause totals when the type has causes', () => {
    const body = assemble({ ...query, ids: ['AA', 'DL'] }, [totals('AA')]);
    expect(body.entities[1]?.causes).toEqual({
      flightsWithCauses: 0,
      totalMinutes: 0,
      minutes: { carrier: 0, weather: 0, nas: 0, security: 0, lateAircraft: 0 },
      shares: { carrier: null, weather: null, nas: null, security: null, lateAircraft: null },
    });
  });
});
