import { setTimeout as delay } from 'node:timers/promises';

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts: number;
  /** Wait before the second attempt; it doubles after each failure, up to maxDelayMs. */
  initialDelayMs: number;
  maxDelayMs?: number;
  /** Called after a failed attempt that will be retried (1-based attempt number). */
  onRetry?: (attempt: number, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `task` until it succeeds or `attempts` are spent, then rethrows the last error. The API uses
 * it to connect to MongoDB at startup, so a database that is still starting (for example a
 * container started in the same `docker compose up`) delays the API instead of killing it.
 */
export async function retry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const maxDelayMs = options.maxDelayMs ?? Number.POSITIVE_INFINITY;
  let wait = options.initialDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= options.attempts) throw error;
      options.onRetry?.(attempt, error);
      await sleep(Math.min(wait, maxDelayMs));
      wait *= 2;
    }
  }
}
