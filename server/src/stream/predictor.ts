import type { Db } from 'mongodb';
import { loadModel, type DelayModel } from '../ml/model.js';
import { mongoReferenceData, predictDelay } from '../ml/predict.js';
import { cachedReferenceData } from './reference-cache.js';
import type { Predictor } from './score.js';

/**
 * The live scorer: the model /api/predict serves (ml/artifacts/model.onnx and its encoders) and
 * `predictDelay`, reading reference data and delay_lookup from `db` (read-only).
 */
export async function createPredictor(db: Db): Promise<{ predict: Predictor; model: DelayModel }> {
  const model = await loadModel();
  const reference = cachedReferenceData(mongoReferenceData(() => db));
  return { predict: (request) => predictDelay(request, model, reference), model };
}
