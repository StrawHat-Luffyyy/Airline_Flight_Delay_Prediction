import type { Db } from 'mongodb';
import {
  PredictResponseSchema,
  RATE_FEATURES,
  type PredictRequest,
  type PredictResponse,
  type TopFactor,
} from '@flight-delay/shared';
import type { FeatureColumn } from '../features/feature-list.js';
import { loadLookupTable } from '../features/lookup.js';
import { buildFeatureRow, type FeatureRow, type LookupTable } from '../features/row.js';
import { HttpError } from '../middleware/error.js';
import { encodeFeatures } from './encoders.js';
import type { DelayModel } from './model.js';

/** Pre-departure route facts /predict derives server-side (from stats_route). */
export interface RouteInfo {
  distance: number;
  scheduledTime: number | null;
}

/** What /predict reads from MongoDB; injected so the service is testable without a database. */
export interface ReferenceData {
  hasAirline(code: string): Promise<boolean>;
  hasAirport(code: string): Promise<boolean>;
  route(origin: string, dest: string): Promise<RouteInfo | null>;
  /** delay_lookup (train split only), held in memory. */
  lookups(): Promise<LookupTable>;
}

interface CodeDoc {
  _id: string;
}
interface RouteDoc {
  _id: string;
  distance?: unknown;
  scheduledTime?: unknown;
}

/**
 * ReferenceData backed by airlines, airports, stats_route and delay_lookup. delay_lookup is read
 * once per process (tens of thousands of entries); restart the API after `npm run build:lookup`.
 */
export function mongoReferenceData(getDb: () => Db): ReferenceData {
  let lookups: Promise<LookupTable> | undefined;
  const exists = async (collection: string, code: string): Promise<boolean> =>
    (await getDb().collection<CodeDoc>(collection).countDocuments({ _id: code }, { limit: 1 })) > 0;

  return {
    hasAirline: (code) => exists('airlines', code),
    hasAirport: (code) => exists('airports', code),
    async route(origin, dest) {
      const doc = await getDb()
        .collection<RouteDoc>('stats_route')
        .findOne(
          { _id: `${origin}-${dest}` },
          { projection: { _id: 0, distance: 1, scheduledTime: 1 } },
        );
      if (!doc || typeof doc.distance !== 'number') return null;
      return {
        distance: doc.distance,
        scheduledTime: typeof doc.scheduledTime === 'number' ? doc.scheduledTime : null,
      };
    },
    lookups() {
      lookups ??= loadLookupTable(getDb()).catch((error: unknown) => {
        lookups = undefined; // retry on the next request instead of caching the failure
        throw error;
      });
      return lookups;
    },
  };
}

// Compile-time guard: every shared rate feature is a model feature, so occlusion always applies.
const OCCLUDED: readonly FeatureColumn[] = RATE_FEATURES;

const unknownCode = (field: 'airline' | 'origin' | 'dest', value: string): HttpError =>
  new HttpError(422, 'UNKNOWN_CODE', `Unknown ${field} code ${value}`, { field, value });

/** ISO weekday as stored in flights.dayOfWeek: 1 = Monday .. 7 = Sunday. */
const isoDayOfWeek = (date: Date): number => ((date.getUTCDay() + 6) % 7) + 1;

/**
 * Scores one flight with the deployed model. Only the five request fields come from the client;
 * calendar, route and historical-rate features are derived here exactly as export:training did
 * for test rows (full-scope delay_lookup). topFactors re-score the flight with each rate replaced
 * by the network-wide train rate (occlusion), in the same batched model call.
 */
export async function predictDelay(
  request: PredictRequest,
  model: DelayModel,
  reference: ReferenceData,
): Promise<PredictResponse> {
  const [airlineOk, originOk, destOk] = await Promise.all([
    reference.hasAirline(request.airline),
    reference.hasAirport(request.origin),
    reference.hasAirport(request.dest),
  ]);
  if (!airlineOk) throw unknownCode('airline', request.airline);
  if (!originOk) throw unknownCode('origin', request.origin);
  if (!destOk) throw unknownCode('dest', request.dest);

  const route = await reference.route(request.origin, request.dest);
  if (!route) {
    throw new HttpError(
      422,
      'UNKNOWN_ROUTE',
      `No 2015 flights on ${request.origin}-${request.dest}; distance and schedule are unknown`,
      { origin: request.origin, dest: request.dest },
    );
  }

  const scope = model.encoders.lookupScope;
  const lookups = await reference.lookups();
  const date = new Date(`${request.date}T00:00:00.000Z`);
  const dayOfWeek = isoDayOfWeek(date);
  const row = buildFeatureRow(
    {
      date,
      month: date.getUTCMonth() + 1,
      dayOfWeek,
      schedDepHour: request.schedDepHour,
      airline: request.airline,
      origin: request.origin,
      dest: request.dest,
      distance: route.distance,
      scheduledTime: route.scheduledTime,
    },
    lookups,
    scope,
  );

  const baseline = lookups.global(scope);
  const occluded: FeatureRow[] = OCCLUDED.map((feature) => ({ ...row, [feature]: baseline }));
  const scores = await model.predict(
    [row, ...occluded].map((r) => encodeFeatures(r, model.encoders)),
  );
  const [probability, ...without] = scores;
  if (probability === undefined || without.length !== OCCLUDED.length) {
    throw new Error(`Model returned ${scores.length} scores for ${OCCLUDED.length + 1} rows`);
  }

  const topFactors: TopFactor[] = RATE_FEATURES.map((feature, i) => ({
    feature,
    value: Number(row[feature]),
    baseline,
    impact: probability - (without[i] ?? probability), // length checked above
  })).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));

  const threshold = model.encoders.threshold;
  // Parsed so a contract break surfaces as a 500, never as a silently malformed response.
  return PredictResponseSchema.parse({
    probability,
    label: probability >= threshold ? 'delayed' : 'on-time',
    threshold,
    modelVersion: model.encoders.modelVersion,
    derived: {
      dayOfWeek,
      isHolidayWeek: row.isHolidayWeek === 1,
      distance: route.distance,
      scheduledTime: route.scheduledTime,
    },
    topFactors,
  });
}
