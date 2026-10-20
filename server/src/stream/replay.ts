/**
 * The Phase 8 replay producer (PROJECT_OVERVIEW §15.5): streams flights.csv, keeps one month,
 * parses each row with the ingest transformer (never a second parser), and sends events to
 * flights.raw (key = origin) or the reject to flights.dlq with its reason. Memory stays bounded:
 * at most one send batch is held at a time.
 */
import type { DlqMessage } from '@flight-delay/shared';
import { z } from 'zod';
import type { FlightDoc } from '../db/collections.js';
import { csvRows, DEFAULT_DATA_DIR, requireFile } from '../ingest/run.js';
import { RssMonitor } from '../ingest/rss.js';
import {
  REQUIRED_FLIGHT_COLUMNS,
  transformFlightRow,
  type ReferenceData,
} from '../ingest/transform.js';
import { toFlightEvent } from './event.js';
import { createPacer, systemClock, type Clock } from './pacer.js';
import type { ReplayArgs } from './replay-args.js';

export interface OutboundMessage {
  /** Partition key; null lets Kafka spread the message (DLQ entries without a row). */
  key: string | null;
  value: string;
}

/** The slice of a Kafka producer the replay needs; resolves once the broker acknowledged. */
export interface EventSink {
  send(topic: string, messages: readonly OutboundMessage[]): Promise<void>;
}

export interface ReplayDeps {
  sink: EventSink;
  refs: ReferenceData;
  topics: { raw: string; dlq: string };
  runId: string;
  clock?: Clock;
  /** Epoch ms for `producedAt` (injected for tests). */
  epochNow?: () => number;
  signal?: AbortSignal;
  /** Called after every flushed batch (progress logging). */
  onProgress?: (summary: ReplaySummary) => void;
  /**
   * Caller-owned counters (see createReplaySummary). Updated in place, so after a failed send the
   * caller still knows exactly what the broker had acknowledged.
   */
  summary?: ReplaySummary;
}

export interface ReplaySummary {
  runId: string;
  rowsScanned: number;
  monthRows: number;
  sentRaw: number;
  sentDlq: number;
  dlqReasons: Record<string, number>;
  malformedCsv: number;
  /** Whole run, including reading past the earlier months of the file. */
  elapsedMs: number;
  /** From the first row of the month to the last acknowledged send: the replay itself. */
  sendElapsedMs: number;
  peakRssMb: number;
  interrupted: boolean;
}

/** Events per send: small enough to pace smoothly, large enough to batch well. */
const MAX_BATCH = 500;
const MonthField = z.object({ MONTH: z.string() });

/** A rejected CSV record as plain strings, for the DLQ. Never throws, whatever the record holds. */
function rawRow(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {};
  return Object.fromEntries(Object.entries(raw).map(([column, value]) => [column, String(value)]));
}

export function createReplaySummary(runId: string): ReplaySummary {
  return {
    runId,
    rowsScanned: 0,
    monthRows: 0,
    sentRaw: 0,
    sentDlq: 0,
    dlqReasons: {},
    malformedCsv: 0,
    elapsedMs: 0,
    sendElapsedMs: 0,
    peakRssMb: 0,
    interrupted: false,
  };
}

export async function replayMonth(args: ReplayArgs, deps: ReplayDeps): Promise<ReplaySummary> {
  const clock = deps.clock ?? systemClock;
  const epochNow = deps.epochNow ?? Date.now;
  const file = requireFile(args.dir ?? DEFAULT_DATA_DIR, 'flights.csv');
  const pacer = createPacer(args.rate, clock);
  const batchSize =
    args.rate > 0 ? Math.max(1, Math.min(MAX_BATCH, Math.round(args.rate / 10))) : MAX_BATCH;
  const monitor = new RssMonitor();
  const startedAt = clock.now();
  const month = String(args.month);

  const summary = deps.summary ?? createReplaySummary(deps.runId);
  let firstMonthRowAt: number | undefined;
  let events: FlightDoc[] = [];
  let rejects: DlqMessage[] = [];

  const flush = async () => {
    if (events.length === 0 && rejects.length === 0) return;
    await pacer.take(events.length + rejects.length);
    // producedAt is stamped at send time, so end-to-end latency excludes pacing waits. Every event
    // in one batch (at most 500) shares it; the batch leaves together.
    const producedAt = epochNow();
    const raw = events.map((doc) => {
      const event = toFlightEvent(doc, deps.runId, producedAt);
      return { key: event.pre.origin, value: JSON.stringify(event) };
    });
    const dlq = rejects.map((message) => ({
      key: message.row?.ORIGIN_AIRPORT ?? null,
      value: JSON.stringify(message),
    }));
    // Counted only after the broker acknowledged, so a failed send is never reported as sent. A
    // send that fails partway (one partition acknowledged, another not) is under-counted, never
    // over-counted; the consumer's idempotent upserts absorb a later re-send.
    if (raw.length > 0) await deps.sink.send(deps.topics.raw, raw);
    summary.sentRaw += raw.length;
    if (dlq.length > 0) await deps.sink.send(deps.topics.dlq, dlq);
    summary.sentDlq += dlq.length;
    events = [];
    rejects = [];
    monitor.sample();
    deps.onProgress?.({ ...summary, elapsedMs: clock.now() - startedAt });
  };

  try {
    for await (const raw of csvRows(file, REQUIRED_FLIGHT_COLUMNS, () => {
      summary.rowsScanned += 1;
      summary.malformedCsv += 1;
    })) {
      if (deps.signal?.aborted) {
        summary.interrupted = true;
        break;
      }
      summary.rowsScanned += 1;
      const monthField = MonthField.safeParse(raw);
      if (!monthField.success || monthField.data.MONTH.trim() !== month) continue;

      summary.monthRows += 1;
      firstMonthRowAt ??= clock.now();
      const result = transformFlightRow(raw, deps.refs);
      if (result.ok) {
        events.push(result.doc);
      } else {
        summary.dlqReasons[result.reason] = (summary.dlqReasons[result.reason] ?? 0) + 1;
        rejects.push({
          v: 1,
          source: 'producer',
          reason: result.reason,
          runId: deps.runId,
          at: epochNow(),
          row: rawRow(raw),
        });
      }
      if (events.length + rejects.length >= batchSize) await flush();
      // Stop as soon as the limit is met, without reading the rest of the file.
      if (args.limit !== undefined && summary.monthRows >= args.limit) break;
    }
    await flush();
  } finally {
    const endedAt = clock.now();
    summary.elapsedMs = endedAt - startedAt;
    summary.sendElapsedMs = firstMonthRowAt === undefined ? 0 : endedAt - firstMonthRowAt;
    summary.peakRssMb = monitor.stop();
  }
  return summary;
}
