import { DlqMessageSchema, FlightEventSchema, flightKey } from '@flight-delay/shared';
import { describe, expect, it } from 'vitest';
import { transformFlightRow, type ReferenceData } from '../../src/ingest/transform.js';
import { toFlightEvent } from '../../src/stream/event.js';

const refs: ReferenceData = {
  airlines: new Map([['AA', 'American Airlines Inc.']]),
  airports: new Map([
    ['ORD', { city: 'Chicago', state: 'IL' }],
    ['LAX', { city: 'Los Angeles', state: 'CA' }],
  ]),
};

/** A completed, delayed December flight, as flights.csv spells it. */
function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    YEAR: '2015',
    MONTH: '12',
    DAY: '21',
    DAY_OF_WEEK: '1',
    AIRLINE: 'AA',
    FLIGHT_NUMBER: '1234',
    TAIL_NUMBER: 'N123AA',
    ORIGIN_AIRPORT: 'ORD',
    DESTINATION_AIRPORT: 'LAX',
    SCHEDULED_DEPARTURE: '1730',
    DEPARTURE_TIME: '1755',
    DEPARTURE_DELAY: '25',
    TAXI_OUT: '18',
    WHEELS_OFF: '1813',
    SCHEDULED_TIME: '275',
    ELAPSED_TIME: '280',
    AIR_TIME: '250',
    DISTANCE: '1744',
    WHEELS_ON: '2023',
    TAXI_IN: '12',
    SCHEDULED_ARRIVAL: '2005',
    ARRIVAL_TIME: '2035',
    ARRIVAL_DELAY: '30',
    DIVERTED: '0',
    CANCELLED: '0',
    CANCELLATION_REASON: '',
    AIR_SYSTEM_DELAY: '5',
    SECURITY_DELAY: '0',
    AIRLINE_DELAY: '25',
    LATE_AIRCRAFT_DELAY: '0',
    WEATHER_DELAY: '0',
    ...overrides,
  };
}

function docFor(overrides: Record<string, string> = {}) {
  const result = transformFlightRow(row(overrides), refs);
  if (!result.ok) throw new Error(`fixture rejected: ${result.reason}`);
  return result.doc;
}

describe('flightKey', () => {
  const pre = {
    date: '2015-12-21',
    airline: 'AA',
    flightNumber: 1234,
    origin: 'ORD',
    dest: 'LAX',
    schedDepMin: 1050,
    schedDepHour: 17,
  };

  it('is date|airline|flightNumber|origin|schedDepMin', () => {
    expect(flightKey(pre)).toBe('2015-12-21|AA|1234|ORD|1050');
  });

  it('is deterministic and ignores fields outside the key (dest, hour)', () => {
    expect(flightKey({ ...pre })).toBe(flightKey(pre));
    const elsewhere = { ...pre, dest: 'SFO', schedDepHour: 3 };
    expect(flightKey(elsewhere)).toBe(flightKey(pre));
  });

  it('changes when any key field changes', () => {
    const base = flightKey(pre);
    for (const change of [
      { date: '2015-12-22' },
      { airline: 'UA' },
      { flightNumber: 1235 },
      { origin: 'MDW' },
      { schedDepMin: 1051 },
    ]) {
      expect(flightKey({ ...pre, ...change })).not.toBe(base);
    }
  });
});

describe('toFlightEvent', () => {
  it('splits a transformed flight into strict pre-departure fields and the outcome', () => {
    const event = toFlightEvent(docFor(), 'run-1', 1_700_000_000_000);
    expect(event).toEqual({
      v: 1,
      key: '2015-12-21|AA|1234|ORD|1050',
      runId: 'run-1',
      producedAt: 1_700_000_000_000,
      pre: {
        date: '2015-12-21',
        airline: 'AA',
        flightNumber: 1234,
        origin: 'ORD',
        dest: 'LAX',
        schedDepMin: 1050,
        schedDepHour: 17,
      },
      outcome: { depDelay: 25, arrDelay: 30, isDelayed: true, cancelled: false, diverted: false },
    });
    expect(FlightEventSchema.parse(event)).toEqual(event);
  });

  it('carries no post-departure field in `pre`', () => {
    const { pre } = toFlightEvent(docFor(), 'run-1', 1);
    for (const leak of ['depDelay', 'arrDelay', 'taxiOut', 'taxiIn', 'airTime', 'elapsedTime']) {
      expect(pre).not.toHaveProperty(leak);
    }
    for (const leak of ['causes', 'cancelled', 'diverted', 'isDelayed']) {
      expect(pre).not.toHaveProperty(leak);
    }
  });

  it('keeps a cancelled flight with a null outcome delay', () => {
    const event = toFlightEvent(
      docFor({ CANCELLED: '1', CANCELLATION_REASON: 'B', ARRIVAL_DELAY: '', DEPARTURE_DELAY: '' }),
      'run-1',
      1,
    );
    expect(event.outcome).toEqual({
      depDelay: null,
      arrDelay: null,
      isDelayed: null,
      cancelled: true,
      diverted: false,
    });
  });
});

describe('FlightEventSchema', () => {
  const valid = toFlightEvent(docFor(), 'run-1', 1);

  it('rejects an unknown version, an extra field, or an outcome field inside pre', () => {
    expect(FlightEventSchema.safeParse({ ...valid, v: 2 }).success).toBe(false);
    expect(FlightEventSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(
      FlightEventSchema.safeParse({ ...valid, pre: { ...valid.pre, arrDelay: 30 } }).success,
    ).toBe(false);
  });

  it('rejects a key that does not match the pre-departure fields', () => {
    expect(FlightEventSchema.safeParse({ ...valid, key: 'forged' }).success).toBe(false);
  });

  it('rejects out-of-range times and malformed codes', () => {
    const bad = (pre: Partial<typeof valid.pre>) =>
      FlightEventSchema.safeParse({ ...valid, pre: { ...valid.pre, ...pre } }).success;
    expect(bad({ schedDepMin: 1440 })).toBe(false);
    expect(bad({ schedDepHour: 24 })).toBe(false);
    expect(bad({ origin: 'or' })).toBe(false);
    expect(bad({ date: '2015-13-01' })).toBe(false);
  });
});

describe('DlqMessageSchema', () => {
  it('accepts a producer reject carrying the raw CSV row and its reason', () => {
    const message = {
      v: 1,
      source: 'producer',
      reason: 'invalid_airport',
      runId: 'run-1',
      at: 1,
      row: { YEAR: '2015', MONTH: '12' },
    };
    expect(DlqMessageSchema.parse(message)).toEqual(message);
  });

  it('accepts a consumer reject carrying its Kafka coordinates', () => {
    const message = {
      v: 1,
      source: 'consumer',
      reason: 'invalid_event: pre.origin',
      at: 1,
      topic: 'flights.raw',
      partition: 2,
      offset: '41',
      value: '{"v":1}',
    };
    expect(DlqMessageSchema.parse(message)).toEqual(message);
  });
});
