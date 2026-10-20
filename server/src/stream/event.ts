import { flightKey, type FlightEvent, type PreDeparture } from '@flight-delay/shared';
import type { FlightDoc } from '../db/collections.js';

/**
 * A transformed flight (from the ingest transformer, so parsing is never duplicated) as a stream
 * event. `pre` is built field by field from the pre-departure columns only; everything that
 * happened after departure goes to `outcome`.
 */
export function toFlightEvent(doc: FlightDoc, runId: string, producedAt: number): FlightEvent {
  const pre: PreDeparture = {
    date: doc.date.toISOString().slice(0, 10),
    airline: doc.airline,
    flightNumber: doc.flightNumber,
    origin: doc.origin,
    dest: doc.dest,
    schedDepMin: doc.schedDepMin,
    schedDepHour: doc.schedDepHour,
  };
  return {
    v: 1,
    key: flightKey(pre),
    runId,
    producedAt,
    pre,
    outcome: {
      depDelay: doc.depDelay,
      arrDelay: doc.arrDelay,
      isDelayed: doc.isDelayed,
      cancelled: doc.cancelled,
      diverted: doc.diverted,
    },
  };
}
