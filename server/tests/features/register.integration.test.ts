import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelRun } from '@flight-delay/shared';
import { FEATURE_COLUMNS } from '../../src/features/feature-list.js';
import { registerModelRun } from '../../src/ml/register.js';

// Needs a reachable MongoDB (MONGODB_URI from vitest.config.ts); skipped when there is none.
const TEST_DB = 'flight_delay_register_test';

let client: MongoClient | undefined;
let db: Db;

const evaluation = {
  auc: 0.7,
  prAuc: 0.35,
  precision: 0.3,
  recall: 0.5,
  f1: 0.375,
  threshold: 0.2,
  confusion: { tn: 10, fp: 5, fn: 3, tp: 4 },
};
const baseline = { ...evaluation, auc: 0.5, threshold: null };

const RUN: ModelRun = {
  modelVersion: 'lightgbm-20261013000000-abcdef12',
  createdAt: '2026-10-13T00:00:00+00:00',
  algorithm: 'lightgbm',
  featureList: [...FEATURE_COLUMNS],
  trainRange: { from: '2015-01-01', to: '2015-09-30', rows: 100 },
  validation: { month: 9, rows: 10, usedFor: 'early stopping, threshold, model selection' },
  testRange: { from: '2015-10-01', to: '2015-12-31', rows: 50 },
  excluded: { unresolvedAirport: 1, noOutcome: 2 },
  classBalance: { trainDelayRate: 0.19, testDelayRate: 0.17 },
  threshold: {
    value: 0.2,
    chosenOn: 'validation (September)',
    criterion: 'max F1 on the PR curve',
  },
  metrics: evaluation,
  models: {
    baseline: { validation: baseline, test: baseline },
    logisticRegression: { validation: evaluation, test: evaluation },
    lightgbm: { bestIteration: 120, validation: evaluation, test: evaluation },
  },
  featureImportance: [{ feature: 'routeRate', importance: 1 }],
  onnx: { maxAbsDiffVsNative: 1e-7, rowsChecked: 50, sizeBytes: 1000 },
  durationSeconds: 1,
  versions: { lightgbm: '4.7.0' },
};

beforeAll(async () => {
  const candidate = new MongoClient(process.env.MONGODB_URI ?? '', {
    serverSelectionTimeoutMS: 2_000,
  });
  try {
    await candidate.connect();
    client = candidate;
  } catch {
    await candidate.close();
    return;
  }
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterAll(async () => {
  if (!client) return;
  await client.db(TEST_DB).dropDatabase();
  await client.close();
});

describe('registerModelRun (MongoDB integration)', () => {
  it('stores the run once per modelVersion (idempotent)', async (context) => {
    if (!client) return context.skip();
    await registerModelRun(db, RUN);
    await registerModelRun(db, RUN);
    const docs = await db.collection('model_runs').find().toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ modelVersion: RUN.modelVersion, algorithm: 'lightgbm' });
    expect(docs[0]?.createdAt).toBeInstanceOf(Date);
    expect(docs[0]?.metrics).toMatchObject({ auc: 0.7 });
  });

  it('refuses a run that lists a forbidden feature', async (context) => {
    if (!client) return context.skip();
    await expect(
      registerModelRun(db, { ...RUN, modelVersion: 'leaky', featureList: ['month', 'depDelay'] }),
    ).rejects.toThrow(/forbidden/);
    expect(await db.collection('model_runs').countDocuments({ modelVersion: 'leaky' })).toBe(0);
  });

  it('refuses a run trained on a different feature list than the TypeScript contract', async (context) => {
    if (!client) return context.skip();
    await expect(
      registerModelRun(db, {
        ...RUN,
        modelVersion: 'drifted',
        featureList: ['month', 'routeRate'],
      }),
    ).rejects.toThrow(/feature contract/);
    expect(await db.collection('model_runs').countDocuments({ modelVersion: 'drifted' })).toBe(0);
  });
});
