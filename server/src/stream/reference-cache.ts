import type { ReferenceData } from '../ml/predict.js';

/**
 * Memoises the airline, airport and route checks of a ReferenceData. The speed layer scores
 * hundreds of thousands of flights over a few hundred airports and a few thousand routes, so this
 * turns four MongoDB round trips per flight into a few thousand in total. `predictDelay` itself is
 * unchanged: this is the same interface it takes from the API.
 *
 * Only positive answers are kept. A failed lookup, an unknown code (false) or an unknown route
 * (null) is asked again next time, so a reference rebuild (ingest --reference-only, build:stats)
 * is picked up without a restart. delay_lookup itself is read once per process, as in the API:
 * restart the consumer after `npm run build:lookup`.
 */
export function cachedReferenceData(inner: ReferenceData): ReferenceData {
  const memo = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
    let hit = cache.get(key);
    if (!hit) {
      hit = load().then(
        (value) => {
          if (value === false || value === null) cache.delete(key);
          return value;
        },
        (error: unknown) => {
          cache.delete(key);
          throw error;
        },
      );
      cache.set(key, hit);
    }
    return hit;
  };
  const airlines = new Map<string, Promise<boolean>>();
  const airports = new Map<string, Promise<boolean>>();
  const routes = new Map<string, ReturnType<ReferenceData['route']>>();
  return {
    hasAirline: (code) => memo(airlines, code, () => inner.hasAirline(code)),
    hasAirport: (code) => memo(airports, code, () => inner.hasAirport(code)),
    route: (origin, dest) => memo(routes, `${origin}-${dest}`, () => inner.route(origin, dest)),
    lookups: () => inner.lookups(),
  };
}
