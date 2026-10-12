import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import {
  CAUSE_KEYS,
  CauseRowSchema,
  type CausesQuery,
  type CausesResponse,
  type DataQuality,
} from '@flight-delay/shared';
import {
  MONTH_NAMES,
  airportLabel,
  coverageFor,
  hourLabel,
  shareExpression,
  type Labels,
} from './common.js';

type By = CausesQuery['by'];

interface CauseSource {
  collection: string;
  key: string | null;
  /** Prefix of the stored cause-minute fields in that collection. */
  fieldPrefix: string;
}

/** overall/airline/month read stats_cause_monthly; airport/hour read stats_airport_hour. */
export const CAUSE_SOURCES: Record<By, CauseSource> = {
  overall: { collection: 'stats_cause_monthly', key: null, fieldPrefix: '$' },
  airline: { collection: 'stats_cause_monthly', key: '$airline', fieldPrefix: '$' },
  month: { collection: 'stats_cause_monthly', key: '$month', fieldPrefix: '$' },
  airport: { collection: 'stats_airport_hour', key: '$airport', fieldPrefix: '$causeMinutes.' },
  hour: { collection: 'stats_airport_hour', key: '$hour', fieldPrefix: '$causeMinutes.' },
};

const isSeries = (by: By): boolean => by === 'month' || by === 'hour' || by === 'overall';

/** Total delay minutes per cause and each cause's share, by one dimension (§8.1, §8.2). */
export function causesPipeline(query: CausesQuery): Document[] {
  const source = CAUSE_SOURCES[query.by];
  const sums = Object.fromEntries(
    CAUSE_KEYS.map((cause) => [cause, { $sum: `${source.fieldPrefix}${cause}` }]),
  );
  return [
    { $group: { _id: source.key, ...sums } },
    { $set: { totalMinutes: { $add: CAUSE_KEYS.map((cause) => `$${cause}`) } } },
    ...(isSeries(query.by)
      ? [{ $sort: { _id: 1 } }]
      : [{ $sort: { totalMinutes: -1, _id: 1 } }, { $limit: query.limit }]),
    {
      $project: {
        _id: 0,
        key: { $ifNull: ['$_id', 'overall'] },
        minutes: Object.fromEntries(CAUSE_KEYS.map((cause) => [cause, `$${cause}`])),
        totalMinutes: 1,
        shares: Object.fromEntries(
          CAUSE_KEYS.map((cause) => [cause, shareExpression(`$${cause}`, '$totalMinutes')]),
        ),
      },
    },
  ];
}

const RowWithoutLabel = CauseRowSchema.omit({ label: true });

function label(by: By, key: string | number, labels: Labels): string {
  if (by === 'overall') return 'All flights';
  if (by === 'airline') return labels.airlines.get(String(key)) ?? String(key);
  if (by === 'airport') return airportLabel(labels, String(key));
  if (by === 'month') return MONTH_NAMES[Number(key)] ?? String(key);
  return hourLabel(Number(key));
}

export async function getCauses(
  db: Db,
  query: CausesQuery,
  labels: Labels,
  quality: DataQuality | null,
): Promise<CausesResponse> {
  const docs = await db
    .collection(CAUSE_SOURCES[query.by].collection)
    .aggregate(causesPipeline(query))
    .toArray();
  const rows = z.array(RowWithoutLabel).parse(docs);
  return {
    by: query.by,
    coverage: coverageFor(query.by === 'airport' || query.by === 'hour' ? 'origin' : null, quality),
    rows: rows.map((row) => ({ ...row, label: label(query.by, row.key, labels) })),
  };
}
