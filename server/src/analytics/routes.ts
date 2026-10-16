import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import { RoutesResponseSchema, type RoutesQuery, type RoutesResponse } from '@flight-delay/shared';

// ---------- Destinations flown from an origin (Predict form) ----------

/** stats_route holds one document per IATA route; /predict derives its route inputs from it. */
export const ROUTES_SOURCE = 'stats_route';

export function routesPipeline(query: RoutesQuery): Document[] {
  return [
    { $match: { origin: query.origin } },
    { $sort: { flights: -1, dest: 1 } },
    { $project: { _id: 0, dest: 1, flights: 1 } },
  ];
}

export async function getRoutes(db: Db, query: RoutesQuery): Promise<RoutesResponse> {
  const docs = await db.collection(ROUTES_SOURCE).aggregate(routesPipeline(query)).toArray();
  return RoutesResponseSchema.parse({
    origin: query.origin,
    destinations: z.array(z.unknown()).parse(docs),
  });
}
