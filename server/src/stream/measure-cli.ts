/**
 * `npm run stream:measure -- [--run RUN_ID] [--out FILE]`: measures one replay run (the newest by
 * default) for docs/STREAMING.md: conservation, unique keys, consumer lag, throughput and end-to-end
 * latency. Run it once the consumer has caught up. `--out` also writes the full report as JSON, as
 * evidence. Read-only: it changes nothing in MongoDB or Kafka.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { collections } from '../db/collections.js';
import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { ADMIN_TIMEOUT_MS, consumerGroup, createKafka, topicNames } from './kafka.js';
import { checkRun, parseMeasureArgs, runStatsPipeline, type RunReport } from './measure.js';
import { computeLag } from './status/kafka-probe.js';
import { streamFlights } from './store.js';

/**
 * The aggregate rows, validated: a document without producedAt would make `latency` null, and a
 * non-Date field would break toISOString, so they fail here with a clear message instead.
 */
const RunStatsSchema = z.object({
  flights: z.number().int(),
  firstProducedAt: z.date(),
  lastProducedAt: z.date(),
  firstWrittenAt: z.date(),
  lastWrittenAt: z.date(),
  latency: z.tuple([z.number(), z.number(), z.number()]),
  latencyMin: z.number(),
  latencyMax: z.number(),
  latencyMean: z.number(),
});

const TotalsSchema = z.object({
  flights: z.number().int(),
  deliveries: z.number().int(),
  scored: z.number().int(),
  refused: z.number().int(),
});

const retained = (offsets: ReadonlyArray<{ high: string; low: string }>) =>
  offsets.reduce((sum, p) => sum + Number(p.high) - Number(p.low), 0);

async function main(): Promise<void> {
  const args = parseMeasureArgs(process.argv.slice(2));
  await connectToMongo();
  const db = getDb();
  // stream_stats is small (one document per producer run and per consumer process).
  const runs = await collections
    .streamStats(db)
    .find({ kind: 'producer-run' })
    .sort({ startedAt: -1 })
    .toArray();
  const run = args.runId === undefined ? runs[0] : runs.find((r) => r.runId === args.runId);
  if (run === undefined) throw new Error('No producer run found. Run npm run stream:replay first.');

  const flights = streamFlights(db);
  const [statsRow] = await flights.aggregate(runStatsPipeline(run.runId)).toArray();
  const stats = statsRow === undefined ? undefined : RunStatsSchema.parse(statsRow);
  const [totalsRow] = await flights
    .aggregate([
      {
        $group: {
          _id: null,
          flights: { $sum: 1 },
          deliveries: { $sum: '$deliveries' },
          scored: { $sum: { $cond: [{ $ne: ['$prediction', null] }, 1, 0] } },
          refused: { $sum: { $cond: [{ $ne: ['$scoreError', null] }, 1, 0] } },
        },
      },
    ])
    .toArray();
  const totals = totalsRow === undefined ? undefined : TotalsSchema.parse(totalsRow);

  const admin = createKafka().admin();
  let kafka: RunReport['kafka'];
  try {
    await admin.connect();
    const { raw, dlq } = topicNames();
    const [rawEnds, dlqEnds, committed] = await Promise.all([
      admin.fetchTopicOffsets(raw, { timeout: ADMIN_TIMEOUT_MS, isolationLevel: 0 }),
      admin.fetchTopicOffsets(dlq, { timeout: ADMIN_TIMEOUT_MS, isolationLevel: 0 }),
      admin.fetchOffsets({ groupId: consumerGroup(), topics: [raw], timeout: ADMIN_TIMEOUT_MS }),
    ]);
    const rawCommitted = committed.find((t) => t.topic === raw)?.partitions ?? [];
    kafka = {
      rawRetained: retained(rawEnds),
      dlqRetained: retained(dlqEnds),
      lag: computeLag(rawCommitted, rawEnds).total,
    };
  } finally {
    await admin.disconnect().catch(() => undefined);
  }

  const report: RunReport = {
    runId: run.runId,
    producer: {
      status: run.status,
      rate: run.rate,
      limit: run.limit,
      monthRows: run.monthRows,
      sentRaw: run.sentRaw,
      sentDlq: run.sentDlq,
      malformedCsv: run.malformedCsv,
      sendElapsedMs: run.sendElapsedMs,
      achievedRate: run.achievedRate,
      elapsedMs: run.elapsedMs,
      peakRssMb: run.peakRssMb,
    },
    kafka,
    stored: {
      flights: totals?.flights ?? 0,
      flightsOfRun: stats?.flights ?? 0,
      deliveries: totals?.deliveries ?? 0,
      scored: totals?.scored ?? 0,
      refused: totals?.refused ?? 0,
    },
    timing:
      stats === undefined
        ? null
        : {
            firstProducedAt: stats.firstProducedAt.toISOString(),
            lastProducedAt: stats.lastProducedAt.toISOString(),
            firstWrittenAt: stats.firstWrittenAt.toISOString(),
            lastWrittenAt: stats.lastWrittenAt.toISOString(),
            consumerSpanMs: stats.lastWrittenAt.getTime() - stats.firstWrittenAt.getTime(),
            consumerRate:
              stats.flights < 2
                ? null
                : Math.round(
                    stats.flights /
                      Math.max(
                        0.001,
                        (stats.lastWrittenAt.getTime() - stats.firstWrittenAt.getTime()) / 1000,
                      ),
                  ),
            endToEndMs: stats.lastWrittenAt.getTime() - stats.firstProducedAt.getTime(),
            latencyMs: {
              p50: Math.round(stats.latency[0]),
              p95: Math.round(stats.latency[1]),
              p99: Math.round(stats.latency[2]),
              min: stats.latencyMin,
              max: stats.latencyMax,
              mean: Math.round(stats.latencyMean),
            },
          },
    sinceReset: {
      producerRuns: runs.length,
      sentRaw: runs.reduce((sum, r) => sum + r.sentRaw, 0),
      sentDlq: runs.reduce((sum, r) => sum + r.sentDlq, 0),
      largestRun: Math.max(0, ...runs.map((r) => r.sentRaw)),
    },
  };
  const checks = checkRun(report);
  for (const check of checks) logger.info(check, check.ok ? 'PASS' : 'FAIL');
  logger.info({ report }, 'stream:measure report');
  if (args.out !== undefined) {
    // npm runs workspace scripts from server/; resolve against where the command was typed.
    const out = resolve(process.env.INIT_CWD ?? process.cwd(), args.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify({ report, checks }, null, 2)}\n`);
    logger.info({ out }, 'stream:measure wrote the report');
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'stream:measure failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
