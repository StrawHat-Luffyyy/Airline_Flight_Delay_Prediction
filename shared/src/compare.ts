import { z } from 'zod';
import { CoverageSchema } from './analytics.js';

// ---------- Query (GET /api/analytics/compare) ----------

export const COMPARE_TYPES = ['airline', 'airport', 'route'] as const;
export type CompareType = (typeof COMPARE_TYPES)[number];

/** A comparison needs at least two entities and shows at most four side by side. */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;

/** Default minimum flights before an entity's rates count as a reliable sample (as in §8). */
export const COMPARE_MIN_FLIGHTS = 500;

const ID_FORMAT: Record<CompareType, { pattern: RegExp; message: string }> = {
  airline: { pattern: /^[A-Z0-9]{2}$/, message: 'must be a 2-character IATA airline code' },
  airport: { pattern: /^[A-Z0-9]{3}$/, message: 'must be a 3-character IATA airport code' },
  route: { pattern: /^[A-Z0-9]{3}-[A-Z0-9]{3}$/, message: 'must look like JFK-LAX' },
};

/** True when `id` has the format of its entity type (the API also requires it to exist). */
export function isCompareIdFormat(type: CompareType, id: string): boolean {
  if (!ID_FORMAT[type].pattern.test(id)) return false;
  return type !== 'route' || id.slice(0, 3) !== id.slice(4);
}

/**
 * `ids` is one comma-separated list (`ids=AA,DL`), kept in the order given: the first id is the
 * baseline every difference is measured against. Codes are upper-case, as stored. Unknown keys
 * are rejected so a typo (`id=` for `ids=`) fails loudly instead of being ignored.
 */
export const CompareQuerySchema = z
  .object({
    type: z.enum(COMPARE_TYPES),
    ids: z
      .string()
      .transform((value) => value.split(',').map((id) => id.trim()))
      .pipe(
        z
          .array(z.string())
          .min(COMPARE_MIN, `ids needs at least ${COMPARE_MIN} entities`)
          .max(COMPARE_MAX, `ids allows at most ${COMPARE_MAX} entities`),
      ),
    minFlights: z.coerce.number().int().min(1).max(1_000_000).default(COMPARE_MIN_FLIGHTS),
  })
  .strict()
  .superRefine((query, context) => {
    const format = ID_FORMAT[query.type];
    const seen = new Set<string>();
    query.ids.forEach((id, index) => {
      if (!format.pattern.test(id)) {
        context.addIssue({
          code: 'custom',
          path: ['ids', index],
          message: `${id === '' ? 'An empty id' : id} ${format.message}`,
        });
      } else if (query.type === 'route' && id.slice(0, 3) === id.slice(4)) {
        context.addIssue({
          code: 'custom',
          path: ['ids', index],
          message: `${id} must join two different airports`,
        });
      }
      if (seen.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['ids', index],
          message: `${id} is listed twice`,
        });
      }
      seen.add(id);
    });
  });
export type CompareQuery = z.infer<typeof CompareQuerySchema>;

// ---------- Response ----------

const rate = z.number().nullable();
const count = z.number().int().min(0);

/** Outcome totals summed from stats_* counts; every rate is derived from the sums, never averaged. */
export const CompareTotalsSchema = z.object({
  flights: count,
  /** Flights with an arrival outcome (not cancelled, not diverted). */
  completed: count,
  /** Completed flights that arrived 15+ minutes late. */
  delayed: count,
  /** delayed / completed; null when nothing completed. */
  delayRate: rate,
  /** Mean arrival delay of completed flights in minutes (negative = early); null when none. */
  avgArrDelay: rate,
  cancelled: count,
  /** cancelled / flights; null when there are no flights. */
  cancelRate: rate,
  diverted: count,
  /** diverted / flights; null when there are no flights. */
  divertRate: rate,
});
export type CompareTotals = z.infer<typeof CompareTotalsSchema>;

const causeNumbers = z.object({
  carrier: z.number(),
  weather: z.number(),
  nas: z.number(),
  security: z.number(),
  lateAircraft: z.number(),
});

export const CompareCausesSchema = z.object({
  /** Delayed flights that reported cause minutes (BTS reports them only for 15+ min late arrivals). */
  flightsWithCauses: count,
  totalMinutes: z.number(),
  minutes: causeNumbers,
  /** Each cause's share of totalMinutes (0-1); null when totalMinutes is 0. */
  shares: z.object({
    carrier: rate,
    weather: rate,
    nas: rate,
    security: rate,
    lateAircraft: rate,
  }),
});
export type CompareCauses = z.infer<typeof CompareCausesSchema>;

export const CompareMonthSchema = z.object({
  month: z.number().int().min(1).max(12),
  flights: count,
  completed: count,
  delayed: count,
  delayRate: rate,
  avgArrDelay: rate,
  cancelRate: rate,
});
export type CompareMonth = z.infer<typeof CompareMonthSchema>;

/**
 * Difference from the baseline (first) entity: counts and minutes as absolute differences, rates
 * as fractions (0.032 = +3.2 percentage points). null when either side's value is undefined.
 */
export const CompareDifferencesSchema = z.object({
  flights: z.number(),
  completed: z.number(),
  delayed: z.number(),
  cancelled: z.number(),
  diverted: z.number(),
  delayRate: rate,
  avgArrDelay: rate,
  cancelRate: rate,
  divertRate: rate,
});
export type CompareDifferences = z.infer<typeof CompareDifferencesSchema>;

/**
 * `ok`: flights >= minFlights. `low`: some flights, but fewer than minFlights, so its rates are
 * shown with a warning and it cannot lead a metric. `none`: no 2015 flights in the stats.
 */
export const SampleStatusSchema = z.enum(['ok', 'low', 'none']);
export type SampleStatus = z.infer<typeof SampleStatusSchema>;

export const CompareEntitySchema = z.object({
  id: z.string(),
  label: z.string(),
  /** A quieter second line: an airport's city, a route's cities. */
  detail: z.string().nullable(),
  sample: SampleStatusSchema,
  totals: CompareTotalsSchema,
  /** null when the entity type has no cause data (see availability.causes). */
  causes: CompareCausesSchema.nullable(),
  /** January..December, always 12 points; null when the type has no monthly data. */
  monthly: z.array(CompareMonthSchema).nullable(),
  /** null for the baseline itself. */
  differences: CompareDifferencesSchema.nullable(),
});
export type CompareEntity = z.infer<typeof CompareEntitySchema>;

export const COMPARE_LEADER_METRICS = [
  'delayRate',
  'avgArrDelay',
  'cancelRate',
  'divertRate',
] as const;
export type CompareLeaderMetric = (typeof COMPARE_LEADER_METRICS)[number];

export const CompareResponseSchema = z.object({
  type: z.enum(COMPARE_TYPES),
  minFlights: z.number(),
  /** The first requested id; differences are measured from it. */
  baselineId: z.string(),
  coverage: CoverageSchema,
  /** Why a section is missing for this entity type; null when it is available. */
  availability: z.object({ causes: z.string().nullable(), monthly: z.string().nullable() }),
  /**
   * Lowest (best) value per metric among entities with an `ok` sample; ties list every tied id.
   * Empty when fewer than two entities have a value to compare.
   */
  leaders: z.object({
    delayRate: z.array(z.string()),
    avgArrDelay: z.array(z.string()),
    cancelRate: z.array(z.string()),
    divertRate: z.array(z.string()),
  }),
  entities: z.array(CompareEntitySchema),
});
export type CompareResponse = z.infer<typeof CompareResponseSchema>;
