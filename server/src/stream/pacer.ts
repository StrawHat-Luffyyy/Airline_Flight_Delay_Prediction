export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface Pacer {
  /** Waits, if needed, so that sending `count` more events keeps the target rate. */
  take(count: number): Promise<void>;
}

/**
 * Paces the replay at `rate` events per second (0 = unthrottled). Each batch is scheduled after
 * the previous one, so time spent sending counts toward the wait. A long pause (slow MongoDB,
 * a debugger) is never banked into a burst of more than one second's worth of events.
 */
export function createPacer(rate: number, clock: Clock = systemClock): Pacer {
  if (rate <= 0) return { take: async () => undefined };
  const msPerEvent = 1000 / rate;
  let nextAt: number | undefined;
  return {
    async take(count) {
      const now = clock.now();
      if (nextAt === undefined || nextAt < now - 1000) nextAt = now;
      const wait = nextAt - now;
      if (wait > 0) await clock.sleep(wait);
      nextAt += count * msPerEvent;
    },
  };
}
