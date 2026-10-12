import type { Db, Document } from 'mongodb';
import { SummaryResponseSchema, type SummaryResponse } from '@flight-delay/shared';
import { DERIVED_RATES, SUM_OUTCOMES } from './common.js';

export const SUMMARY_SOURCE = 'stats_daily';

/** Totals over every (date, airline) document: flights, delay rate, avg arrival delay, cancel rate. */
export function summaryPipeline(): Document[] {
  return [
    { $group: { _id: null, ...SUM_OUTCOMES } },
    { $set: DERIVED_RATES },
    {
      $project: {
        _id: 0,
        flights: 1,
        completed: 1,
        delayed: 1,
        delayRate: 1,
        cancelled: 1,
        cancelRate: 1,
        diverted: 1,
        avgArrDelay: 1,
      },
    },
  ];
}

const EMPTY: SummaryResponse = {
  flights: 0,
  completed: 0,
  delayed: 0,
  delayRate: null,
  cancelled: 0,
  cancelRate: null,
  diverted: 0,
  avgArrDelay: null,
};

export async function getSummary(db: Db): Promise<SummaryResponse> {
  const [doc] = await db.collection(SUMMARY_SOURCE).aggregate(summaryPipeline()).toArray();
  return doc ? SummaryResponseSchema.parse(doc) : EMPTY;
}
