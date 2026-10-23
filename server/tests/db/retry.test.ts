import { describe, expect, it } from 'vitest';
import { retry } from '../../src/db/retry.js';

const noSleep = async () => undefined;

describe('retry (MongoDB connect at startup)', () => {
  it('resolves once an attempt succeeds, waiting a doubling, capped delay between attempts', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retry(
      async () => {
        calls += 1;
        if (calls < 4) throw new Error(`down ${calls}`);
        return 'connected';
      },
      {
        attempts: 5,
        initialDelayMs: 1_000,
        maxDelayMs: 3_000,
        sleep: async (ms) => void waits.push(ms),
      },
    );
    expect(result).toBe('connected');
    expect(calls).toBe(4);
    expect(waits).toEqual([1_000, 2_000, 3_000]);
  });

  it('reports every failed attempt before the next wait', async () => {
    const seen: [number, string][] = [];
    let calls = 0;
    await retry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('refused');
        return calls;
      },
      {
        attempts: 3,
        initialDelayMs: 10,
        sleep: noSleep,
        onRetry: (attempt, error) => seen.push([attempt, (error as Error).message]),
      },
    );
    expect(seen).toEqual([[1, 'refused']]);
  });

  it('gives up after the last attempt with the last error, without a final wait', async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new Error(`down ${calls}`);
        },
        { attempts: 3, initialDelayMs: 5, sleep: async (ms) => void waits.push(ms) },
      ),
    ).rejects.toThrow('down 3');
    expect(calls).toBe(3);
    expect(waits).toEqual([5, 10]);
  });
});
