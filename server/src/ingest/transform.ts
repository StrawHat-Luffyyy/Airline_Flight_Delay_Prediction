import { z } from 'zod';
import type { CancellationReason, DelayCauses, FlightDoc } from '../db/collections.js';
import { parseHhmm } from './hhmm.js';

export interface AirportRef {
  city: string | null;
  state: string | null;
}

export interface ReferenceData {
  /** IATA code -> airline name. */
  airlines: ReadonlyMap<string, string>;
  /** IATA code -> location. */
  airports: ReadonlyMap<string, AirportRef>;
}

export type RejectReason =
  | 'missing_columns'
  | 'invalid_date'
  | 'unknown_airline'
  | 'invalid_flight_number'
  | 'invalid_airport'
  | 'invalid_scheduled_departure'
  | 'invalid_scheduled_arrival'
  | 'invalid_distance'
  | 'invalid_number'
  | 'invalid_flag'
  | 'invalid_cancellation_reason';

export type TransformResult = { ok: true; doc: FlightDoc } | { ok: false; reason: RejectReason };

/** Source columns the transform reads (`flights.csv`, UPPER_SNAKE_CASE). Extra columns are ignored. */
const RawFlightRowSchema = z.object({
  YEAR: z.string(),
  MONTH: z.string(),
  DAY: z.string(),
  AIRLINE: z.string(),
  FLIGHT_NUMBER: z.string(),
  TAIL_NUMBER: z.string(),
  ORIGIN_AIRPORT: z.string(),
  DESTINATION_AIRPORT: z.string(),
  SCHEDULED_DEPARTURE: z.string(),
  DEPARTURE_DELAY: z.string(),
  TAXI_OUT: z.string(),
  SCHEDULED_TIME: z.string(),
  ELAPSED_TIME: z.string(),
  AIR_TIME: z.string(),
  DISTANCE: z.string(),
  TAXI_IN: z.string(),
  SCHEDULED_ARRIVAL: z.string(),
  ARRIVAL_DELAY: z.string(),
  DIVERTED: z.string(),
  CANCELLED: z.string(),
  CANCELLATION_REASON: z.string(),
  AIR_SYSTEM_DELAY: z.string(),
  SECURITY_DELAY: z.string(),
  AIRLINE_DELAY: z.string(),
  LATE_AIRCRAFT_DELAY: z.string(),
  WEATHER_DELAY: z.string(),
});

export const REQUIRED_FLIGHT_COLUMNS: readonly string[] = Object.keys(RawFlightRowSchema.shape);

const DELAYED_THRESHOLD_MINUTES = 15;
const LAST_TRAIN_MONTH = 9;
const IATA_CODE = /^[A-Z0-9]{3}$/;
const BTS_AIRPORT_ID = /^\d{5}$/;
const CANCELLATION_REASONS: ReadonlySet<string> = new Set(['A', 'B', 'C', 'D']);

class Rejected extends Error {
  constructor(readonly reason: RejectReason) {
    super(reason);
  }
}

/** Blank -> null; otherwise a finite number or the row is rejected. */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new Rejected('invalid_number');
  return parsed;
}

function requiredNumber(value: string, reason: RejectReason): number {
  const trimmed = value.trim();
  const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(parsed)) throw new Rejected(reason);
  return parsed;
}

function flag(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '0' || trimmed === '') return false;
  if (trimmed === '1') return true;
  throw new Rejected('invalid_flag');
}

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!valid) throw new Rejected('invalid_date');
  return date;
}

function airportCode(value: string): { code: string; isIata: boolean } {
  const code = value.trim();
  if (IATA_CODE.test(code)) return { code, isIata: true };
  if (BTS_AIRPORT_ID.test(code)) return { code, isIata: false };
  throw new Rejected('invalid_airport');
}

function cancellationReason(value: string): CancellationReason | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!CANCELLATION_REASONS.has(trimmed)) throw new Rejected('invalid_cancellation_reason');
  return trimmed as CancellationReason;
}

function delayCauses(row: z.infer<typeof RawFlightRowSchema>): DelayCauses | null {
  const causes: DelayCauses = {
    carrier: numberOrNull(row.AIRLINE_DELAY),
    weather: numberOrNull(row.WEATHER_DELAY),
    nas: numberOrNull(row.AIR_SYSTEM_DELAY),
    security: numberOrNull(row.SECURITY_DELAY),
    lateAircraft: numberOrNull(row.LATE_AIRCRAFT_DELAY),
  };
  return Object.values(causes).every((minutes) => minutes === null) ? null : causes;
}

function buildDoc(row: z.infer<typeof RawFlightRowSchema>, refs: ReferenceData): FlightDoc {
  const year = requiredNumber(row.YEAR, 'invalid_date');
  const month = requiredNumber(row.MONTH, 'invalid_date');
  const day = requiredNumber(row.DAY, 'invalid_date');
  const date = utcDate(year, month, day);

  const airline = row.AIRLINE.trim();
  const airlineName = refs.airlines.get(airline);
  if (airlineName === undefined) throw new Rejected('unknown_airline');

  const flightNumber = requiredNumber(row.FLIGHT_NUMBER, 'invalid_flight_number');
  if (!Number.isInteger(flightNumber) || flightNumber <= 0) {
    throw new Rejected('invalid_flight_number');
  }

  const origin = airportCode(row.ORIGIN_AIRPORT);
  const dest = airportCode(row.DESTINATION_AIRPORT);
  const originRef = refs.airports.get(origin.code);
  const destRef = refs.airports.get(dest.code);

  const schedDep = parseHhmm(row.SCHEDULED_DEPARTURE);
  if (!schedDep) throw new Rejected('invalid_scheduled_departure');
  const schedArr = parseHhmm(row.SCHEDULED_ARRIVAL);
  if (!schedArr) throw new Rejected('invalid_scheduled_arrival');

  const distance = requiredNumber(row.DISTANCE, 'invalid_distance');
  if (distance <= 0) throw new Rejected('invalid_distance');

  const cancelled = flag(row.CANCELLED);
  const diverted = flag(row.DIVERTED);
  const arrDelay = numberOrNull(row.ARRIVAL_DELAY);
  const isDelayed =
    cancelled || diverted || arrDelay === null ? null : arrDelay >= DELAYED_THRESHOLD_MINUTES;
  const tailNumber = row.TAIL_NUMBER.trim();

  return {
    date,
    year,
    month,
    day,
    dayOfWeek: date.getUTCDay() === 0 ? 7 : date.getUTCDay(),
    airline,
    airlineName,
    flightNumber,
    tailNumber: tailNumber === '' ? null : tailNumber,
    origin: origin.code,
    originIsIata: origin.isIata,
    originCity: originRef?.city ?? null,
    originState: originRef?.state ?? null,
    dest: dest.code,
    destIsIata: dest.isIata,
    destCity: destRef?.city ?? null,
    destState: destRef?.state ?? null,
    route: `${origin.code}-${dest.code}`,
    schedDepMin: schedDep.minutes,
    schedDepHour: schedDep.hour,
    schedArrMin: schedArr.minutes,
    distance,
    scheduledTime: numberOrNull(row.SCHEDULED_TIME),
    depDelay: numberOrNull(row.DEPARTURE_DELAY),
    arrDelay,
    taxiOut: numberOrNull(row.TAXI_OUT),
    taxiIn: numberOrNull(row.TAXI_IN),
    airTime: numberOrNull(row.AIR_TIME),
    elapsedTime: numberOrNull(row.ELAPSED_TIME),
    cancelled,
    cancellationReason: cancellationReason(row.CANCELLATION_REASON),
    diverted,
    isDelayed,
    causes: delayCauses(row),
    split: month <= LAST_TRAIN_MONTH ? 'train' : 'test',
  };
}

/** Pure: one raw CSV row -> a flight document or a reject reason. Never throws for bad data. */
export function transformFlightRow(raw: unknown, refs: ReferenceData): TransformResult {
  const parsed = RawFlightRowSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'missing_columns' };

  try {
    return { ok: true, doc: buildDoc(parsed.data, refs) };
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, reason: error.reason };
    throw error;
  }
}
