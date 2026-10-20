import { describe, expect, it } from 'vitest';
import type { ReferenceData } from '../../src/ml/predict.js';
import { cachedReferenceData } from '../../src/stream/reference-cache.js';

function countingReference(failFirstRoute = false) {
  const calls = { airline: 0, airport: 0, route: 0 };
  let routeFailures = failFirstRoute ? 1 : 0;
  const inner: ReferenceData = {
    async hasAirline() {
      calls.airline += 1;
      return true;
    },
    async hasAirport(code) {
      calls.airport += 1;
      return code !== 'XXX';
    },
    async route() {
      calls.route += 1;
      if (routeFailures > 0) {
        routeFailures -= 1;
        throw new Error('MongoNetworkError');
      }
      return { distance: 1744, scheduledTime: 275 };
    },
    async lookups() {
      throw new Error('not used');
    },
  };
  return { inner, calls };
}

describe('cachedReferenceData', () => {
  it('asks MongoDB once per airline, airport and route, and returns the same answers', async () => {
    const { inner, calls } = countingReference();
    const cached = cachedReferenceData(inner);
    for (let i = 0; i < 5; i += 1) {
      expect(await cached.hasAirline('AA')).toBe(true);
      expect(await cached.hasAirport('ORD')).toBe(true);
      expect(await cached.hasAirport('XXX')).toBe(false);
      expect(await cached.route('ORD', 'LAX')).toEqual({ distance: 1744, scheduledTime: 275 });
    }
    // XXX is unknown (false), so it is asked again each time; known answers are asked once.
    expect(calls).toEqual({ airline: 1, airport: 1 + 5, route: 1 });
  });

  it('does not cache a failure: the next call retries', async () => {
    const { inner, calls } = countingReference(true);
    const cached = cachedReferenceData(inner);
    await expect(cached.route('ORD', 'LAX')).rejects.toThrow(/MongoNetworkError/);
    expect(await cached.route('ORD', 'LAX')).toEqual({ distance: 1744, scheduledTime: 275 });
    expect(calls.route).toBe(2);
  });
});
