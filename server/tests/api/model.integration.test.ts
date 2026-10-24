import { existsSync } from 'node:fs';
import { MongoClient, type Db, type Document } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FeatureImportanceResponseSchema,
  ModelMetricsResponseSchema,
  PredictResponseSchema,
} from '@flight-delay/shared';
import { createApp } from '../../src/app.js';
import { DEFAULT_ARTIFACTS_DIR, loadModel, type DelayModel } from '../../src/ml/model.js';
import { readModelRun, registerModelRun } from '../../src/ml/register.js';
import { useIntegrationTimeouts } from '../helpers/integration.js';

useIntegrationTimeouts();

// Needs a reachable MongoDB (MONGODB_URI from vitest.config.ts) and ml/artifacts; skipped otherwise.
const TEST_DB = 'flight_delay_model_test';
const hasArtifacts = existsSync(`${DEFAULT_ARTIFACTS_DIR}/model.onnx`);

let client: MongoClient | undefined;
let db: Db;
let model: DelayModel;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  if (!hasArtifacts) return;
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
  model = await loadModel();

  await db.collection('airlines').insertOne({ _id: 'AA', name: 'American' } as unknown as Document);
  await db
    .collection('airports')
    .insertMany([{ _id: 'ORD' }, { _id: 'LAX' }, { _id: 'BOS' }] as unknown as Document[]);
  await db
    .collection('stats_route')
    .insertOne({ _id: 'ORD-LAX', distance: 1744, scheduledTime: 273 } as unknown as Document);
  await db.collection('delay_lookup').insertMany([
    { scope: 'full', kind: 'global', key: '', rate: 0.19 },
    { scope: 'full', kind: 'airline', key: 'AA', rate: 0.2 },
    { scope: 'full', kind: 'originHour', key: 'ORD|17', rate: 0.32 },
  ]);

  // The served run plus a NEWER run that is not deployed: /model/* must serve the former.
  const served = await readModelRun();
  await registerModelRun(db, served);
  await registerModelRun(db, {
    ...served,
    modelVersion: 'lightgbm-29990101000000-00000000',
    createdAt: '2999-01-01T00:00:00+00:00',
  });

  app = createApp({ pingMongo: async () => true, getDb: () => db, model, cacheTtlMs: 0 });
});

afterAll(async () => {
  if (!client) return;
  await model.close(); // loaded whenever a client connected
  await client.db(TEST_DB).dropDatabase();
  await client.close();
});

describe('/predict and /model/* with the real ONNX model (MongoDB integration)', () => {
  it('scores a flight from MongoDB reference data', async (context) => {
    if (!client) return context.skip();
    const response = await request(app)
      .post('/api/predict')
      .send({ date: '2015-12-21', airline: 'AA', origin: 'ORD', dest: 'LAX', schedDepHour: 17 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = PredictResponseSchema.parse(response.body);
    expect(result.modelVersion).toBe(model.encoders.modelVersion);
    expect(result.probability).toBeGreaterThan(0);
    expect(result.probability).toBeLessThan(1);
    expect(result.derived).toMatchObject({ dayOfWeek: 1, distance: 1744, scheduledTime: 273 });
    expect(result.topFactors).toHaveLength(5);
    const routeFactor = result.topFactors.find((f) => f.feature === 'routeRate');
    // No route entry in delay_lookup: the rate falls back to the global rate, so no impact.
    expect(routeFactor).toMatchObject({ value: expect.closeTo(0.19, 6), impact: 0 });
  });

  it('422s a route with no flights and an airport not in MongoDB', async (context) => {
    if (!client) return context.skip();
    const base = { date: '2015-12-21', airline: 'AA', origin: 'ORD', schedDepHour: 17 };
    const route = await request(app)
      .post('/api/predict')
      .send({ ...base, dest: 'BOS' });
    expect(route.body.error.code).toBe('UNKNOWN_ROUTE');
    const airport = await request(app)
      .post('/api/predict')
      .send({ ...base, dest: 'SFO' });
    expect(airport.status).toBe(422);
    expect(airport.body.error.details).toEqual({ field: 'dest', value: 'SFO' });
  });

  it('/model/metrics serves the deployed run, not the newest one', async (context) => {
    if (!client) return context.skip();
    const response = await request(app).get('/api/model/metrics');
    expect(response.status).toBe(200);
    const run = ModelMetricsResponseSchema.parse(response.body);
    expect(run.modelVersion).toBe(model.encoders.modelVersion);
  });

  it('/model/feature-importance is sorted by importance', async (context) => {
    if (!client) return context.skip();
    const body = FeatureImportanceResponseSchema.parse(
      (await request(app).get('/api/model/feature-importance')).body,
    );
    const values = body.features.map((f) => f.importance);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(body.modelVersion).toBe(model.encoders.modelVersion);
  });

  it('/model/metrics is 404 when the served model was never registered', async (context) => {
    if (!client) return context.skip();
    const unregistered = createApp({
      pingMongo: async () => true,
      getDb: () => db,
      model: { ...model, encoders: { ...model.encoders, modelVersion: 'never-registered' } },
      cacheTtlMs: 0,
    });
    const response = await request(unregistered).get('/api/model/metrics');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('MODEL_NOT_REGISTERED');
  });
});
