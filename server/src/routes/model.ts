import { Router } from 'express';
import type { Db } from 'mongodb';
import { PredictRequestSchema, type ModelMetricsResponse } from '@flight-delay/shared';
import { TtlCache } from '../cache.js';
import { HttpError } from '../middleware/error.js';
import { parseBody } from '../middleware/validate.js';
import type { DelayModel } from '../ml/model.js';
import { predictDelay, type ReferenceData } from '../ml/predict.js';
import { featureImportance, loadServedRun } from '../ml/served-run.js';

export interface ModelRouterOptions {
  getDb: () => Db;
  /** The deployed model, or null when ml/artifacts could not be loaded at startup. */
  model: DelayModel | null;
  referenceData: ReferenceData;
  cacheTtlMs: number;
}

const modelUnavailable = (): HttpError =>
  new HttpError(503, 'MODEL_UNAVAILABLE', 'The prediction model is not loaded');

/** POST /predict, GET /model/metrics and /model/feature-importance (PROJECT_OVERVIEW §9). */
export function modelRouter({
  getDb,
  model,
  referenceData,
  cacheTtlMs,
}: ModelRouterOptions): Router {
  const router = Router();
  const runCache = new TtlCache<ModelMetricsResponse>({ ttlMs: cacheTtlMs });
  const servedRun = async (): Promise<ModelMetricsResponse> => {
    if (!model) throw modelUnavailable();
    const version = model.encoders.modelVersion;
    return runCache.getOrLoad(version, () => loadServedRun(getDb(), version));
  };

  router.post('/predict', async (request, response) => {
    if (!model) throw modelUnavailable();
    const body = parseBody(PredictRequestSchema, request.body);
    response.json(await predictDelay(body, model, referenceData));
  });

  router.get('/model/metrics', async (_request, response) => {
    response.json(await servedRun());
  });

  router.get('/model/feature-importance', async (_request, response) => {
    response.json(featureImportance(await servedRun()));
  });

  return router;
}
