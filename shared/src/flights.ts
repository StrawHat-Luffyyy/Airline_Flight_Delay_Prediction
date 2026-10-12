import { z } from 'zod';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const MISSING_SELECTIVE_FILTER =
  'Provide airline, origin, route, or a from+to date range; dest alone would scan the whole collection.';

export const DEST_NEEDS_ORIGIN =
  'dest has no index of its own: combine it with origin (or use route).';

/**
 * Query string for GET /api/flights (PROJECT_OVERVIEW §9). At least one filter must map to a
 * §6.2 index: airline (airline_1_date_1), origin (origin_1_schedDepHour_1), route (route_1) or
 * a closed from+to date range (date_1). `dest` has no index, so it is only accepted with origin
 * (served as the route origin-dest via route_1) or route; elsewhere it would force a fetch of
 * every flight of the airline or date window to filter it (400 instead).
 */
export const FlightsQuerySchema = z
  .object({
    airline: z
      .string()
      .regex(/^[A-Z0-9]{2}$/, 'airline must be a 2-character IATA code')
      .optional(),
    origin: z
      .string()
      .regex(/^[A-Z0-9]{3}$/, 'origin must be a 3-character IATA code')
      .optional(),
    dest: z
      .string()
      .regex(/^[A-Z0-9]{3}$/, 'dest must be a 3-character IATA code')
      .optional(),
    route: z
      .string()
      .regex(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/, 'route must look like LAX-SFO')
      .optional(),
    from: z.string().regex(ISO_DAY, 'from must be YYYY-MM-DD').optional(),
    to: z.string().regex(ISO_DAY, 'to must be YYYY-MM-DD').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .superRefine((query, context) => {
    const hasDateRange = query.from !== undefined && query.to !== undefined;
    if (!query.airline && !query.origin && !query.route && !hasDateRange) {
      context.addIssue({ code: 'custom', message: MISSING_SELECTIVE_FILTER, path: [] });
    } else if (query.dest && !query.origin && !query.route) {
      context.addIssue({ code: 'custom', message: DEST_NEEDS_ORIGIN, path: ['dest'] });
    }
    if (hasDateRange && query.from && query.to && query.from > query.to) {
      context.addIssue({
        code: 'custom',
        message: 'from must be on or before to.',
        path: ['from'],
      });
    }
  });

export type FlightsQuery = z.infer<typeof FlightsQuerySchema>;
