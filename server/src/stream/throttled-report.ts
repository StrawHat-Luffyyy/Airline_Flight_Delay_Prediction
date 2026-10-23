/**
 * Folds a per-batch count into at most one log line per interval, so a long redelivery or replay
 * does not log every batch. The consumer keeps one per cause of already-stored flights
 * (already-stored.ts): same-message redelivery (a warning), replay or duplicate, and unknown.
 */
export interface ThrottledSummary {
  /** The counted items since the last report. */
  count: number;
  /** Batches that contained at least one of them. */
  batches: number;
}

export interface ThrottledReportOptions {
  /** At most one report per interval; the first one is immediate. */
  intervalMs: number;
  now: () => number;
  report: (summary: ThrottledSummary) => void;
}

export interface ThrottledReport {
  /** Call once per stored batch with that batch's count. */
  (count: number): void;
  /** Reports whatever is held back now (e.g. when the consumer stops), so no count is lost. */
  flush(): void;
}

/** Returns a reporter to call once per stored batch with that batch's count. */
export function createThrottledReport({
  intervalMs,
  now,
  report,
}: ThrottledReportOptions): ThrottledReport {
  let lastReportAt = -Infinity;
  let pending: ThrottledSummary = { count: 0, batches: 0 };
  const emit = () => {
    lastReportAt = now();
    report(pending);
    pending = { count: 0, batches: 0 };
  };
  const reporter = (count: number) => {
    if (count > 0) {
      pending = { count: pending.count + count, batches: pending.batches + 1 };
    }
    // A clean batch after the interval still reports what was held back.
    if (pending.count === 0 || now() - lastReportAt < intervalMs) return;
    emit();
  };
  return Object.assign(reporter, {
    flush() {
      if (pending.count > 0) emit();
    },
  });
}
