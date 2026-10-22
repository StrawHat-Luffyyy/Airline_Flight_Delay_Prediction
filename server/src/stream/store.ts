/**
 * The speed layer's MongoDB storage (PROJECT_OVERVIEW §15.6). Phase 8 writes only `stream_flights`
 * and `stream_stats`; the batch collections (flights, stats_*, delay_lookup, model_runs) are never
 * touched from here.
 */
import type { FlightEvent, FlightOutcome, PreDeparture } from '@flight-delay/shared';
import type { AnyBulkWriteOperation, Collection, Db } from 'mongodb';
import type { WriteResult } from './consume.js';
import type { ScoreResult } from './score.js';
import { HEARTBEAT_TTL_SECONDS } from './status/state.js';

/** The live score stored with a flight (the /api/predict response, minus its explanation). */
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
  /**
   * Prediction vs outcome, set once at scoring: null when unscored or when the flight has no
   * arrival outcome (cancelled or diverted). Flights stored before live scoring get it from
   * `npm run stream:score-missing`.
   */
  correct: boolean | null;
  /** When the producer sent it (the event's producedAt). */
  producedAt: Date;
  /** When the consumer first wrote it: end-to-end latency is firstWrittenAt - producedAt. */
  firstWrittenAt: Date;
  lastWrittenAt: Date;
  /** How many times it was delivered: above 1 means a redelivery or a repeated replay. */
  deliveries: number;
}

/** The consumer's own row in stream_stats: liveness and running counters for /stream/status. */
export interface StreamConsumerDoc {
  _id: string;
  kind: 'consumer';
  groupId: string;
  instanceId: string;
  status: 'running' | 'stopped' | 'failed';
  startedAt: Date;
  lastSeenAt: Date;
  /** Messages read from flights.raw by this process. */
  consumed: number;
  /** Flights stored for the first time. */
  inserted: number;
  /** Deliveries of flights already stored (redelivery or a repeated replay). */
  redelivered: number;
  /** Messages this process sent to the DLQ. */
  dlq: number;
  batches: number;
  /** Messages per second over the last heartbeat interval. */
  throughput: number;
  /**
   * When this process last finished a batch; the process start until the first one, so a consumer
   * that cannot start on a backlog is reported as stalled too. Progress, not liveness.
   */
  lastBatchAt?: Date;
  error?: string;
}

export function streamConsumers(db: Db): Collection<StreamConsumerDoc> {
  return db.collection<StreamConsumerDoc>('stream_stats');
}

export const STREAM_FLIGHTS = 'stream_flights';

export function streamFlights(db: Db): Collection<StreamFlightDoc> {
  return db.collection<StreamFlightDoc>(STREAM_FLIGHTS);
}

/**
 * Replay order for the rolling window: newest first, `_id` breaking ties (a whole batch shares one
 * firstWrittenAt), so the window boundary is deterministic and needs no in-memory sort.
 */
export const WINDOW_INDEX = { firstWrittenAt: -1, _id: -1 } as const;
/** Confusion-matrix and scored/refused counts as COUNT_SCANs, without reading documents. */
export const COUNTS_INDEX = {
  'prediction.modelVersion': 1,
  'prediction.threshold': 1,
  'prediction.label': 1,
  'outcome.isDelayed': 1,
  scoreError: 1,
} as const;
/** Superseded by WINDOW_INDEX (same leading key, plus the tie-break). */
const LEGACY_WINDOW_INDEX = 'firstWrittenAt_-1';

/**
 * stream_flights: replay-order window, per-run counts and the status counts. stream_stats: a TTL on
 * heartbeat lastSeenAt (producer-run documents have no lastSeenAt, so they never expire).
 * createIndexes is idempotent.
 */
export async function ensureStreamIndexes(db: Db): Promise<void> {
  const flights = streamFlights(db);
  await flights.createIndexes([
    { key: WINDOW_INDEX, name: 'firstWrittenAt_-1__id_-1' },
    { key: { runId: 1 }, name: 'runId_1' },
    { key: COUNTS_INDEX, name: 'stream_totals' },
  ]);
  if (await flights.indexExists(LEGACY_WINDOW_INDEX)) await flights.dropIndex(LEGACY_WINDOW_INDEX);
  await db
    .collection('stream_stats')
    .createIndex(
      { lastSeenAt: 1 },
      { name: 'lastSeenAt_ttl', expireAfterSeconds: HEARTBEAT_TTL_SECONDS },
    );
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
  /** Live scores by flight key, written with the first insert; absent = not scored. */
  scores: ReadonlyMap<string, ScoreResult> = new Map(),
): Promise<WriteResult> {
  const operations: AnyBulkWriteOperation<StreamFlightDoc>[] = events.map((event) => {
    const score = scores.get(event.key);
    return {
      updateOne: {
        filter: { _id: event.key },
        update: {
          $setOnInsert: {
            runId: event.runId,
            pre: event.pre,
            outcome: event.outcome,
            prediction: score?.prediction ?? null,
            scoreError: score?.scoreError ?? null,
            correct: score?.correct ?? null,
            producedAt: new Date(event.producedAt),
            firstWrittenAt: now,
          },
          $set: { lastRunId: event.runId, lastWrittenAt: now },
          $inc: { deliveries: 1 },
        },
        upsert: true,
      },
    };
  });
  // Ordered, so two deliveries of one flight in a batch apply in sequence (insert, then update).
  const result = await collection.bulkWrite(operations, { ordered: true });
  return { inserted: result.upsertedCount, redelivered: events.length - result.upsertedCount };
}

/** The flight keys among `keys` that are already stored (so their redelivery is not re-scored). */
export async function findStoredKeys(
  collection: Collection<StreamFlightDoc>,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const found = await collection
    .find({ _id: { $in: [...new Set(keys)] } }, { projection: { _id: 1 } })
    .toArray();
  return new Set(found.map((doc) => doc._id));
}
