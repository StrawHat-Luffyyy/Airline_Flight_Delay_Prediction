import type { Collection, Db } from 'mongodb';

export type CancellationReason = 'A' | 'B' | 'C' | 'D';
export type Split = 'train' | 'test';

export interface DelayCauses {
  carrier: number | null;
  weather: number | null;
  nas: number | null;
  security: number | null;
  lateAircraft: number | null;
}

/** One flight, denormalized (PROJECT_OVERVIEW §6.1). `_id` is assigned by MongoDB. */
export interface FlightDoc {
  date: Date;
  year: number;
  month: number;
  day: number;
  /** 1 = Monday ... 7 = Sunday. */
  dayOfWeek: number;
  airline: string;
  airlineName: string;
  flightNumber: number;
  tailNumber: string | null;
  origin: string;
  /** False when the source used a numeric BTS airport id instead of an IATA code (§3). */
  originIsIata: boolean;
  /** Raw 5-digit BTS airport id from the source when it had no IATA code; null otherwise. Never overwritten. */
  originAirportId: string | null;
  /** True when `origin` was derived from `originAirportId` by resolve:airport-ids. */
  originIataDerived: boolean;
  originCity: string | null;
  originState: string | null;
  dest: string;
  destIsIata: boolean;
  destAirportId: string | null;
  destIataDerived: boolean;
  destCity: string | null;
  destState: string | null;
  route: string;
  schedDepMin: number;
  schedDepHour: number;
  schedArrMin: number;
  distance: number;
  scheduledTime: number | null;
  depDelay: number | null;
  arrDelay: number | null;
  taxiOut: number | null;
  taxiIn: number | null;
  airTime: number | null;
  elapsedTime: number | null;
  cancelled: boolean;
  cancellationReason: CancellationReason | null;
  diverted: boolean;
  /** arrDelay >= 15; null when cancelled, diverted or arrival delay unknown. */
  isDelayed: boolean | null;
  /** Minutes per cause; null when the source reported no causes. */
  causes: DelayCauses | null;
  split: Split;
}

export interface AirlineDoc {
  _id: string;
  name: string;
}

export interface AirportDoc {
  _id: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface IngestRunDoc {
  startedAt: Date;
  finishedAt: Date;
  file: string;
  status: 'completed' | 'failed';
  mode: 'drop' | 'append' | 'fresh';
  rowsRead: number;
  rowsInserted: number;
  rowsRejected: number;
  rejectReasons: Record<string, number>;
  peakRssMb: number;
  error?: string;
}

/** One run of resolve:airport-ids (PROJECT_OVERVIEW has no spec; modelled on ingest_runs). */
export interface ResolveRunDoc {
  startedAt: Date;
  finishedAt: Date;
  status: 'completed' | 'failed';
  mode: 'dry-run' | 'apply';
  thresholds: { minVotes: number; minTopShare: number };
  referenceMonths: number[];
  referenceRows: number;
  referenceKeys: number;
  ambiguousKeys: number;
  rowsWithNumericIds: number;
  rowsMatched: number;
  distinctIds: number;
  mappedIds: number;
  unmappedIds: string[];
  /** Rows (with any numeric id) whose origin and dest are both IATA after the mapping. */
  rowsFullyResolved: number;
  rowsOriginResolved: number;
  rowsDestResolved: number;
  /** Documents actually modified by this run (0 for a dry run or an unchanged re-apply). */
  rowsUpdated: number;
  peakRssMb: number;
  error?: string;
}

export const collections = {
  flights: (db: Db): Collection<FlightDoc> => db.collection<FlightDoc>('flights'),
  airlines: (db: Db): Collection<AirlineDoc> => db.collection<AirlineDoc>('airlines'),
  airports: (db: Db): Collection<AirportDoc> => db.collection<AirportDoc>('airports'),
  ingestRuns: (db: Db): Collection<IngestRunDoc> => db.collection<IngestRunDoc>('ingest_runs'),
  resolveRuns: (db: Db): Collection<ResolveRunDoc> => db.collection<ResolveRunDoc>('resolve_runs'),
};
