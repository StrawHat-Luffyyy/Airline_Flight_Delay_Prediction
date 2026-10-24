/**
 * The status endpoint's only view of Kafka: consumer lag and the DLQ size, from the admin API. Every
 * read is bounded by a short timeout, so a stopped broker gives a fast "unreachable" answer instead
 * of a hang.
 *
 * Admin client lifecycle, from measurements against a real broker (docker compose stop/start):
 * - disconnect() with requests in flight blocks the Node event loop until they time out (0.8-2 s
 *   per read, stalling every other request), so a client is never disconnected mid-request: a read
 *   that times out leaves its fetch running, and the next read reuses that fetch.
 * - A client that lost its broker kept failing for minutes after the broker returned, while a fresh
 *   client worked at once. So a fetch whose calls failed retires its client once all of its calls
 *   have settled (it is idle, so the disconnect is immediate), and the next read makes a new one.
 * A new fetch never starts while the previous one is pending, so requests cannot pile up.
 */
import type { KafkaJS } from '@confluentinc/kafka-javascript';

/** Bound on one status read of Kafka; the admin client fails fast against a stopped broker. */
export const KAFKA_TIMEOUT_MS = 1_000;
/** A Kafka read (success or failure) is reused this long. */
export const KAFKA_CACHE_MS = 2_000;

export interface PartitionLag {
  partition: number;
  /** The group's committed offset; null when the group has committed nothing on this partition. */
  committed: number | null;
  end: number;
  lag: number;
}

export interface LagInfo {
  total: number;
  partitions: PartitionLag[];
}

export function computeLag(
  committed: ReadonlyArray<{ partition: number; offset: string }>,
  ends: ReadonlyArray<{ partition: number; high: string; low: string }>,
): LagInfo {
  const committedBy = new Map(committed.map((entry) => [entry.partition, Number(entry.offset)]));
  const partitions = [...ends]
    .sort((a, b) => a.partition - b.partition)
    .map(({ partition, high, low }) => {
      const end = Number(high);
      const raw = committedBy.get(partition);
      const offset = raw === undefined || raw < 0 ? null : raw;
      // Retention may have deleted messages below the committed offset's reach: only the retained
      // range [low, high) can still be read.
      const from = Math.max(offset ?? Number(low), Number(low));
      return { partition, committed: offset, end, lag: Math.max(0, end - from) };
    });
  return { total: partitions.reduce((sum, p) => sum + p.lag, 0), partitions };
}

export type KafkaSnapshot =
  | {
      reachable: true;
      reason: null;
      lag: LagInfo;
      /** Null when only the DLQ topic's offsets could not be read (the lag is still valid). */
      dlqMessages: number | null;
    }
  /** The broker answered, but the topics do not exist yet (kafka:init has not run). */
  | { reachable: true; reason: string; lag: null; dlqMessages: null }
  | { reachable: false; reason: string; lag: null; dlqMessages: null };

/** librdkafka's ERR_UNKNOWN_TOPIC_OR_PART: the broker answered that the topic does not exist. */
const UNKNOWN_TOPIC_OR_PART = 3;

const isUnknownTopic = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === UNKNOWN_TOPIC_OR_PART;

export interface KafkaProbe {
  /** At most timeoutMs; a result is reused for cacheMs. Never rejects. */
  read(): Promise<KafkaSnapshot>;
  /** The last completed read, without waiting; null before the first one completes. */
  lastKnown(): KafkaSnapshot | null;
  close(): Promise<void>;
}

/** The admin calls the probe uses (a subset of the Confluent KafkaJS-compatible admin). */
export type ProbeAdmin = Pick<
  KafkaJS.Admin,
  'connect' | 'disconnect' | 'fetchOffsets' | 'fetchTopicOffsets'
>;

export interface KafkaProbeOptions {
  createAdmin: () => ProbeAdmin;
  groupId: string;
  topics: { raw: string; dlq: string };
  /** Bound on one read (connect + offsets), and the timeout passed to each admin call. */
  timeoutMs: number;
  /** A completed read (success or failure) is reused this long. */
  cacheMs: number;
  now?: () => number;
}

export class TimeoutError extends Error {}

/** Rejects after `ms`; the late result of `promise` is swallowed, never unhandled. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sumRetained = (offsets: ReadonlyArray<{ high: string; low: string }>): number =>
  offsets.reduce((sum, p) => sum + Number(p.high) - Number(p.low), 0);

export function createKafkaProbe(options: KafkaProbeOptions): KafkaProbe {
  const { createAdmin, groupId, topics, timeoutMs, cacheMs } = options;
  const now = options.now ?? Date.now;
  let admin: { client: ProbeAdmin; connected: Promise<void> } | undefined;
  /** The admin calls of the current fetch, until they settle (may outlive a timed-out read). */
  let fetching: Promise<KafkaSnapshot> | undefined;
  let reading: Promise<KafkaSnapshot> | undefined;
  let last: { at: number; value: KafkaSnapshot } | undefined;

  const ensureAdmin = () => {
    if (admin === undefined) {
      const client = createAdmin();
      const entry = { client, connected: client.connect() };
      admin = entry;
      entry.connected.catch(() => {
        if (admin === entry) admin = undefined;
      });
    }
    return admin;
  };

  /** Disconnects a client that has no calls in flight (then it cannot block the event loop). */
  const retire = (entry: NonNullable<typeof admin>) => {
    if (admin === entry) admin = undefined;
    entry.client.disconnect().catch(() => undefined);
  };

  const fetchSnapshot = async (): Promise<KafkaSnapshot> => {
    const entry = ensureAdmin();
    const { client, connected } = entry;
    await connected;
    // allSettled: the fetch ends only when every call has, so a failed client is idle when retired.
    // isolationLevel 0 = READ_UNCOMMITTED: the producers are not transactional.
    const [committed, rawEnds, dlqEnds] = await Promise.allSettled([
      client.fetchOffsets({ groupId, topics: [topics.raw], timeout: timeoutMs }),
      client.fetchTopicOffsets(topics.raw, { timeout: timeoutMs, isolationLevel: 0 }),
      client.fetchTopicOffsets(topics.dlq, { timeout: timeoutMs, isolationLevel: 0 }),
    ]);
    // A client that lost its broker kept failing after the broker returned (measured), while a
    // fresh one connects at once: retire it, and the next read creates a new client.
    if (committed.status === 'rejected') {
      retire(entry);
      throw committed.reason;
    }
    if (rawEnds.status === 'rejected') {
      // The broker answered: the client is healthy, only the topic is missing. Keep the client.
      if (isUnknownTopic(rawEnds.reason)) {
        return {
          reachable: true,
          reason: `topic ${topics.raw} does not exist: run npm run kafka:init`,
          lag: null,
          dlqMessages: null,
        };
      }
      retire(entry);
      throw rawEnds.reason;
    }
    const rawCommitted =
      committed.value.find((topic) => topic.topic === topics.raw)?.partitions ?? [];
    return {
      reachable: true,
      reason: null,
      lag: computeLag(rawCommitted, rawEnds.value),
      dlqMessages: dlqEnds.status === 'fulfilled' ? sumRetained(dlqEnds.value) : null,
    };
  };

  const readOnce = async (): Promise<KafkaSnapshot> => {
    fetching ??= fetchSnapshot().finally(() => {
      fetching = undefined;
    });
    let value: KafkaSnapshot;
    try {
      value = await withTimeout(fetching, timeoutMs, 'Kafka admin request');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      value = { reachable: false, reason, lag: null, dlqMessages: null };
    }
    last = { at: now(), value };
    return value;
  };

  return {
    read() {
      if (last !== undefined && now() - last.at < cacheMs) return Promise.resolve(last.value);
      reading ??= readOnce().finally(() => {
        reading = undefined;
      });
      return reading;
    },
    lastKnown: () => last?.value ?? null,
    async close() {
      const old = admin;
      admin = undefined;
      await old?.client.disconnect().catch(() => undefined);
    },
  };
}
