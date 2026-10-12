import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../src/cache.js';

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('TtlCache', () => {
  it('returns the cached value until the TTL expires, then reloads', async () => {
    const time = clock();
    const cache = new TtlCache<number>({ ttlMs: 1_000, now: time.now });
    const load = vi.fn(async () => 42);

    expect(await cache.getOrLoad('k', load)).toBe(42);
    time.advance(999);
    expect(await cache.getOrLoad('k', load)).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);

    time.advance(1);
    await cache.getOrLoad('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const cache = new TtlCache<string>({ ttlMs: 1_000 });
    const load = vi.fn(async () => 'v');
    const results = await Promise.all([cache.getOrLoad('k', load), cache.getOrLoad('k', load)]);
    expect(results).toEqual(['v', 'v']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load', async () => {
    const cache = new TtlCache<string>({ ttlMs: 1_000 });
    await expect(
      cache.getOrLoad('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await cache.getOrLoad('k', async () => 'ok')).toBe('ok');
  });

  it('caches nothing when ttlMs is 0', async () => {
    const cache = new TtlCache<number>({ ttlMs: 0 });
    const load = vi.fn(async () => 1);
    await cache.getOrLoad('k', load);
    await cache.getOrLoad('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry beyond maxEntries', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000, maxEntries: 2 });
    const load = vi.fn(async () => 1);
    await cache.getOrLoad('a', load);
    await cache.getOrLoad('b', load);
    await cache.getOrLoad('c', load);
    await cache.getOrLoad('a', load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
