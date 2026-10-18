import { useMemo } from 'react';
import { useDelayRate, useRoutes, useSummary } from '../../api/hooks';
import type { AirportStat } from '../globe/Airports';
import {
  buildRouteArcs,
  mergeAirportRankings,
  type Coordinates,
  type RouteArc,
} from '../globe/geo';

/** Airports need at least this many 2015 departures to get a beacon (the legend states it). */
export const AIRPORT_MIN_FLIGHTS = 2000;
/** The API's row cap; both ends of the ranking are fetched, so up to twice this many airports. */
const AIRPORT_LIMIT = 100;
/** Destinations drawn for a selected airport, busiest first. */
export const NETWORK_SIZE = 12;

/**
 * Departures and delay rate for every airport with AIRPORT_MIN_FLIGHTS or more departures, from
 * the two ends of /api/analytics/delay-rate?by=origin. When the ends overlap, every such airport is
 * present (`complete`); otherwise the middle of the ranking is missing and the legend says so.
 * `national` is the overall delay rate from /api/analytics/summary.
 */
export function useAirportStats() {
  const worst = useDelayRate({
    by: 'origin',
    minFlights: AIRPORT_MIN_FLIGHTS,
    limit: AIRPORT_LIMIT,
    order: 'worst',
  });
  const best = useDelayRate({
    by: 'origin',
    minFlights: AIRPORT_MIN_FLIGHTS,
    limit: AIRPORT_LIMIT,
    order: 'best',
  });
  const summary = useSummary();

  return useMemo(() => {
    const merged =
      worst.data && best.data
        ? mergeAirportRankings(worst.data.rows, best.data.rows, AIRPORT_LIMIT)
        : null;
    const stats = new Map<string, AirportStat>(
      (merged?.rows ?? []).map((row) => [
        String(row.key),
        {
          code: String(row.key),
          flights: row.flights,
          completed: row.completed,
          delayRate: row.delayRate,
          avgArrDelay: row.avgArrDelay,
        },
      ]),
    );
    return {
      stats,
      complete: merged?.complete ?? false,
      national: summary.data?.delayRate ?? null,
      coverage: worst.data?.coverage ?? null,
      loaded: merged !== null,
    };
  }, [worst.data, best.data, summary.data]);
}

export type AirportStats = ReturnType<typeof useAirportStats>;

/**
 * The selected airport's busiest destinations as arcs, from /api/routes (every 2015 flight from
 * that origin). Ids are prefixed `net:` so they never collide with a ranked route's id.
 */
export function useAirportNetwork(
  origin: string | null,
  airports: ReadonlyMap<string, Coordinates>,
) {
  const routes = useRoutes(origin ?? '');
  const arcs = useMemo<RouteArc[]>(() => {
    if (!origin || routes.data?.origin !== origin) return [];
    const rows = routes.data.destinations.slice(0, NETWORK_SIZE).map((destination) => ({
      key: `${origin}-${destination.dest}`,
      delayRate: null,
      flights: destination.flights,
      completed: null,
      avgArrDelay: null,
    }));
    return buildRouteArcs(rows, airports, 'network').map((arc) => ({
      ...arc,
      id: `net:${arc.id}`,
    }));
  }, [origin, routes.data, airports]);
  return { routes, arcs };
}
