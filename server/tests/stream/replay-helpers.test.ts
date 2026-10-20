import { describe, expect, it } from 'vitest';
import { createPacer } from '../../src/stream/pacer.js';
import { parseReplayArgs } from '../../src/stream/replay-args.js';

describe('parseReplayArgs', () => {
  it('defaults to December at 1,000 events/s with no limit', () => {
    expect(parseReplayArgs([])).toEqual({
      month: 12,
      rate: 1000,
      limit: undefined,
      dir: undefined,
    });
  });

  it('reads --month, --rate (0 = unthrottled), --limit and --dir', () => {
    expect(
      parseReplayArgs(['--month', '11', '--rate', '0', '--limit', '500', '--dir', 'data/x']),
    ).toEqual({ month: 11, rate: 0, limit: 500, dir: 'data/x' });
  });

  it('rejects out-of-range or malformed values and unknown flags', () => {
    expect(() => parseReplayArgs(['--month', '13'])).toThrow(/--month/);
    expect(() => parseReplayArgs(['--month', 'dec'])).toThrow(/--month/);
    expect(() => parseReplayArgs(['--rate', '-1'])).toThrow(/--rate/);
    expect(() => parseReplayArgs(['--rate'])).toThrow(/--rate/);
    expect(() => parseReplayArgs(['--limit', '0'])).toThrow(/--limit/);
    expect(() => parseReplayArgs(['--limit', '2.5'])).toThrow(/--limit/);
    expect(() => parseReplayArgs(['--fast'])).toThrow(/Unknown argument "--fast"/);
  });
});

/** A fake clock: sleep advances time instead of waiting. */
function fakeClock() {
  let now = 0;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('createPacer', () => {
  it('never waits when the rate is 0 (unthrottled)', async () => {
    const clock = fakeClock();
    const pacer = createPacer(0, clock);
    await pacer.take(1_000_000);
    expect(clock.slept).toEqual([]);
  });

  it('holds the long-run rate: 1,000 events at 500/s take 2 s', async () => {
    const clock = fakeClock();
    const pacer = createPacer(500, clock);
    for (let i = 0; i < 10; i += 1) await pacer.take(100);
    // The first batch goes at once; the remaining 900 events need 1.8 s at 500/s.
    expect(clock.now()).toBeGreaterThanOrEqual(1_800);
    expect(clock.now()).toBeLessThanOrEqual(2_000);
  });

  it('does not wait for time already spent doing work', async () => {
    const clock = fakeClock();
    const pacer = createPacer(100, clock);
    await pacer.take(100);
    clock.advance(1_000); // sending took a whole second
    await pacer.take(100);
    expect(clock.slept).toEqual([]);
  });

  it('does not bank idle time into a burst beyond one second of events', async () => {
    const clock = fakeClock();
    const pacer = createPacer(100, clock);
    clock.advance(60_000);
    await pacer.take(100);
    await pacer.take(100);
    expect(clock.slept.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(1_000);
  });
});
