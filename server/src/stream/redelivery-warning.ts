/**
 * Makes redelivery visible while it happens. A flight that is delivered again although it is
 * already stored means its offset was never committed: a crash, a rebalance, or a commit lost while
 * the broker was down. In run R1 16,000 offsets were lost that way with no error from the client,
 * so the consumer cannot rely on commit errors to notice; it notices the redelivery instead.
 */
export interface RedeliverySummary {
  /** Already-stored flights delivered again since the last warning. */
  redelivered: number;
  /** Batches that contained at least one of them. */
  batches: number;
}

export interface RedeliveryWarningOptions {
  /** At most one warning per interval; the first one is immediate. */
  intervalMs: number;
  now: () => number;
  warn: (summary: RedeliverySummary) => void;
}

/** Returns a function to call once per stored batch with its redelivered count. */
export function createRedeliveryWarning({
  intervalMs,
  now,
  warn,
}: RedeliveryWarningOptions): (redelivered: number) => void {
  let lastWarnAt = -Infinity;
  let pending: RedeliverySummary = { redelivered: 0, batches: 0 };
  return (redelivered) => {
    if (redelivered > 0) {
      pending = { redelivered: pending.redelivered + redelivered, batches: pending.batches + 1 };
    }
    // A clean batch after the interval still reports what was held back.
    if (pending.redelivered === 0 || now() - lastWarnAt < intervalMs) return;
    lastWarnAt = now();
    warn(pending);
    pending = { redelivered: 0, batches: 0 };
  };
}
