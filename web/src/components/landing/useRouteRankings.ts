import { useDelayRate } from '../../api/hooks';

/** Routes ranked on the globe: this many from each end of the delay-rate ranking. */
const GLOBE_ROUTES = 10;
/** Routes need at least this many 2015 flights to be ranked (the routes chapter states it). */
export const ROUTE_MIN_FLIGHTS = 1000;

/** The most delay-prone and the most punctual routes, from /api/analytics/delay-rate. */
export function useRouteRankings() {
  const late = useDelayRate({
    by: 'route',
    minFlights: ROUTE_MIN_FLIGHTS,
    limit: GLOBE_ROUTES,
    order: 'worst',
  });
  const punctual = useDelayRate({
    by: 'route',
    minFlights: ROUTE_MIN_FLIGHTS,
    limit: GLOBE_ROUTES,
    order: 'best',
  });
  return { late, punctual };
}

export type RouteRankings = ReturnType<typeof useRouteRankings>;
