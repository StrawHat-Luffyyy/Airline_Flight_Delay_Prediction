import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from 'mongodb';
import { ModelRunSchema, type ModelRun } from '@flight-delay/shared';
import { isDeepStrictEqual } from 'node:util';
import { FEATURE_COLUMNS, isForbiddenFeature } from '../features/feature-list.js';

export const MODEL_RUNS = 'model_runs';
export const DEFAULT_METRICS_FILE = fileURLToPath(
  new URL('../../../ml/artifacts/metrics.json', import.meta.url),
);

export type ModelRunDoc = Omit<ModelRun, 'createdAt'> & { createdAt: Date; registeredAt: Date };

/** Reads and validates ml/artifacts/metrics.json. */
export async function readModelRun(file = DEFAULT_METRICS_FILE): Promise<ModelRun> {
  return ModelRunSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

/**
 * Upserts a training run into model_runs by modelVersion (re-registering is a no-op change).
 * Refuses runs whose feature list contains a post-departure feature (§7) or differs from
 * FEATURE_COLUMNS (the order /predict encodes in).
 */
export async function registerModelRun(db: Db, run: ModelRun): Promise<ModelRunDoc> {
  const leaked = run.featureList.filter(isForbiddenFeature);
  if (leaked.length > 0) {
    throw new Error(`Model run ${run.modelVersion} lists forbidden features: ${leaked.join(', ')}`);
  }
  if (!isDeepStrictEqual(run.featureList, [...FEATURE_COLUMNS])) {
    throw new Error(
      `Model run ${run.modelVersion} does not match the TypeScript feature contract (FEATURE_COLUMNS); /predict could not encode its inputs.`,
    );
  }
  const doc: ModelRunDoc = { ...run, createdAt: new Date(run.createdAt), registeredAt: new Date() };
  await db
    .collection<ModelRunDoc>(MODEL_RUNS)
    .replaceOne({ modelVersion: run.modelVersion }, doc, { upsert: true });
  await db.collection(MODEL_RUNS).createIndex({ modelVersion: 1 }, { unique: true });
  await db.collection(MODEL_RUNS).createIndex({ createdAt: -1 });
  return doc;
}
