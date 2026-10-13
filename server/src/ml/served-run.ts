import type { Db } from 'mongodb';
import {
  ModelMetricsResponseSchema,
  type FeatureImportanceResponse,
  type ModelMetricsResponse,
} from '@flight-delay/shared';
import { HttpError } from '../middleware/error.js';
import { MODEL_RUNS } from './register.js';

const iso = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value);

/**
 * The model_runs document of the SERVED model (encoders.json modelVersion), not merely the newest
 * run: model_runs keeps history (DECISIONS, Phase 4).
 */
export async function loadServedRun(db: Db, modelVersion: string): Promise<ModelMetricsResponse> {
  const doc = await db.collection(MODEL_RUNS).findOne({ modelVersion }, { projection: { _id: 0 } });
  if (!doc) {
    throw new HttpError(
      404,
      'MODEL_NOT_REGISTERED',
      `Model ${modelVersion} is not in model_runs; run npm run ml:register`,
    );
  }
  return ModelMetricsResponseSchema.parse({
    ...doc,
    createdAt: iso(doc.createdAt),
    registeredAt: iso(doc.registeredAt),
  });
}

/** Feature importance of a run, most important first. */
export function featureImportance(run: ModelMetricsResponse): FeatureImportanceResponse {
  return {
    modelVersion: run.modelVersion,
    features: [...run.featureImportance].sort((a, b) => b.importance - a.importance),
  };
}
