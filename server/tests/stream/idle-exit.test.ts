import { describe, expect, it } from 'vitest';
import { shouldIdleExit } from '../../src/stream/idle-exit.js';

describe('shouldIdleExit', () => {
  const idleExitMs = 60_000;

  it('never exits before the first batch, however long the wait', () => {
    // Regression: counting from start stopped a consumer while the producer was still reading
    // January to November (about 120 s), before the first December event arrived (run E, 8g).
    expect(shouldIdleExit({ batches: 0, lastBatchAt: 0, now: 10 * 60_000, idleExitMs })).toBe(
      false,
    );
  });

  it('exits once no batch has arrived for the idle limit after the first one', () => {
    expect(shouldIdleExit({ batches: 3, lastBatchAt: 1_000, now: 61_000, idleExitMs })).toBe(true);
    expect(shouldIdleExit({ batches: 3, lastBatchAt: 1_000, now: 60_999, idleExitMs })).toBe(false);
  });
});
