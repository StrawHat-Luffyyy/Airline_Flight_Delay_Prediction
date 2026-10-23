/**
 * An offset commit that is known to have reached the broker.
 *
 * Why: in @confluentinc/kafka-javascript 1.11.0 the KafkaJS-style `commitOffsets()` calls
 * librdkafka's `commitAsync` and resolves once the commit is queued, not when the broker stores it.
 * The broker's answer goes to librdkafka's offset-commit callback, which the KafkaJS layer enables
 * but never listens to, so a failed commit is dropped without an error. While the broker was down
 * (run R1) every commit resolved and the consumer moved on; the broker never stored them, and
 * 16,000 flights were delivered again. Reproduced with every commit resolving during an outage
 * (docs/measurements/commit-check-raw.json, `npm run stream:commit-check -- --mode raw`).
 *
 * So after each commit the consumer reads the group's committed offset back from the broker (up to
 * three reads, 50 ms apart, as the queued commit may not have been sent yet) and
 * treats anything short of the offset it committed as a failed batch: nothing is marked processed,
 * the client seeks back, and the batch is delivered again (absorbed by the idempotent upsert).
 */
export interface CommitTarget {
  topic: string;
  partition: number;
  /** The next offset to read (last processed + 1), as the client takes it. */
  offset: string;
}

export interface CommittedOffset {
  topic: string;
  partition: number;
  offset: string;
}

/** The two client calls used; KafkaJS.Consumer has both. */
export interface CommitClient {
  commitOffsets(offsets: CommitTarget[]): Promise<void>;
  committed(
    partitions: { topic: string; partition: number }[],
    timeoutMs: number,
  ): Promise<CommittedOffset[]>;
}

export class CommitNotConfirmed extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'CommitNotConfirmed';
  }
}

export interface ConfirmOptions {
  /** Bound on each read of the committed offset. */
  timeoutMs: number;
  /**
   * Reads before giving up while the broker still holds an older offset: the queued commit may not
   * have been sent yet when the first read goes out. A failed read is not retried.
   */
  reads?: number;
  /** Pause between those reads. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const parseOffset = (value: string): bigint | null => {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

export async function commitAndConfirm(
  client: CommitClient,
  target: CommitTarget,
  options: ConfirmOptions,
): Promise<void> {
  const { topic, partition, offset } = target;
  const { timeoutMs, reads = 3, retryDelayMs = 50 } = options;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const where = `${topic}[${partition}]`;
  const fail = (why: string, cause?: unknown) =>
    new CommitNotConfirmed(
      `commit of ${where} at ${offset} not confirmed: ${why}`,
      cause === undefined ? undefined : { cause },
    );
  const wanted = parseOffset(offset);
  if (wanted === null) throw fail('not an integer offset');

  await client.commitOffsets([target]);
  for (let read = 1; ; read += 1) {
    let committed: CommittedOffset[];
    try {
      committed = await client.committed([{ topic, partition }], timeoutMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw fail(`reading it back failed (${reason})`, error);
    }
    const stored = committed.find((c) => c.topic === topic && c.partition === partition);
    if (stored === undefined) throw fail('no committed offset returned');
    const held = parseOffset(stored.offset);
    if (held === null) throw fail(`the broker returned ${JSON.stringify(stored.offset)}`);
    // A later commit (ours or a new owner's) may already be past ours; that is fine.
    if (held >= wanted) return;
    if (read >= reads) throw fail(`the broker holds ${stored.offset} after ${reads} reads`);
    await sleep(retryDelayMs);
  }
}
