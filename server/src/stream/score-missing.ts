/**
 * Scores stream_flights documents that were stored without a score (flights consumed before live
 * scoring existed, in 8c). It uses the same `scoreEvents` as the consumer, walks `_id` order in
 * bounded batches, and only fills documents that are still unscored, so a re-run is a no-op.
 *
 * With `retryRefused` it also re-scores flights whose earlier attempt may succeed now: a route or
 * code that was unknown when the flight arrived may exist after `build:stats` or a reference
 * reload, and SCORING_FAILED may have been transient (a retry that fails that way stays
 * retryable). INVALID_REQUEST (the event itself cannot form a request) stays as recorded.
 */
import { FlightOutcomeSchema, PreDepartureSchema, type FlightEvent } from '@flight-delay/shared';
import type { AnyBulkWriteOperation, Collection, Filter } from 'mongodb';
import { scoreEvents, type Predictor } from './score.js';
import type { StreamFlightDoc } from './store.js';

const UNSCORED: Filter<StreamFlightDoc> = { prediction: null, scoreError: null };

/**
 * Score errors worth another attempt: /api/predict refusals that depend on rebuildable data
 * (stats_route, airlines, airports), and an unexpected scoring failure that may have been transient.
 */
export const RETRYABLE_SCORE_ERRORS = ['UNKNOWN_ROUTE', 'UNKNOWN_CODE', 'SCORING_FAILED'] as const;

const UNSCORED_OR_RETRYABLE: Filter<StreamFlightDoc> = {
  prediction: null,
  scoreError: { $in: [null, ...RETRYABLE_SCORE_ERRORS] },
};

export interface ScoreMissingSummary {
  scanned: number;
  scored: number;
  refused: number;
}

export async function scoreMissing(
  flights: Collection<StreamFlightDoc>,
  predict: Predictor,
  {
    batchSize = 1_000,
    onProgress,
    retryRefused = false,
  }: {
    batchSize?: number;
    onProgress?: (s: ScoreMissingSummary) => void;
    /** Also re-score RETRYABLE_SCORE_ERRORS. */
    retryRefused?: boolean;
  } = {},
): Promise<ScoreMissingSummary> {
  const pending = retryRefused ? UNSCORED_OR_RETRYABLE : UNSCORED;
  const summary: ScoreMissingSummary = { scanned: 0, scored: 0, refused: 0 };
  let after: string | undefined;
  for (;;) {
    const page = await flights
      .find(after === undefined ? pending : { ...pending, _id: { $gt: after } }, {
        projection: { _id: 1, runId: 1, pre: 1, outcome: 1, producedAt: 1 },
      })
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();
    if (page.length === 0) return summary;
    after = page[page.length - 1]!._id;
    summary.scanned += page.length;

    // Rebuild the event from the stored parts; the scorer still sees only `pre` (via
    // toScoringRequest), and the outcome only after scoring.
    // Stored parts are re-validated, so a corrupted document is a clear error, not a silent
    // INVALID_REQUEST.
    const events: FlightEvent[] = page.map((doc) => ({
      v: 1,
      key: doc._id,
      runId: doc.runId,
      producedAt: doc.producedAt.getTime(),
      pre: PreDepartureSchema.parse(doc.pre),
      outcome: FlightOutcomeSchema.parse(doc.outcome),
    }));
    const scores = await scoreEvents(events, predict);
    const operations: AnyBulkWriteOperation<StreamFlightDoc>[] = scores.map((score) => ({
      updateOne: {
        // Still pending: a consumer that scored it meanwhile wins.
        filter: { _id: score.key, ...pending },
        update: {
          $set: {
            prediction: score.prediction,
            scoreError: score.scoreError,
            correct: score.correct,
          },
        },
      },
    }));
    const result = await flights.bulkWrite(operations, { ordered: false });
    // Counted from the flights still pending at write time: one a consumer scored meanwhile no
    // longer matches. Matched, not modified: a refusal recorded again unchanged is still counted.
    const written = result.matchedCount;
    const refusedInPage = scores.filter((score) => score.prediction === null).length;
    summary.refused += Math.min(refusedInPage, written);
    summary.scored += written - Math.min(refusedInPage, written);
    onProgress?.(summary);
  }
}
