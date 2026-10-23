/**
 * Why an event's flight is already stored: the same Kafka message read again (its offset was never
 * committed: a crash, a rebalance, a commit not confirmed), or a different message for the same
 * flight (a repeated replay, or a duplicate). Only the first is worth a warning; the stored data is
 * the same either way, since the upsert keyed by the flight key absorbs both.
 *
 * Each upsert records the newest message (highest offset) that wrote the flight (`lastSource`).
 * Kafka offsets only grow within a partition, and a flight is always keyed to the same partition,
 * so a message at or before the recorded offset is a re-read, and a later one is a new message.
 *
 * Flights stored before positions were recorded cannot be told apart: neither their run id nor
 * anything else shows whether a message was processed before (a rewind re-reads older runs'
 * messages too), so they are counted as unknown. One residue: in the first rewind over such a
 * flight, its first re-read message records a position, so a later message for it in the same
 * pass counts as new (logged at info, never as a warning).
 */
export interface MessageSource {
  topic: string;
  partition: number;
  /** As the client gives it: an integer string. */
  offset: string;
}

export interface StoredDelivery {
  /** The newest message that wrote the flight; null when stored before positions were recorded. */
  lastSource: MessageSource | null;
}

export interface AlreadyStored {
  /** The same message read again: its offset had not been committed. */
  sameMessage: number;
  /** A different message for a stored flight: a repeated replay or a duplicate. */
  otherMessage: number;
  /** Stored before positions were recorded: either of the above. */
  unknown: number;
}

/**
 * Counts, among a batch's events, those whose flight was already stored (or appeared earlier in
 * the batch), by cause. `stored` holds the flights stored before the batch, by flight key.
 */
export function classifyAlreadyStored(
  events: readonly { key: string; source: MessageSource }[],
  stored: ReadonlyMap<string, StoredDelivery>,
): AlreadyStored {
  const counts: AlreadyStored = { sameMessage: 0, otherMessage: 0, unknown: 0 };
  const seenInBatch = new Set<string>();
  for (const { key, source } of events) {
    const before = stored.get(key);
    if (seenInBatch.has(key)) {
      // Two messages of one batch always have different offsets.
      counts.otherMessage += 1;
    } else if (before !== undefined) {
      const last = before.lastSource;
      if (last === null) {
        counts.unknown += 1;
      } else if (
        last.topic === source.topic &&
        last.partition === source.partition &&
        BigInt(source.offset) <= BigInt(last.offset)
      ) {
        counts.sameMessage += 1;
      } else {
        counts.otherMessage += 1;
      }
    }
    seenInBatch.add(key);
  }
  return counts;
}
