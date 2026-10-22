/**
 * The speed-layer consumer (PROJECT_OVERVIEW §15.6): a consumer group on flights.raw that, per
 * batch, upserts the events into stream_flights, dead-letters malformed messages, and only then
 * commits the batch's offset (manual commits, at-least-once; idempotent upserts make the stored
 * result effectively-once). Shared by `stream:consume` and `stream:smoke`.
 */
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { DlqMessage } from '@flight-delay/shared';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import { handleBatch } from './consume.js';
import { scoreEvents, type Predictor } from './score.js';
import { HEARTBEAT_INTERVAL_MS } from './status/state.js';
import {
  ensureStreamIndexes,
  findStoredKeys,
  streamConsumers,
  streamFlights,
  upsertEvents,
  type StreamConsumerDoc,
} from './store.js';

/** Events per eachBatch call (the client's default is 32). */
const MAX_BATCH = 500;
const MAX_BACKOFF_MS = 30_000;

/** Thrown inside a batch whose partition was reassigned before its commit. */
class StaleBatch extends Error {}

export interface ConsumerOptions {
  kafka: KafkaJS.Kafka;
  db: Db;
  topics: { raw: string; dlq: string };
  groupId: string;
  instanceId: string;
  logger: Logger;
  /** Live scoring: predictDelay bound to the loaded model (§15.7). */
  predict: Predictor;
  /** Group session timeout in ms (KAFKA_SESSION_TIMEOUT_MS); absent = the client's default (30 s). */
  sessionTimeoutMs?: number;
}

export interface ConsumerCounters {
  consumed: number;
  inserted: number;
  redelivered: number;
  dlq: number;
  batches: number;
}

export interface RunningConsumer {
  counters: ConsumerCounters;
  /** Epoch ms of the last processed batch (or the start). */
  lastBatchAt(): number;
  /** Graceful: finishes the in-flight batch, commits, disconnects, records "stopped". */
  stop(): Promise<void>;
}

export async function startConsumer(options: ConsumerOptions): Promise<RunningConsumer> {
  const { kafka, db, topics, groupId, instanceId, logger, predict, sessionTimeoutMs } = options;
  await ensureStreamIndexes(db);
  const flights = streamFlights(db);
  const stats = streamConsumers(db);
  const counters: ConsumerCounters = {
    consumed: 0,
    inserted: 0,
    redelivered: 0,
    dlq: 0,
    batches: 0,
  };
  const startedAt = new Date();
  let lastBatchAt = Date.now();

  // Malformed messages go to the DLQ through an idempotent producer, awaited before the commit.
  const dlqProducer = kafka.producer({
    kafkaJS: { idempotent: true, acks: -1, maxInFlightRequests: 5 },
  });
  const consumer = kafka.consumer({
    kafkaJS: {
      groupId,
      fromBeginning: true,
      autoCommit: false,
      ...(sessionTimeoutMs === undefined ? {} : { sessionTimeout: sessionTimeoutMs }),
    },
    'js.consumer.max.batch.size': MAX_BATCH,
  });

  const heartbeatDoc = (
    status: StreamConsumerDoc['status'],
    throughput: number,
    error?: string,
  ) => ({
    _id: `consumer:${groupId}:${instanceId}`,
    kind: 'consumer' as const,
    groupId,
    instanceId,
    status,
    startedAt,
    lastSeenAt: new Date(),
    lastBatchAt: new Date(lastBatchAt),
    ...counters,
    throughput,
    ...(error === undefined ? {} : { error }),
  });
  let lastConsumed = 0;
  let lastBeatAt = Date.now();
  /** Set while batches keep failing; reported as status "failed" until a batch succeeds. */
  let lastError: string | undefined;
  let backoffMs = 0;
  let stopped = false;
  let inFlightBeat: Promise<void> = Promise.resolve();

  const beat = (status: StreamConsumerDoc['status'], error?: string): Promise<void> => {
    const now = Date.now();
    const seconds = Math.max(0.001, (now - lastBeatAt) / 1000);
    const throughput = Math.round((counters.consumed - lastConsumed) / seconds);
    lastConsumed = counters.consumed;
    lastBeatAt = now;
    const doc = heartbeatDoc(status, throughput, error);
    inFlightBeat = stats.replaceOne({ _id: doc._id }, doc, { upsert: true }).then(() => undefined);
    return inFlightBeat;
  };
  const periodicBeat = () => {
    if (stopped) return;
    beat(lastError === undefined ? 'running' : 'failed', lastError).catch((error: unknown) =>
      logger.warn({ err: error }, 'heartbeat failed'),
    );
  };

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    await dlqProducer.connect();
    await consumer.connect();
    await consumer.subscribe({ topics: [topics.raw] });
    await beat('running');
    heartbeat = setInterval(periodicBeat, HEARTBEAT_INTERVAL_MS);

    await consumer.run({
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: 3,
      eachBatch: async ({ batch, resolveOffset, isRunning, isStale }) => {
        // A stale batch (its partition was reassigned) is left alone: the new owner reads it.
        if (!isRunning() || isStale() || batch.messages.length === 0) return;
        let result;
        try {
          result = await handleBatch(
            batch.messages,
            { topic: batch.topic, partition: batch.partition, now: Date.now() },
            {
              write: async (events) => {
                // Score only flights not stored yet: a redelivery never re-scores, and a stored
                // prediction never changes.
                const stored = await findStoredKeys(
                  flights,
                  events.map((event) => event.key),
                );
                const scores = await scoreEvents(
                  events.filter((event) => !stored.has(event.key)),
                  predict,
                );
                return upsertEvents(
                  flights,
                  events,
                  new Date(),
                  new Map(scores.map((score) => [score.key, score])),
                );
              },
              sendDlq: async (messages: readonly DlqMessage[]) => {
                await dlqProducer.send({
                  topic: topics.dlq,
                  messages: messages.map((message) => ({
                    key: null,
                    value: JSON.stringify(message),
                  })),
                });
              },
              commit: async (nextOffset) => {
                // Reassigned mid-batch: do not commit for a partition we no longer own. The write
                // already happened; the new owner re-reads the batch and the upserts absorb it.
                if (isStale()) throw new StaleBatch();
                await consumer.commitOffsets([
                  { topic: batch.topic, partition: batch.partition, offset: nextOffset },
                ]);
                // Marked processed only once committed, so a failed commit seeks back cleanly.
                resolveOffset(batch.lastOffset());
              },
            },
          );
        } catch (error) {
          if (error instanceof StaleBatch) return;
          // Nothing was committed, so the client seeks back and redelivers this batch. Back off
          // first (1 s doubling to 30 s) instead of refetching in a tight loop while MongoDB or
          // the broker is down, and report the consumer as failed until a batch succeeds.
          lastError = error instanceof Error ? error.message : String(error);
          backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(1_000, backoffMs * 2));
          logger.error(
            { err: error, topic: batch.topic, partition: batch.partition, backoffMs },
            'batch failed; it will be redelivered',
          );
          periodicBeat();
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          throw error;
        }
        lastError = undefined;
        backoffMs = 0;
        // Per-process observations; the authoritative totals are stream_flights and Kafka offsets.
        counters.consumed += result.consumed;
        counters.inserted += result.inserted;
        counters.redelivered += result.redelivered;
        counters.dlq += result.dlq;
        counters.batches += 1;
        lastBatchAt = Date.now();
      },
    });
  } catch (error) {
    // Startup failed: release everything, so the process can exit, and say why.
    stopped = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    await Promise.allSettled([consumer.disconnect(), dlqProducer.disconnect()]);
    await inFlightBeat.catch(() => undefined);
    await beat('failed', error instanceof Error ? error.message : String(error)).catch(
      () => undefined,
    );
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
    counters,
    lastBatchAt: () => lastBatchAt,
    stop() {
      stopping ??= (async () => {
        stopped = true;
        clearInterval(heartbeat);
        // disconnect() lets the in-flight batch finish (and commit) before leaving the group.
        await consumer.disconnect();
        await dlqProducer.disconnect();
        // A periodic beat still in flight must not land after (and overwrite) "stopped".
        await inFlightBeat.catch(() => undefined);
        await beat('stopped');
        logger.info({ ...counters }, 'stream:consume stopped');
      })();
      return stopping;
    },
  };
}
