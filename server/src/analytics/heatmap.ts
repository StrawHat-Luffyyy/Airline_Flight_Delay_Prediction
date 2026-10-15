import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import { HeatmapCellSchema, type HeatmapResponse } from '@flight-delay/shared';

// ---------- Hour x day-of-week heatmap (§10 Explorer) ----------

export const HEATMAP_SOURCE = 'stats_dow_hour';

/** Reads the 168 pre-aggregated cells in (day of week, hour) order. */
export function heatmapPipeline(): Document[] {
  return [
    { $sort: { dow: 1, hour: 1 } },
    { $project: { _id: 0, dow: 1, hour: 1, flights: 1, completed: 1, delayed: 1, delayRate: 1 } },
  ];
}

export async function getHeatmap(db: Db): Promise<HeatmapResponse> {
  const docs = await db.collection(HEATMAP_SOURCE).aggregate(heatmapPipeline()).toArray();
  return { coverage: null, cells: z.array(HeatmapCellSchema).parse(docs) };
}
