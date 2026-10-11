import { describe, expect, it } from 'vitest';
import { transformFlightRow, type ReferenceData } from '../../src/ingest/transform.js';

const refs: ReferenceData = {
  airlines: new Map([['AA', 'American Airlines Inc.']]),
  airports: new Map([
    ['JFK', { city: 'New York', state: 'NY' }],
    ['LAX', { city: 'Los Angeles', state: 'CA' }],
  ]),
};

/** A delayed, completed flight on Thursday 2015-01-01 with every column populated. */
function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    YEAR: '2015',
    MONTH: '1',
    DAY: '1',
    DAY_OF_WEEK: '4',
    AIRLINE: 'AA',
    FLIGHT_NUMBER: '98',
    TAIL_NUMBER: 'N407AS',
    ORIGIN_AIRPORT: 'JFK',
    DESTINATION_AIRPORT: 'LAX',
    SCHEDULED_DEPARTURE: '0005',
    DEPARTURE_TIME: '2354',
    DEPARTURE_DELAY: '-11',
    TAXI_OUT: '21',
    WHEELS_OFF: '0015',
    SCHEDULED_TIME: '205',
    ELAPSED_TIME: '194',
    AIR_TIME: '169',
    DISTANCE: '1448',
    WHEELS_ON: '0404',
    TAXI_IN: '4',
    SCHEDULED_ARRIVAL: '0430',
    ARRIVAL_TIME: '0408',
    ARRIVAL_DELAY: '20',
    DIVERTED: '0',
    CANCELLED: '0',
    CANCELLATION_REASON: '',
    AIR_SYSTEM_DELAY: '0',
    SECURITY_DELAY: '',
    AIRLINE_DELAY: '5',
    LATE_AIRCRAFT_DELAY: '15',
    WEATHER_DELAY: '0',
    ...overrides,
  };
}

function accepted(input: Record<string, string>) {
  const result = transformFlightRow(input, refs);
  if (!result.ok) throw new Error(`expected accept, got reject: ${result.reason}`);
  return result.doc;
}

function rejectReason(input: Record<string, string>): string {
  const result = transformFlightRow(input, refs);
  if (result.ok) throw new Error('expected reject, got accept');
  return result.reason;
}

describe('transformFlightRow', () => {
  it('maps a complete row to a denormalized flight document', () => {
    expect(accepted(row())).toEqual({
      date: new Date(Date.UTC(2015, 0, 1)),
      year: 2015,
      month: 1,
      day: 1,
      dayOfWeek: 4,
      airline: 'AA',
      airlineName: 'American Airlines Inc.',
      flightNumber: 98,
      tailNumber: 'N407AS',
      origin: 'JFK',
      originIsIata: true,
      originCity: 'New York',
      originState: 'NY',
      dest: 'LAX',
      destIsIata: true,
      destCity: 'Los Angeles',
      destState: 'CA',
      route: 'JFK-LAX',
      schedDepMin: 5,
      schedDepHour: 0,
      schedArrMin: 270,
      distance: 1448,
      scheduledTime: 205,
      depDelay: -11,
      arrDelay: 20,
      taxiOut: 21,
      taxiIn: 4,
      airTime: 169,
      elapsedTime: 194,
      cancelled: false,
      cancellationReason: null,
      diverted: false,
      isDelayed: true,
      causes: { carrier: 5, weather: 0, nas: 0, security: null, lateAircraft: 15 },
      split: 'train',
    });
  });

  it('stores blank cause columns as null causes, not zeros', () => {
    const doc = accepted(
      row({
        ARRIVAL_DELAY: '3',
        AIR_SYSTEM_DELAY: '',
        SECURITY_DELAY: '',
        AIRLINE_DELAY: '',
        LATE_AIRCRAFT_DELAY: '',
        WEATHER_DELAY: '',
      }),
    );
    expect(doc.causes).toBeNull();
    expect(doc.isDelayed).toBe(false);
  });

  it('treats an arrival delay of exactly 15 minutes as delayed', () => {
    expect(accepted(row({ ARRIVAL_DELAY: '15' })).isDelayed).toBe(true);
    expect(accepted(row({ ARRIVAL_DELAY: '14' })).isDelayed).toBe(false);
  });

  it('handles a cancelled flight: null delays, reason kept, isDelayed null', () => {
    const doc = accepted(
      row({
        CANCELLED: '1',
        CANCELLATION_REASON: 'B',
        DEPARTURE_TIME: '',
        DEPARTURE_DELAY: '',
        TAXI_OUT: '',
        ELAPSED_TIME: '',
        AIR_TIME: '',
        TAXI_IN: '',
        ARRIVAL_TIME: '',
        ARRIVAL_DELAY: '',
        AIR_SYSTEM_DELAY: '',
        AIRLINE_DELAY: '',
        LATE_AIRCRAFT_DELAY: '',
        WEATHER_DELAY: '',
      }),
    );
    expect(doc).toMatchObject({
      cancelled: true,
      cancellationReason: 'B',
      depDelay: null,
      arrDelay: null,
      taxiOut: null,
      airTime: null,
      isDelayed: null,
      causes: null,
    });
  });

  it('sets isDelayed to null for diverted flights even when a delay is present', () => {
    const doc = accepted(row({ DIVERTED: '1', ARRIVAL_DELAY: '' }));
    expect(doc.diverted).toBe(true);
    expect(doc.isDelayed).toBeNull();
  });

  it('flags numeric BTS airport ids instead of rejecting them', () => {
    const doc = accepted(row({ ORIGIN_AIRPORT: '12478', DESTINATION_AIRPORT: '12892' }));
    expect(doc).toMatchObject({
      origin: '12478',
      originIsIata: false,
      originCity: null,
      dest: '12892',
      destIsIata: false,
      destState: null,
      route: '12478-12892',
    });
  });

  it('keeps unknown IATA airports with null city and state', () => {
    expect(accepted(row({ ORIGIN_AIRPORT: 'XYZ' }))).toMatchObject({
      origin: 'XYZ',
      originIsIata: true,
      originCity: null,
      originState: null,
    });
  });

  it('converts 2400 schedule times and blank tail numbers', () => {
    const doc = accepted(row({ SCHEDULED_DEPARTURE: '2400', TAIL_NUMBER: '' }));
    expect(doc.schedDepMin).toBe(0);
    expect(doc.schedDepHour).toBe(0);
    expect(doc.tailNumber).toBeNull();
  });

  it('tags January-September as train and October-December as test', () => {
    expect(accepted(row({ MONTH: '9', DAY: '30' })).split).toBe('train');
    expect(accepted(row({ MONTH: '10', DAY: '1' })).split).toBe('test');
    expect(accepted(row({ MONTH: '12', DAY: '31' })).split).toBe('test');
  });

  it('derives dayOfWeek from the date (1 = Monday, 7 = Sunday)', () => {
    expect(accepted(row({ DAY: '5' })).dayOfWeek).toBe(1); // 2015-01-05 was a Monday
    expect(accepted(row({ DAY: '4' })).dayOfWeek).toBe(7); // 2015-01-04 was a Sunday
  });

  it('rejects rows that cannot be placed or keyed, with a reason', () => {
    expect(rejectReason(row({ MONTH: '13' }))).toBe('invalid_date');
    expect(rejectReason(row({ MONTH: '2', DAY: '30' }))).toBe('invalid_date');
    expect(rejectReason(row({ AIRLINE: 'ZZ' }))).toBe('unknown_airline');
    expect(rejectReason(row({ FLIGHT_NUMBER: '' }))).toBe('invalid_flight_number');
    expect(rejectReason(row({ ORIGIN_AIRPORT: '' }))).toBe('invalid_airport');
    expect(rejectReason(row({ SCHEDULED_DEPARTURE: '2460' }))).toBe('invalid_scheduled_departure');
    expect(rejectReason(row({ SCHEDULED_ARRIVAL: '' }))).toBe('invalid_scheduled_arrival');
    expect(rejectReason(row({ DISTANCE: 'abc' }))).toBe('invalid_distance');
    expect(rejectReason(row({ ARRIVAL_DELAY: 'n/a' }))).toBe('invalid_number');
    expect(rejectReason(row({ CANCELLATION_REASON: 'E', CANCELLED: '1' }))).toBe(
      'invalid_cancellation_reason',
    );
  });

  it('rejects rows missing required columns', () => {
    const { DISTANCE: _omitted, ...missing } = row();
    void _omitted;
    expect(rejectReason(missing)).toBe('missing_columns');
  });
});
