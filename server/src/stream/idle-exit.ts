/**
 * `stream:consume --idle-exit SECONDS`: stop once no batch has arrived for that long, counted from
 * the first batch. Before the first batch the consumer keeps waiting, because a replay first reads
 * January to November (71-123 s measured) before it sends anything; counting from start once
 * stopped a consumer before any event arrived (run E, 8g follow-ups).
 */
export function shouldIdleExit({
  batches,
  lastBatchAt,
  now,
  idleExitMs,
}: {
  /** Batches processed so far by this process. */
  batches: number;
  /** Epoch ms of the last processed batch. */
  lastBatchAt: number;
  now: number;
  idleExitMs: number;
}): boolean {
  return batches > 0 && now - lastBatchAt >= idleExitMs;
}
