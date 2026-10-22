/**
 * The §15.9 measurements for one replay run (`npm run stream:measure`): conservation, unique keys,
 * throughput and end-to-end latency, from the producer-run record, Kafka offsets and stream_flights.
 * Meant to be run after `npm run stream:reset`, so the topics and collections hold only the runs
 * being measured. The checks are pure, so they are unit-tested without a broker or database.
 */
import { parseArgs } from 'node:util';
import type { Document } from 'mongodb';

/** One run's flights, through the runId index: counts, time span and latency percentiles. */
export function runStatsPipeline(runId: string): Document[] {
  const latency = { $subtract: ['$firstWrittenAt', '$producedAt'] };
  return [
    { $match: { runId } },
    {
      $group: {
        _id: null,
        flights: { $sum: 1 },
        firstProducedAt: { $min: '$producedAt' },
        lastProducedAt: { $max: '$producedAt' },
        firstWrittenAt: { $min: '$firstWrittenAt' },
        lastWrittenAt: { $max: '$firstWrittenAt' },
        // MongoDB 7.0 $percentile; "approximate" is the only method it offers (t-digest).
        latency: { $percentile: { input: latency, p: [0.5, 0.95, 0.99], method: 'approximate' } },
        latencyMin: { $min: latency },
        latencyMax: { $max: latency },
        latencyMean: { $avg: latency },
      },
    },
  ];
}

export interface RunReport {
  runId: string;
  producer: {
    status: string;
    rate: number;
    limit: number | null;
    /** Rows of the replayed month read from the CSV. */
    monthRows: number;
    sentRaw: number;
    sentDlq: number;
    malformedCsv: number;
    sendElapsedMs: number;
    /** sentRaw per second of the send phase. */
    achievedRate: number;
    /** The whole run, including reading the earlier months of the file. */
    elapsedMs: number;
    peakRssMb: number;
  };
  kafka: {
    /** Messages on flights.raw (end minus start offsets): everything sent since the reset. */
    rawRetained: number;
    dlqRetained: number;
    /** The consumer group's total lag on flights.raw. */
    lag: number;
  };
  stored: {
    /** Every document in stream_flights. */
    flights: number;
    /** Documents first delivered by this run. */
    flightsOfRun: number;
    /** Sum of `deliveries`: one per upsert, so one per message the consumer stored. */
    deliveries: number;
    scored: number;
    refused: number;
  };
  /** Null when the run stored nothing new (a repeated replay). */
  timing: {
    firstProducedAt: string;
    lastProducedAt: string;
    firstWrittenAt: string;
    lastWrittenAt: string;
    /** First write to last write of this run's flights. */
    consumerSpanMs: number;
    /** flightsOfRun per second of consumerSpanMs; null for fewer than 2 flights. */
    consumerRate: number | null;
    /** First send to last write. */
    endToEndMs: number;
    latencyMs: { p50: number; p95: number; p99: number; min: number; max: number; mean: number };
  } | null;
  /** Every producer run since the reset (stream_stats is cleared by it). */
  sinceReset: {
    producerRuns: number;
    sentRaw: number;
    sentDlq: number;
    /**
     * The largest run's sentRaw. Every run replays a prefix of the same month, whose keys are all
     * distinct (December: 479,230 rows and 479,230 keys, 8b), so this is the distinct keys produced.
     */
    largestRun: number;
  };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const fmt = (value: number) => value.toLocaleString('en-US');

export function checkRun(report: RunReport): Check[] {
  const { producer, kafka, stored, sinceReset } = report;
  const consumerDlq = kafka.dlqRetained - sinceReset.sentDlq;
  return [
    {
      name: 'month rows = sent to raw + producer DLQ',
      ok: producer.monthRows === producer.sentRaw + producer.sentDlq,
      detail: `${fmt(producer.monthRows)} = ${fmt(producer.sentRaw)} + ${fmt(producer.sentDlq)}`,
    },
    {
      name: 'raw topic holds exactly what was sent',
      ok: kafka.rawRetained === sinceReset.sentRaw,
      detail: `${fmt(kafka.rawRetained)} on flights.raw, ${fmt(sinceReset.sentRaw)} sent in ${sinceReset.producerRuns} run(s)`,
    },
    {
      // At-least-once: a crash between write and commit redelivers, so upserts may exceed messages
      // (and could hide a lost one); the unique-key check below is what catches a lost message.
      // consumerDlq = DLQ messages minus the producer's: both write flights.dlq, and stream:reset
      // empties both topics and stream_stats, so the subtraction covers exactly the runs measured.
      name: 'raw messages = upserts + consumer DLQ',
      ok: stored.deliveries + consumerDlq >= kafka.rawRetained && consumerDlq >= 0,
      detail: `${fmt(kafka.rawRetained)} messages; ${fmt(stored.deliveries)} upserts + ${fmt(consumerDlq)} consumer DLQ`,
    },
    uniqueKeys(report, consumerDlq),
    {
      name: 'consumer lag = 0',
      ok: kafka.lag === 0,
      detail: `${fmt(kafka.lag)} messages behind`,
    },
    {
      name: 'redeliveries (information)',
      ok: true,
      detail: `${fmt(Math.max(0, stored.deliveries + consumerDlq - kafka.rawRetained))} upserts beyond the messages on the topic`,
    },
  ];
}

function uniqueKeys({ stored, sinceReset }: RunReport, consumerDlq: number): Check {
  const name = 'stored flights = distinct keys produced';
  // Overlapping runs dead-letter a shared bad row once per run, so the DLQ count no longer equals
  // distinct bad keys: the exact expectation cannot be derived from counts alone.
  if (sinceReset.producerRuns > 1 && consumerDlq > 0) {
    return {
      name,
      ok: stored.flights <= sinceReset.largestRun,
      detail: `n/a exactly: ${fmt(consumerDlq)} DLQ messages over ${sinceReset.producerRuns} overlapping runs; ${fmt(stored.flights)} stored of ${fmt(sinceReset.largestRun)} distinct keys`,
    };
  }
  return {
    name,
    ok: stored.flights === sinceReset.largestRun - consumerDlq,
    detail: `${fmt(stored.flights)} stored, ${fmt(sinceReset.largestRun)} distinct keys sent, ${fmt(consumerDlq)} dead-lettered`,
  };
}

const MEASURE_USAGE = 'Usage: npm run stream:measure -- [--run RUN_ID] [--out FILE]';

/** Strict: unknown flags, and a flag where a value belongs, are errors. */
export function parseMeasureArgs(argv: readonly string[]): { runId?: string; out?: string } {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { run: { type: 'string' }, out: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    return {
      ...(values.run === undefined ? {} : { runId: values.run }),
      ...(values.out === undefined ? {} : { out: values.out }),
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}. ${MEASURE_USAGE}`);
  }
}
