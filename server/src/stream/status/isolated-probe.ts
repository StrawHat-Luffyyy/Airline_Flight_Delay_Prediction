/**
 * Runs the Kafka probe in a separate process, so a native crash in librdkafka can never take the API
 * down with it.
 *
 * Why: `admin.fetchOffsets` (@confluentinc/kafka-javascript 1.11.0, Windows) crashed the whole
 * process with an access violation (exit code 0xC0000005) when the broker came back after
 * `docker compose stop/start kafka`, reproduced with a 30-line script using only that client. The
 * API serves every other page, and must keep working whatever Kafka does (PROJECT_OVERVIEW §15.1).
 *
 * The parent sends `{id}` over IPC and the child (probe-worker.ts) answers `{id, snapshot}` from an
 * in-process probe (kafka-probe.ts, which caches and bounds its own reads). If the child exits, the
 * pending read reports Kafka unreachable with the exit code, and the next read starts a new child.
 */
import type { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { z } from 'zod';
import { withTimeout, type KafkaProbe, type KafkaSnapshot } from './kafka-probe.js';

export const ProbeRequestSchema = z.object({ id: z.number().int() });

const count = z.number().int().nonnegative();
const KafkaSnapshotSchema = z.union([
  z.object({
    reachable: z.literal(true),
    reason: z.null(),
    lag: z.object({
      total: count,
      partitions: z.array(
        z.object({
          partition: count,
          committed: count.nullable(),
          end: count,
          lag: count,
        }),
      ),
    }),
    dlqMessages: count.nullable(),
  }),
  // The broker answered, but the topics do not exist yet (kafka:init has not run).
  z.object({
    reachable: z.literal(true),
    reason: z.string(),
    lag: z.null(),
    dlqMessages: z.null(),
  }),
  z.object({
    reachable: z.literal(false),
    reason: z.string(),
    lag: z.null(),
    dlqMessages: z.null(),
  }),
]);
const ProbeResponseSchema = z.object({ id: z.number().int(), snapshot: KafkaSnapshotSchema });

/** The parts of a forked ChildProcess the probe uses. */
export interface ProbeChild extends EventEmitter {
  connected: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  disconnect(): void;
}

export interface IsolatedProbeOptions {
  spawn: () => ProbeChild;
  /** Bound on one read, including the child's own (shorter) Kafka timeout and IPC. */
  timeoutMs: number;
  logger?: Pick<Logger, 'warn'>;
}

const unreachable = (reason: string): KafkaSnapshot => ({
  reachable: false,
  reason,
  lag: null,
  dlqMessages: null,
});

export function createIsolatedProbe({
  spawn,
  timeoutMs,
  logger,
}: IsolatedProbeOptions): KafkaProbe {
  let child: ProbeChild | undefined;
  let nextId = 0;
  const waiting = new Map<number, (snapshot: KafkaSnapshot) => void>();
  let reading: Promise<KafkaSnapshot> | undefined;
  let last: KafkaSnapshot | null = null;

  const answer = (id: number, snapshot: KafkaSnapshot) => {
    const resolve = waiting.get(id);
    waiting.delete(id);
    resolve?.(snapshot);
  };

  const ensureChild = (): ProbeChild => {
    if (child !== undefined) return child;
    const started = spawn();
    child = started;
    started.on('message', (message: unknown) => {
      const parsed = ProbeResponseSchema.safeParse(message);
      if (parsed.success) answer(parsed.data.id, parsed.data.snapshot);
    });
    const gone = (why: string) => {
      if (child === started) child = undefined;
      const reason = `Kafka probe process ${why}; a new one starts on the next read`;
      logger?.warn({ pending: waiting.size }, reason);
      for (const id of [...waiting.keys()]) answer(id, unreachable(reason));
    };
    started.on('exit', (code: number | null, signal: string | null) =>
      gone(`exited (${signal ?? `code ${code}`})`),
    );
    started.on('error', (error: Error) => gone(`failed (${error.message})`));
    return started;
  };

  const readOnce = async (): Promise<KafkaSnapshot> => {
    const id = ++nextId;
    const reply = new Promise<KafkaSnapshot>((resolve) => waiting.set(id, resolve));
    ensureChild().send({ id }, (error) => {
      if (error !== null)
        answer(id, unreachable(`Kafka probe process unavailable (${error.message})`));
    });
    let snapshot: KafkaSnapshot;
    try {
      snapshot = await withTimeout(reply, timeoutMs, 'Kafka probe process');
    } catch (error) {
      waiting.delete(id);
      snapshot = unreachable(error instanceof Error ? error.message : String(error));
    }
    last = snapshot;
    return snapshot;
  };

  return {
    read() {
      reading ??= readOnce().finally(() => {
        reading = undefined;
      });
      return reading;
    },
    lastKnown: () => last,
    async close() {
      const running = child;
      child = undefined;
      // The worker exits when its IPC channel closes (after disconnecting from Kafka).
      if (running?.connected === true) running.disconnect();
    },
  };
}
