/**
 * Live scoring for the speed layer (PROJECT_OVERVIEW §15.7). Every event is scored by the same
 * `predictDelay` that serves POST /api/predict (same encoders, feature builder and model), from a
 * request built only from the event's pre-departure fields. The outcome is read only afterwards,
 * to judge the prediction.
 *
 * The no-leakage guarantee has two layers:
 * - compile time: the scorer accepts only a `ScoringRequest`, a branded type that only
 *   `toScoringRequest(pre)` produces, so neither a whole event nor a hand-built object type-checks;
 * - run time: the request is re-validated with /api/predict's own strict `PredictRequestSchema`,
 *   which rejects every key beyond the five, so a cast or a spread cannot smuggle an outcome in.
 */
import {
  PredictRequestSchema,
  type FlightEvent,
  type PreDeparture,
  type PredictRequest,
  type PredictResponse,
} from '@flight-delay/shared';
import { MongoError } from 'mongodb';
import { HttpError } from '../middleware/error.js';
import type { StoredPrediction } from './store.js';

declare const scoringBrand: unique symbol;
/** A /api/predict request built from pre-departure fields only. */
export type ScoringRequest = PredictRequest & { readonly [scoringBrand]: true };

/** Scores one request: `predictDelay` bound to the loaded model and reference data. */
export type Predictor = (request: PredictRequest) => Promise<PredictResponse>;

/** The one way to make a ScoringRequest: copy the five request fields out of `pre`, by name. */
export function toScoringRequest(pre: PreDeparture): ScoringRequest {
  const request: PredictRequest = {
    date: pre.date,
    airline: pre.airline,
    origin: pre.origin,
    dest: pre.dest,
    schedDepHour: pre.schedDepHour,
  };
  return request as ScoringRequest;
}

/** Re-validates with the strict /api/predict schema, then scores. */
export async function scoreRequest(
  request: ScoringRequest,
  predict: Predictor,
): Promise<PredictResponse> {
  return predict(PredictRequestSchema.parse(request));
}

export interface ScoreResult {
  key: string;
  prediction: StoredPrediction | null;
  /** Why it could not be scored (an /api/predict error code); null when scored. */
  scoreError: string | null;
  /** Prediction vs outcome; null when unscored or the flight has no arrival outcome. */
  correct: boolean | null;
}

/**
 * Only an outage is worth redelivering the batch for: MongoDB being unreachable or failing. Any
 * other failure is about this flight (a 4xx from the predictor, or a bug its inputs trigger), so it
 * is recorded on the flight instead; retrying it would block the partition forever.
 */
function isRetryable(error: unknown): boolean {
  return error instanceof MongoError;
}

async function scoreOne(event: FlightEvent, predict: Predictor): Promise<ScoreResult> {
  const unscored = (scoreError: string): ScoreResult => ({
    key: event.key,
    prediction: null,
    scoreError,
    correct: null,
  });
  const request = toScoringRequest(event.pre);
  // An event can be schema-valid yet not a valid /api/predict request (a numeric BTS airport id).
  if (!PredictRequestSchema.safeParse(request).success) return unscored('INVALID_REQUEST');
  let response: PredictResponse;
  try {
    response = await scoreRequest(request, predict);
  } catch (error) {
    if (isRetryable(error)) throw error; // fail the batch so Kafka redelivers it
    if (error instanceof HttpError && error.status < 500) return unscored(error.code);
    return unscored('SCORING_FAILED');
  }
  const prediction: StoredPrediction = {
    probability: response.probability,
    label: response.label,
    threshold: response.threshold,
    modelVersion: response.modelVersion,
  };
  // Only now is the outcome read.
  const actual = event.outcome.isDelayed;
  return {
    key: event.key,
    prediction,
    scoreError: null,
    correct: actual === null ? null : (prediction.label === 'delayed') === actual,
  };
}

/** Events scored concurrently per call; the model call itself is tiny (6 rows per flight). */
const CONCURRENCY = 32;

/** Scores each distinct flight key once (a batch can hold two deliveries of one flight). */
export async function scoreEvents(
  events: readonly FlightEvent[],
  predict: Predictor,
): Promise<ScoreResult[]> {
  const unique = [...new Map(events.map((event) => [event.key, event])).values()];
  const results: ScoreResult[] = [];
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const chunk = unique.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(chunk.map((event) => scoreOne(event, predict)))));
  }
  return results;
}
