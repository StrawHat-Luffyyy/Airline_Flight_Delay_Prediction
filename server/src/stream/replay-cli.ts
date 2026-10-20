/**
 * `npm run stream:replay -- [--month 12] [--rate N] [--limit N]`: replays one month of flights.csv
 * into Kafka (PROJECT_OVERVIEW §15.5) with an idempotent producer, and records the run in
 * stream_stats. Reads airlines and airports from MongoDB; writes only stream_stats.
 */
import { randomUUID } from 'node:crypto';
import { collections, type StreamRunDoc } from '../db/collections.js';
import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import type { ReferenceData } from '../ingest/transform.js';
import { logger } from '../logger.js';
import { createKafka, topicNames } from './kafka.js';
import { createReplaySummary, replayMonth, type EventSink, type ReplaySummary } from './replay.js';
import { parseReplayArgs } from './replay-args.js';

const PROGRESS_EVERY_EVENTS = 25_000;

async function loadReferenceData(): Promise<ReferenceData> {
  const db = getDb();
  const [airlines, airports] = await Promise.all([
    collections.airlines(db).find({}).toArray(),
    collections.airports(db).find({}).toArray(),
  ]);
  if (airlines.length === 0 || airports.length === 0) {
    throw new Error('airlines/airports are empty. Run `npm run ingest -- --reference-only` first.');
  }
  return {
    airlines: new Map(airlines.map((doc) => [doc._id, doc.name])),
    airports: new Map(airports.map((doc) => [doc._id, { city: doc.city, state: doc.state }])),
  };
}

function runDoc(
  runId: string,
  args: ReturnType<typeof parseReplayArgs>,
  startedAt: Date,
  summary: ReplaySummary | null,
  status: StreamRunDoc['status'],
  error?: unknown,
): StreamRunDoc {
  const elapsedMs = summary?.elapsedMs ?? 0;
  const sendElapsedMs = summary?.sendElapsedMs ?? 0;
  const sentRaw = summary?.sentRaw ?? 0;
  return {
    _id: `producer-run:${runId}`,
    kind: 'producer-run',
    runId,
    status,
    month: args.month,
    rate: args.rate,
    limit: args.limit ?? null,
    startedAt,
    finishedAt: status === 'running' ? null : new Date(),
    rowsScanned: summary?.rowsScanned ?? 0,
    monthRows: summary?.monthRows ?? 0,
    sentRaw,
    sentDlq: summary?.sentDlq ?? 0,
    dlqReasons: summary?.dlqReasons ?? {},
    malformedCsv: summary?.malformedCsv ?? 0,
    elapsedMs: Math.round(elapsedMs),
    sendElapsedMs: Math.round(sendElapsedMs),
    achievedRate: sendElapsedMs > 0 ? Math.round((sentRaw / sendElapsedMs) * 1000) : 0,
    peakRssMb: summary?.peakRssMb ?? 0,
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.message : String(error) }),
  };
}

async function main(): Promise<void> {
  const args = parseReplayArgs(process.argv.slice(2));
  const runId = `replay-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date();

  await connectToMongo();
  const refs = await loadReferenceData();

  // Idempotent producer: librdkafka de-duplicates broker-side retries, so a retried batch can
  // never be written twice. Idempotence requires acks = all (-1) and at most 5 in-flight requests.
  const producer = createKafka().producer({
    kafkaJS: { idempotent: true, acks: -1, maxInFlightRequests: 5 },
  });
  // Connected before the run is recorded, so a broker that is down never leaves a "running" doc.
  await producer.connect();
  const sink: EventSink = {
    async send(topic, messages) {
      await producer.send({
        topic,
        messages: messages.map((m) => ({ key: m.key, value: m.value })),
      });
    },
  };

  const stats = collections.streamStats(getDb());
  // Owned here and updated in place, so a failed run records what the broker did acknowledge.
  const summary = createReplaySummary(runId);
  // Ctrl+C stops reading, flushes the current batch and records the run as interrupted.
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let nextProgressAt = PROGRESS_EVERY_EVENTS;
  logger.info({ runId, ...args, topics: topicNames() }, 'stream:replay started');
  try {
    await stats.insertOne(runDoc(runId, args, startedAt, null, 'running'));
    await replayMonth(args, {
      sink,
      refs,
      topics: topicNames(),
      runId,
      summary,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.sentRaw + progress.sentDlq < nextProgressAt) return;
        nextProgressAt += PROGRESS_EVERY_EVENTS;
        logger.info(
          {
            sentRaw: progress.sentRaw,
            sentDlq: progress.sentDlq,
            rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
          'stream:replay progress',
        );
      },
    });
    const status = summary.interrupted ? 'interrupted' : 'completed';
    const doc = runDoc(runId, args, startedAt, summary, status);
    await stats.replaceOne({ _id: doc._id }, doc);
    logger.info(
      {
        runId,
        status,
        rowsScanned: doc.rowsScanned,
        monthRows: doc.monthRows,
        sentRaw: doc.sentRaw,
        sentDlq: doc.sentDlq,
        dlqReasons: doc.dlqReasons,
        malformedCsv: doc.malformedCsv,
        elapsedMs: doc.elapsedMs,
        sendElapsedMs: doc.sendElapsedMs,
        achievedRate: doc.achievedRate,
        peakRssMb: doc.peakRssMb,
      },
      'stream:replay finished',
    );
  } catch (error) {
    const doc = runDoc(runId, args, startedAt, summary, 'failed', error);
    await stats.replaceOne({ _id: doc._id }, doc, { upsert: true }).catch(() => undefined);
    throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await producer.disconnect();
  }
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'stream:replay failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
