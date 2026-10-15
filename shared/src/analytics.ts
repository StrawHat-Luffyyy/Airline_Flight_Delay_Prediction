import { z } from 'zod';

const AIRLINE_CODE = /^[A-Z0-9]{2}$/;
const AIRPORT_CODE = /^[A-Z0-9]{3}$/;
const limit = z.coerce.number().int().min(1).max(100).default(20);

// ---------- Query schemas (all values arrive as strings) ----------

export const CausesQuerySchema = z.object({
  by: z.enum(['overall', 'airline', 'airport', 'month', 'hour']).default('overall'),
  limit,
});
export type CausesQuery = z.infer<typeof CausesQuerySchema>;

export const DelayRateQuerySchema = z.object({
  by: z.enum(['airline', 'origin', 'route', 'dow', 'hour']).default('airline'),
  /** Minimum flights per group, so tiny groups do not dominate rankings (§8). */
  minFlights: z.coerce.number().int().min(1).max(1_000_000).default(500),
  limit,
  order: z.enum(['worst', 'best']).default('worst'),
});
export type DelayRateQuery = z.infer<typeof DelayRateQuerySchema>;

/** airline and/or origin; both together are served by stats_daily_origin (date, origin, airline). */
export const TrendQuerySchema = z.object({
  airline: z.string().regex(AIRLINE_CODE, 'airline must be a 2-character IATA code').optional(),
  origin: z.string().regex(AIRPORT_CODE, 'origin must be a 3-character IATA code').optional(),
  granularity: z.enum(['day', 'month']).default('month'),
});
export type TrendQuery = z.infer<typeof TrendQuerySchema>;

export const CancellationsQuerySchema = z.object({
  by: z.enum(['overall', 'airline', 'month']).default('overall'),
});
export type CancellationsQuery = z.infer<typeof CancellationsQuerySchema>;

// ---------- Response schemas ----------

const rate = z.number().nullable();

/**
 * Present on airport-keyed results: flights left out because their airport is still a numeric
 * BTS id that resolve:airport-ids could not map (all in October 2015). null when the result
 * covers every flight.
 */
export const CoverageSchema = z
  .object({ excludedUnresolvedFlights: z.number(), note: z.string() })
  .nullable();
export type Coverage = z.infer<typeof CoverageSchema>;

export const DataQualitySchema = z.object({
  flights: z.number(),
  /** Flights whose origin is an unresolved numeric BTS id (excluded from origin/hour results). */
  unresolvedOriginFlights: z.number(),
  /** Flights with either end unresolved (excluded from route results). */
  unresolvedRouteFlights: z.number(),
});
export type DataQuality = z.infer<typeof DataQualitySchema>;

export const SummaryResponseSchema = z.object({
  flights: z.number(),
  /** Flights with a known arrival outcome (not cancelled or diverted). */
  completed: z.number(),
  delayed: z.number(),
  /** delayed / completed (arrival delay >= 15 min). */
  delayRate: rate,
  cancelled: z.number(),
  cancelRate: rate,
  diverted: z.number(),
  /** Mean arrival delay of completed flights, minutes (negative = early). */
  avgArrDelay: rate,
});
export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;

export const CAUSE_KEYS = ['carrier', 'weather', 'nas', 'security', 'lateAircraft'] as const;
export type CauseKey = (typeof CAUSE_KEYS)[number];

const causeMinutes = z.object({
  carrier: z.number(),
  weather: z.number(),
  nas: z.number(),
  security: z.number(),
  lateAircraft: z.number(),
});

export const CauseRowSchema = z.object({
  key: z.union([z.string(), z.number()]),
  label: z.string(),
  minutes: causeMinutes,
  totalMinutes: z.number(),
  /** Each cause's share of totalMinutes (0-1); null when totalMinutes is 0. */
  shares: z.object({
    carrier: rate,
    weather: rate,
    nas: rate,
    security: rate,
    lateAircraft: rate,
  }),
});
export type CauseRow = z.infer<typeof CauseRowSchema>;

export const CausesResponseSchema = z.object({
  by: CausesQuerySchema.shape.by,
  coverage: CoverageSchema,
  rows: z.array(CauseRowSchema),
});
export type CausesResponse = z.infer<typeof CausesResponseSchema>;

export const DelayRateRowSchema = z.object({
  key: z.union([z.string(), z.number()]),
  label: z.string(),
  flights: z.number(),
  completed: z.number(),
  delayed: z.number(),
  delayRate: rate,
  avgArrDelay: rate,
});
export type DelayRateRow = z.infer<typeof DelayRateRowSchema>;

export const DelayRateResponseSchema = z.object({
  by: DelayRateQuerySchema.shape.by,
  order: DelayRateQuerySchema.shape.order,
  minFlights: z.number(),
  coverage: CoverageSchema,
  rows: z.array(DelayRateRowSchema),
});
export type DelayRateResponse = z.infer<typeof DelayRateResponseSchema>;

export const TrendPointSchema = z.object({
  /** YYYY-MM-DD (day) or YYYY-MM (month). */
  period: z.string(),
  flights: z.number(),
  completed: z.number(),
  delayed: z.number(),
  delayRate: rate,
  cancelled: z.number(),
  cancelRate: rate,
  avgArrDelay: rate,
});
export type TrendPoint = z.infer<typeof TrendPointSchema>;

export const TrendResponseSchema = z.object({
  granularity: TrendQuerySchema.shape.granularity,
  airline: z.string().nullable(),
  origin: z.string().nullable(),
  coverage: CoverageSchema,
  points: z.array(TrendPointSchema),
});
export type TrendResponse = z.infer<typeof TrendResponseSchema>;

export const CascadeRowSchema = z.object({
  hour: z.number(),
  lateAircraftMinutes: z.number(),
  totalMinutes: z.number(),
  /** Late-aircraft minutes / all cause minutes for flights departing in this hour. */
  lateAircraftShare: rate,
});
export const CascadeResponseSchema = z.object({
  coverage: CoverageSchema,
  rows: z.array(CascadeRowSchema),
});
export type CascadeResponse = z.infer<typeof CascadeResponseSchema>;

export const CANCELLATION_REASONS = {
  A: 'Airline/carrier',
  B: 'Weather',
  C: 'National Air System',
  D: 'Security',
} as const;
export type CancellationReasonCode = keyof typeof CANCELLATION_REASONS;

export const CancellationRowSchema = z.object({
  key: z.union([z.string(), z.number()]),
  label: z.string(),
  total: z.number(),
  /** Counts per BTS reason code; `unknown` = cancelled with no reason, so total = sum of all. */
  reasons: z.object({
    A: z.number(),
    B: z.number(),
    C: z.number(),
    D: z.number(),
    unknown: z.number(),
  }),
});
export const CancellationsResponseSchema = z.object({
  by: CancellationsQuerySchema.shape.by,
  rows: z.array(CancellationRowSchema),
});
export type CancellationsResponse = z.infer<typeof CancellationsResponseSchema>;

export const DelayBucketSchema = z.object({
  /** Inclusive lower bound, minutes. */
  from: z.number(),
  /** Exclusive upper bound, minutes; null for the open last bucket. */
  to: z.number().nullable(),
  label: z.string(),
  flights: z.number(),
});
export const DelayDistributionResponseSchema = z.object({
  completed: z.number(),
  buckets: z.array(DelayBucketSchema),
});
export type DelayDistributionResponse = z.infer<typeof DelayDistributionResponseSchema>;

/** One (day of week, scheduled departure hour) cell of the Explorer heatmap. */
export const HeatmapCellSchema = z.object({
  /** 1 = Monday .. 7 = Sunday. */
  dow: z.number().int().min(1).max(7),
  hour: z.number().int().min(0).max(23),
  flights: z.number(),
  completed: z.number(),
  delayed: z.number(),
  delayRate: rate,
});
export const HeatmapResponseSchema = z.object({
  /** Always null: neither key depends on an airport id, so every flight is counted. */
  coverage: CoverageSchema,
  cells: z.array(HeatmapCellSchema),
});
export type HeatmapResponse = z.infer<typeof HeatmapResponseSchema>;

export const MetaResponseSchema = z.object({
  flights: z.number(),
  dateRange: z.object({ from: z.string(), to: z.string() }).nullable(),
  airlines: z.array(z.object({ code: z.string(), name: z.string() })),
  airports: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      city: z.string().nullable(),
      state: z.string().nullable(),
    }),
  ),
  /** When build:stats last completed (ISO), or null if stats were never built. */
  statsBuiltAt: z.string().nullable(),
  /** Unresolved-airport counts from the latest stats build; null if stats were never built. */
  dataQuality: DataQualitySchema.nullable(),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

export const FlightItemSchema = z.object({
  id: z.string(),
  date: z.string(),
  airline: z.string(),
  flightNumber: z.number(),
  origin: z.string(),
  dest: z.string(),
  /** Scheduled departure, HH:MM. */
  schedDep: z.string(),
  depDelay: z.number().nullable(),
  arrDelay: z.number().nullable(),
  cancelled: z.boolean(),
  diverted: z.boolean(),
  isDelayed: z.boolean().nullable(),
});
export type FlightItem = z.infer<typeof FlightItemSchema>;

export const FlightsResponseSchema = z.object({
  items: z.array(FlightItemSchema),
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: z.string().nullable(),
});
export type FlightsResponse = z.infer<typeof FlightsResponseSchema>;
