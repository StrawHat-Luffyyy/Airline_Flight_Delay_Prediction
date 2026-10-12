import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import {
  DelayRateRowSchema,
  type DelayRateQuery,
  type DelayRateResponse,
} from '@flight-delay/shared';
import {
  DAY_NAMES,
  DERIVED_RATES,
  SUM_OUTCOMES,
  airportLabel,
  hourLabel,
  type Labels,
} from './common.js';

type By = DelayRateQuery['by'];

/** Which stats collection serves each dimension, and the field that becomes the row key. */
export const DELAY_RATE_SOURCES: Record<By, { collection: string; key: string }> = {
  airline: { collection: 'stats_daily', key: '$airline' },
  dow: { collection: 'stats_daily', key: '$dayOfWeek' },
  origin: { collection: 'stats_airport_hour', key: '$airport' },
  hour: { collection: 'stats_airport_hour', key: '$hour' },
  route: { collection: 'stats_route', key: '$route' },
};

/** dow and hour are short fixed series (7 and 24): returned whole, in key order. */
const isSeries = (by: By): boolean => by === 'dow' || by === 'hour';

/**
 * Delay rate (delayed / completed) by one dimension. Groups below minFlights are dropped so
 * tiny groups cannot top the ranking (§8). Rankings sort by rate, ties by key.
 */
export function delayRatePipeline(query: DelayRateQuery): Document[] {
  const { key } = DELAY_RATE_SOURCES[query.by];
  const order = query.order === 'worst' ? -1 : 1;
  return [
    { $group: { _id: key, ...SUM_OUTCOMES } },
    { $set: DERIVED_RATES },
    { $match: { flights: { $gte: query.minFlights }, completed: { $gt: 0 } } },
    ...(isSeries(query.by)
      ? [{ $sort: { _id: 1 } }]
      : [{ $sort: { delayRate: order, _id: 1 } }, { $limit: query.limit }]),
    {
      $project: {
        _id: 0,
        key: '$_id',
        flights: 1,
        completed: 1,
        delayed: 1,
        delayRate: 1,
        avgArrDelay: 1,
      },
    },
  ];
}

const RowWithoutLabel = DelayRateRowSchema.omit({ label: true });

function label(by: By, key: string | number, labels: Labels): string {
  if (by === 'airline') return labels.airlines.get(String(key)) ?? String(key);
  if (by === 'origin') return airportLabel(labels, String(key));
  if (by === 'dow') return DAY_NAMES[Number(key)] ?? String(key);
  if (by === 'hour') return hourLabel(Number(key));
  return String(key);
}

export async function getDelayRate(
  db: Db,
  query: DelayRateQuery,
  labels: Labels,
): Promise<DelayRateResponse> {
  const docs = await db
    .collection(DELAY_RATE_SOURCES[query.by].collection)
    .aggregate(delayRatePipeline(query))
    .toArray();
  const rows = z.array(RowWithoutLabel).parse(docs);
  return {
    by: query.by,
    order: query.order,
    minFlights: query.minFlights,
    rows: rows.map((row) => ({ ...row, label: label(query.by, row.key, labels) })),
  };
}
