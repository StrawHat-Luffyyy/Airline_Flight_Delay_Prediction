/**
 * The speed layer's MongoDB storage (PROJECT_OVERVIEW §15.6). Phase 8 writes only `stream_flights`
 * and `stream_stats`; the batch collections (flights, stats_*, delay_lookup, model_runs) are never
 * touched from here.
 */
import type { FlightEvent, FlightOutcome, PreDeparture } from '@flight-delay/shared';
import type { AnyBulkWriteOperation, Collection, Db } from 'mongodb';
import type { WriteResult } from './consume.js';

/** Filled in by live scoring (8d). */
export interface StoredPrediction {
  probability: number;
  label: 'delayed' | 'on-time';
  threshold: number;
  modelVersion: string;
}

export interface StreamFlightDoc {
  /** The deterministic flight key: date|airline|flightNumber|origin|schedDepMin. */
  _id: string;
  /** The replay run that first delivered this flight. */
  runId: string;
  /** The replay run that delivered it most recently. */
  lastRunId: string;
  pre: PreDeparture;
  outcome: FlightOutcome;
  prediction: StoredPrediction | null;
  /** Why scoring failed (e.g. an unknown route); null when scored or not yet scored. */
  scoreError: string | null;
  /** When the producer sent it (the event's producedAt). */
  producedAt: Date;
  /** When the consumer first wrote it: end-to-end latency is firstWrittenAt - producedAt. */
  firstWrittenAt: Date;
  lastWrittenAt: Date;
  /** How many times it was delivered: above 1 means a redelivery or a repeated replay. */
  deliveries: number;
}

export const STREAM_FLIGHTS = 'stream_flights';

export function streamFlights(db: Db): Collection<StreamFlightDoc> {
  return db.collection<StreamFlightDoc>(STREAM_FLIGHTS);
}

/** Recent-first reads for rolling metrics, and per-run counts. createIndex is idempotent. */
export async function ensureStreamIndexes(db: Db): Promise<void> {
  await streamFlights(db).createIndexes([
    { key: { firstWrittenAt: -1 }, name: 'firstWrittenAt_-1' },
    { key: { runId: 1 }, name: 'runId_1' },
  ]);
}

/**
 * One upsert per event, keyed by `_id = key`. The first delivery inserts the event; later ones
 * (redelivery after a crash, a repeated replay) only bump `deliveries` and the last-seen fields,
 * so the stored event, its first write time and any prediction never change.
 */
export async function upsertEvents(
  collection: Collection<StreamFlightDoc>,
  events: readonly FlightEvent[],
  now: Date,
): Promise<WriteResult> {
  const operations: AnyBulkWriteOperation<StreamFlightDoc>[] = events.map((event) => ({
    updateOne: {
      filter: { _id: event.key },
      update: {
        $setOnInsert: {
          runId: event.runId,
          pre: event.pre,
          outcome: event.outcome,
          prediction: null,
          scoreError: null,
          producedAt: new Date(event.producedAt),
          firstWrittenAt: now,
        },
        $set: { lastRunId: event.runId, lastWrittenAt: now },
        $inc: { deliveries: 1 },
      },
      upsert: true,
    },
  }));
  // Ordered, so two deliveries of one flight in a batch apply in sequence (insert, then update).
  const result = await collection.bulkWrite(operations, { ordered: true });
  return { inserted: result.upsertedCount, redelivered: events.length - result.upsertedCount };
}
