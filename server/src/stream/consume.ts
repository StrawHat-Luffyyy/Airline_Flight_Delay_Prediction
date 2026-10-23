/**
 * The consumer's batch logic (PROJECT_OVERVIEW §15.6), free of Kafka and MongoDB so it is unit
 * tested with fakes. At-least-once: a batch's offset is committed only after its events are in
 * MongoDB and its malformed messages are in the DLQ. If either fails, nothing is committed and
 * Kafka redelivers the batch; idempotent upserts keyed by the flight key absorb the repeat.
 */
import { FlightEventSchema, type DlqMessage, type FlightEvent } from '@flight-delay/shared';
import type { AlreadyStored, MessageSource } from './already-stored.js';

export interface IncomingMessage {
  offset: string;
  value: Buffer | null;
}

export interface BatchContext {
  topic: string;
  partition: number;
  /** Epoch ms, for the DLQ entries. */
  now: number;
}

export interface DecodedBatch {
  events: FlightEvent[];
  /** Where each event came from, in the same order as `events`. */
  sources: MessageSource[];
  dlq: DlqMessage[];
  /** The next offset to read (last + 1), or null for an empty batch. */
  commitOffset: string | null;
}

/** Characters of a bad message's raw value kept in its DLQ entry. */
export const MAX_DLQ_VALUE = 10_000;

/** Splits a batch into valid events and dead letters. Never throws for bad input. */
export function decodeBatch(messages: readonly IncomingMessage[], ctx: BatchContext): DecodedBatch {
  const events: FlightEvent[] = [];
  const sources: MessageSource[] = [];
  const dlq: DlqMessage[] = [];
  const deadLetter = (offset: string, reason: string, value?: string) =>
    dlq.push({
      v: 1,
      source: 'consumer',
      reason,
      at: ctx.now,
      topic: ctx.topic,
      partition: ctx.partition,
      offset,
      // The raw value, capped so one huge bad message cannot bloat the DLQ.
      ...(value === undefined ? {} : { value: value.slice(0, MAX_DLQ_VALUE) }),
    });

  for (const message of messages) {
    const text = message.value?.toString('utf8') ?? '';
    if (text === '') {
      deadLetter(message.offset, 'empty_value');
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      deadLetter(message.offset, 'invalid_json', text);
      continue;
    }
    const parsed = FlightEventSchema.safeParse(json);
    if (parsed.success) {
      events.push(parsed.data);
      sources.push({ topic: ctx.topic, partition: ctx.partition, offset: message.offset });
    } else {
      // The top-level field of each problem (pre, outcome, key, ...), deduplicated.
      const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))];
      deadLetter(message.offset, `invalid_event: ${fields.join(', ')}`, text);
    }
  }

  const last = messages.at(-1);
  return {
    events,
    sources,
    dlq,
    commitOffset: last === undefined ? null : (BigInt(last.offset) + 1n).toString(),
  };
}

export interface WriteResult {
  /** Flights stored for the first time. */
  inserted: number;
  /** Events whose flight was already stored (re-delivery or a repeated replay). */
  redelivered: number;
}

/** What the consumer's write reports: the counts, plus why flights were already stored. */
export interface WriteReport extends WriteResult {
  /** Breaks `redelivered` down by cause (already-stored.ts); absent when not classified. */
  alreadyStored?: AlreadyStored;
}

export interface BatchDeps {
  /** `sources[i]` is the message `events[i]` came from. */
  write(events: readonly FlightEvent[], sources: readonly MessageSource[]): Promise<WriteReport>;
  sendDlq(messages: readonly DlqMessage[]): Promise<void>;
  /** Commits `offset` (the next offset to read) for this partition. */
  commit(offset: string): Promise<void>;
}

export interface BatchResult extends WriteReport {
  consumed: number;
  dlq: number;
}

/** Write, then dead-letter, then commit. Any failure throws before the commit. */
export async function handleBatch(
  messages: readonly IncomingMessage[],
  ctx: BatchContext,
  deps: BatchDeps,
): Promise<BatchResult> {
  const decoded = decodeBatch(messages, ctx);
  const written =
    decoded.events.length > 0
      ? await deps.write(decoded.events, decoded.sources)
      : { inserted: 0, redelivered: 0 };
  if (decoded.dlq.length > 0) await deps.sendDlq(decoded.dlq);
  if (decoded.commitOffset !== null) await deps.commit(decoded.commitOffset);
  return { consumed: messages.length, ...written, dlq: decoded.dlq.length };
}
