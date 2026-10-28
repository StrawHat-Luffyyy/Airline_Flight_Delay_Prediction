import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import {
  CAUSE_KEYS,
  COMPARE_LEADER_METRICS,
  CompareCausesSchema,
  CompareMonthSchema,
  CompareTotalsSchema,
  type CompareCauses,
  type CompareDifferences,
  type CompareEntity,
  type CompareMonth,
  type CompareQuery,
  type CompareResponse,
  type CompareTotals,
  type CompareType,
  type Coverage,
  type DataQuality,
  type SampleStatus,
} from '@flight-delay/shared';
import { HttpError } from '../middleware/error.js';
import {
  DERIVED_RATES,
  SUM_OUTCOMES,
  airportLabel,
  coverageFor,
  shareExpression,
  type Labels,
} from './common.js';

interface Source {
  collection: string;
  /** Field holding the entity id; every source has an index or _id on it. */
  field: string;
}

interface CompareSource {
  /** Outcome totals, plus cause minutes when the collection stores them. */
  totals: Source & { causes: boolean };
  /** Daily documents grouped by month; null when nothing pre-aggregated covers it. */
  monthly: Source | null;
}

/**
 * Which pre-aggregated collection answers each part of a comparison. Airlines cover every flight;
 * airports are departures (origin), as in the Explorer ranking and the airport cause breakdown.
 * stats_route stores outcome counts only, so routes have no cause or monthly section.
 */
export const COMPARE_SOURCES: Record<CompareType, CompareSource> = {
  airline: {
    totals: { collection: 'stats_daily', field: 'airline', causes: true },
    monthly: { collection: 'stats_daily', field: 'airline' },
  },
  airport: {
    totals: { collection: 'stats_airport_hour', field: 'airport', causes: true },
    monthly: { collection: 'stats_daily_origin', field: 'origin' },
  },
  route: {
    totals: { collection: 'stats_route', field: '_id', causes: false },
    monthly: null,
  },
};

const UNAVAILABLE_FOR_ROUTES = {
  causes:
    'Delay-cause minutes are not pre-aggregated by route, so routes are compared on outcomes only.',
  monthly: 'Monthly figures are not pre-aggregated by route.',
};

export interface ComparePipeline {
  collection: string;
  pipeline: Document[];
}

const causeSums = Object.fromEntries(
  CAUSE_KEYS.map((cause) => [cause, { $sum: `$causeMinutes.${cause}` }]),
);

/** One row per requested id: summed counts, rates derived from the sums, and cause minutes. */
export function compareTotalsPipeline(query: CompareQuery): ComparePipeline {
  const { collection, field, causes } = COMPARE_SOURCES[query.type].totals;
  return {
    collection,
    pipeline: [
      { $match: { [field]: { $in: query.ids } } },
      {
        $group: {
          _id: `$${field}`,
          ...SUM_OUTCOMES,
          ...(causes ? { flightsWithCauses: { $sum: '$flightsWithCauses' }, ...causeSums } : {}),
        },
      },
      {
        $set: {
          ...DERIVED_RATES,
          divertRate: shareExpression('$diverted', '$flights'),
          ...(causes ? { totalMinutes: { $add: CAUSE_KEYS.map((cause) => `$${cause}`) } } : {}),
        },
      },
      {
        $project: {
          _id: 0,
          key: '$_id',
          flights: 1,
          completed: 1,
          delayed: 1,
          delayRate: 1,
          avgArrDelay: 1,
          cancelled: 1,
          cancelRate: 1,
          diverted: 1,
          divertRate: 1,
          causes: causes
            ? {
                flightsWithCauses: '$flightsWithCauses',
                totalMinutes: '$totalMinutes',
                minutes: Object.fromEntries(CAUSE_KEYS.map((cause) => [cause, `$${cause}`])),
                shares: Object.fromEntries(
                  CAUSE_KEYS.map((cause) => [cause, shareExpression(`$${cause}`, '$totalMinutes')]),
                ),
              }
            : null,
        },
      },
    ],
  };
}

/** (id, calendar month) rows from the daily stats; null when the type has no daily source. */
export function compareMonthlyPipeline(query: CompareQuery): ComparePipeline | null {
  const source = COMPARE_SOURCES[query.type].monthly;
  if (!source) return null;
  return {
    collection: source.collection,
    pipeline: [
      { $match: { [source.field]: { $in: query.ids } } },
      {
        $group: {
          _id: { key: `$${source.field}`, month: { $month: '$date' } },
          ...SUM_OUTCOMES,
        },
      },
      { $set: DERIVED_RATES },
      { $sort: { '_id.key': 1, '_id.month': 1 } },
      {
        $project: {
          _id: 0,
          key: '$_id.key',
          month: '$_id.month',
          flights: 1,
          completed: 1,
          delayed: 1,
          delayRate: 1,
          avgArrDelay: 1,
          cancelRate: 1,
        },
      },
    ],
  };
}

export const TotalsRowSchema = CompareTotalsSchema.extend({
  key: z.string(),
  causes: CompareCausesSchema.nullable(),
});
export type TotalsRow = z.infer<typeof TotalsRowSchema>;

export const MonthlyRowSchema = CompareMonthSchema.extend({ key: z.string() });
export type MonthlyRow = z.infer<typeof MonthlyRowSchema>;

// ---------- Assembly (pure) ----------

const EMPTY_TOTALS: CompareTotals = {
  flights: 0,
  completed: 0,
  delayed: 0,
  delayRate: null,
  avgArrDelay: null,
  cancelled: 0,
  cancelRate: null,
  diverted: 0,
  divertRate: null,
};

const EMPTY_CAUSES: CompareCauses = {
  flightsWithCauses: 0,
  totalMinutes: 0,
  minutes: { carrier: 0, weather: 0, nas: 0, security: 0, lateAircraft: 0 },
  shares: { carrier: null, weather: null, nas: null, security: null, lateAircraft: null },
};

const emptyMonth = (month: number): CompareMonth => ({
  month,
  flights: 0,
  completed: 0,
  delayed: 0,
  delayRate: null,
  avgArrDelay: null,
  cancelRate: null,
});

function sampleOf(flights: number, minFlights: number): SampleStatus {
  if (flights === 0) return 'none';
  return flights < minFlights ? 'low' : 'ok';
}

const difference = (value: number | null, base: number | null): number | null =>
  value === null || base === null ? null : value - base;

function differences(entity: CompareTotals, base: CompareTotals): CompareDifferences {
  return {
    flights: entity.flights - base.flights,
    completed: entity.completed - base.completed,
    delayed: entity.delayed - base.delayed,
    cancelled: entity.cancelled - base.cancelled,
    diverted: entity.diverted - base.diverted,
    delayRate: difference(entity.delayRate, base.delayRate),
    avgArrDelay: difference(entity.avgArrDelay, base.avgArrDelay),
    cancelRate: difference(entity.cancelRate, base.cancelRate),
    divertRate: difference(entity.divertRate, base.divertRate),
  };
}

/**
 * Lowest value per metric among reliable samples. Rates from equal fractions (1/3 and 2/6) are
 * the same double, so exact equality finds real ties.
 */
function leadersOf(entities: readonly CompareEntity[]): CompareResponse['leaders'] {
  const pick = (metric: (typeof COMPARE_LEADER_METRICS)[number]): string[] => {
    const eligible = entities.flatMap((entity) => {
      const value = entity.totals[metric];
      return entity.sample === 'ok' && value !== null ? [{ id: entity.id, value }] : [];
    });
    if (eligible.length < 2) return [];
    const best = Math.min(...eligible.map((entry) => entry.value));
    return eligible.filter((entry) => entry.value === best).map((entry) => entry.id);
  };
  return {
    delayRate: pick('delayRate'),
    avgArrDelay: pick('avgArrDelay'),
    cancelRate: pick('cancelRate'),
    divertRate: pick('divertRate'),
  };
}

export interface AssembleInput {
  query: CompareQuery;
  totals: readonly TotalsRow[];
  /** null when the type has no monthly source. */
  monthly: readonly MonthlyRow[] | null;
  describe: (id: string) => { label: string; detail: string | null };
  coverage: Coverage;
}

/**
 * Builds the response in the requested order. An id without a stats document (no 2015 flights)
 * still gets a column, with zero counts and null rates, rather than disappearing.
 */
export function assembleComparison(input: AssembleInput): CompareResponse {
  const { query } = input;
  const hasCauses = COMPARE_SOURCES[query.type].totals.causes;
  const byKey = new Map(input.totals.map((row) => [row.key, row]));
  const months = new Map(input.monthly?.map((row) => [`${row.key}|${row.month}`, row]) ?? []);

  const rows = query.ids.map((id) => {
    const row = byKey.get(id);
    const totals: CompareTotals = row
      ? {
          flights: row.flights,
          completed: row.completed,
          delayed: row.delayed,
          delayRate: row.delayRate,
          avgArrDelay: row.avgArrDelay,
          cancelled: row.cancelled,
          cancelRate: row.cancelRate,
          diverted: row.diverted,
          divertRate: row.divertRate,
        }
      : EMPTY_TOTALS;
    return { id, row, totals };
  });
  const baseline = rows[0]!.totals;

  const entities: CompareEntity[] = rows.map(({ id, row, totals }, index) => {
    const monthly =
      input.monthly === null
        ? null
        : Array.from({ length: 12 }, (_unused, at) => {
            const found = months.get(`${id}|${at + 1}`);
            return found ? CompareMonthSchema.parse(found) : emptyMonth(at + 1);
          });
    return {
      id,
      ...input.describe(id),
      sample: sampleOf(totals.flights, query.minFlights),
      totals,
      causes: hasCauses ? (row?.causes ?? EMPTY_CAUSES) : null,
      monthly,
      differences: index === 0 ? null : differences(totals, baseline),
    };
  });

  return {
    type: query.type,
    minFlights: query.minFlights,
    baselineId: query.ids[0]!,
    coverage: input.coverage,
    availability: query.type === 'route' ? UNAVAILABLE_FOR_ROUTES : { causes: null, monthly: null },
    leaders: leadersOf(entities),
    entities,
  };
}

// ---------- Service ----------

/** Rejects codes absent from the reference collections (422, as /predict does). */
function unknownIds(query: CompareQuery, labels: Labels): string[] {
  const isAirport = (code: string) => labels.airports.has(code);
  return query.ids.filter((id) => {
    if (query.type === 'airline') return !labels.airlines.has(id);
    if (query.type === 'airport') return !isAirport(id);
    return !isAirport(id.slice(0, 3)) || !isAirport(id.slice(4));
  });
}

function describer(type: CompareType, labels: Labels) {
  const city = (code: string) => labels.airports.get(code)?.city ?? code;
  return (id: string): { label: string; detail: string | null } => {
    if (type === 'airline') return { label: labels.airlines.get(id) ?? id, detail: null };
    if (type === 'airport') {
      return { label: airportLabel(labels, id), detail: labels.airports.get(id)?.name ?? null };
    }
    const [origin = '', dest = ''] = id.split('-');
    return { label: `${origin} → ${dest}`, detail: `${city(origin)} → ${city(dest)}` };
  };
}

const NOUN: Record<CompareType, string> = {
  airline: 'airline',
  airport: 'airport',
  route: 'route',
};

export async function getComparison(
  db: Db,
  query: CompareQuery,
  labels: Labels,
  quality: DataQuality | null,
): Promise<CompareResponse> {
  const unknown = unknownIds(query, labels);
  if (unknown.length > 0) {
    throw new HttpError(
      422,
      'UNKNOWN_ENTITY',
      `Unknown ${NOUN[query.type]}${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
      { type: query.type, ids: unknown },
    );
  }

  const totals = compareTotalsPipeline(query);
  const monthly = compareMonthlyPipeline(query);
  const [totalDocs, monthlyDocs] = await Promise.all([
    db.collection(totals.collection).aggregate(totals.pipeline).toArray(),
    monthly ? db.collection(monthly.collection).aggregate(monthly.pipeline).toArray() : null,
  ]);

  return assembleComparison({
    query,
    totals: z.array(TotalsRowSchema).parse(totalDocs),
    monthly: monthlyDocs === null ? null : z.array(MonthlyRowSchema).parse(monthlyDocs),
    describe: describer(query.type, labels),
    coverage: coverageFor(
      query.type === 'airport' ? 'origin' : query.type === 'route' ? 'route' : null,
      quality,
    ),
  });
}
