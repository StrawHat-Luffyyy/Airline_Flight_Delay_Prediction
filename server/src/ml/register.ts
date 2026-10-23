import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from 'mongodb';
import {
  ModelRunSchema,
  OperatingPointsSchema,
  type ModelRun,
  type OperatingPoints,
} from '@flight-delay/shared';
import { isDeepStrictEqual } from 'node:util';
import { FEATURE_COLUMNS, isForbiddenFeature } from '../features/feature-list.js';

export const MODEL_RUNS = 'model_runs';
export const DEFAULT_METRICS_FILE = fileURLToPath(
  new URL('../../../ml/artifacts/metrics.json', import.meta.url),
);

export type ModelRunDoc = Omit<ModelRun, 'createdAt'> & { createdAt: Date; registeredAt: Date };

export const DEFAULT_OPERATING_POINTS_FILE = fileURLToPath(
  new URL('../../../ml/artifacts/operating-points.json', import.meta.url),
);

/** Reads and validates ml/artifacts/metrics.json. */
export async function readModelRun(file = DEFAULT_METRICS_FILE): Promise<ModelRun> {
  return ModelRunSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

/** Reads ml/artifacts/operating-points.json (`ml/train.py --operating-points`); null when absent. */
export async function readOperatingPoints(
  file = DEFAULT_OPERATING_POINTS_FILE,
): Promise<OperatingPoints | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  return OperatingPointsSchema.parse(JSON.parse(text));
}

/** The run with its operating points; refuses points computed for a different model. */
export function attachOperatingPoints(run: ModelRun, points: OperatingPoints): ModelRun {
  if (points.modelVersion !== run.modelVersion) {
    throw new Error(
      `operating-points.json is for ${points.modelVersion}, not ${run.modelVersion}; run ml/train.py --operating-points again`,
    );
  }
  return { ...run, operatingPoints: points };
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
