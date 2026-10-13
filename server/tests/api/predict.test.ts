import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PredictResponseSchema } from '@flight-delay/shared';
import { createApp } from '../../src/app.js';
import { FEATURE_COLUMNS } from '../../src/features/feature-list.js';
import { LookupTable } from '../../src/features/row.js';
import type { Encoders } from '../../src/ml/encoders.js';
import type { DelayModel } from '../../src/ml/model.js';
import type { ReferenceData } from '../../src/ml/predict.js';

const encoders: Encoders = {
  modelVersion: 'fake-model',
  algorithm: 'lightgbm',
  featureOrder: [...FEATURE_COLUMNS],
  categorical: { airline: { AA: 0 }, origin: { ORD: 0 }, dest: { LAX: 0 } },
  unknownCategoryCode: -1,
  imputation: { scheduledTime: 122 },
  lookupScope: 'full',
  threshold: 0.2,
  onnx: { input: 'features', inputType: 'float32', probabilityOutputColumn: 1 },
};

const RATE_COLUMNS = [8, 9, 10, 11, 12]; // airlineRate .. routeRate in FEATURE_COLUMNS

/**
 * Stand-in model: P(delayed) = the mean of the five historical rates. These tests check feature
 * derivation, occlusion, labelling and errors; the real model is covered by ml/parity.test.ts.
 */
const fakeModel: DelayModel = {
  encoders,
  predict: async (rows) =>
    rows.map((row) => RATE_COLUMNS.reduce((sum, i) => sum + (row[i] ?? 0), 0) / 5),
  close: async () => undefined,
};

const constantModel = (p: number): DelayModel => ({
  ...fakeModel,
  predict: async (rows) => rows.map(() => p),
});

const lookups = new LookupTable([
  { scope: 'full', kind: 'global', key: '', rate: 0.2 },
  { scope: 'full', kind: 'airline', key: 'AA', rate: 0.3 },
  { scope: 'full', kind: 'origin', key: 'ORD', rate: 0.25 },
  { scope: 'full', kind: 'originHour', key: 'ORD|17', rate: 0.4 },
]);

const reference: ReferenceData = {
  hasAirline: async (code) => code === 'AA',
  hasAirport: async (code) => ['ORD', 'LAX', 'BOS'].includes(code),
  route: async (origin, dest) =>
    origin === 'ORD' && dest === 'LAX' ? { distance: 1744, scheduledTime: 270 } : null,
  lookups: async () => lookups,
};

const body = { date: '2015-12-23', airline: 'AA', origin: 'ORD', dest: 'LAX', schedDepHour: 17 };

function app(model: DelayModel | null = fakeModel) {
  return createApp({ pingMongo: async () => true, model, referenceData: reference, cacheTtlMs: 0 });
}

describe('POST /api/predict', () => {
  it('returns the probability, label, derived inputs and occlusion factors', async () => {
    const response = await request(app()).post('/api/predict').send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = PredictResponseSchema.parse(response.body);

    // mean(0.3 airline, 0.25 origin, 0.2 dest -> global, 0.4 ORD|17, 0.2 route -> global) = 0.27
    expect(result.probability).toBeCloseTo(0.27, 6);
    expect(result).toMatchObject({ label: 'delayed', threshold: 0.2, modelVersion: 'fake-model' });
    // 2015-12-23 is a Wednesday, two days before Christmas.
    expect(result.derived).toEqual({
      dayOfWeek: 3,
      isHolidayWeek: true,
      distance: 1744,
      scheduledTime: 270,
    });
    expect(result.topFactors.map((f) => f.feature).slice(0, 3)).toEqual([
      'originHourRate',
      'airlineRate',
      'originRate',
    ]);
    expect(result.topFactors[0]).toMatchObject({ value: expect.closeTo(0.4, 6), baseline: 0.2 });
    expect(result.topFactors[0]?.impact).toBeCloseTo(0.04, 6);
  });

  it.each([
    [0.1, 'on-time'],
    [0.2, 'delayed'], // exactly the threshold counts as delayed (p >= threshold)
  ])('labels probability %s as %s against threshold 0.2', async (p, label) => {
    const response = await request(app(constantModel(p)))
      .post('/api/predict')
      .send(body);
    expect(response.body.label).toBe(label);
  });

  it('500s, never a malformed body, when the model returns too few scores', async () => {
    const broken: DelayModel = { ...fakeModel, predict: async () => [0.3] };
    const response = await request(app(broken)).post('/api/predict').send(body);
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('400 for malformed JSON and for a missing body', async () => {
    const malformed = await request(app())
      .post('/api/predict')
      .set('content-type', 'application/json')
      .send('{"date": ');
    expect(malformed.status).toBe(400);
    const empty = await request(app()).post('/api/predict');
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['an hour out of range', { ...body, schedDepHour: 24 }],
    ['the same origin and destination', { ...body, dest: 'ORD' }],
    ['a non-date', { ...body, date: '2015-02-30' }],
    ['an unexpected field', { ...body, depDelay: 30 }],
  ])('400 for %s', async (_case, payload) => {
    const response = await request(app()).post('/api/predict').send(payload);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('422 for an unknown airline or airport, naming the field', async () => {
    const airline = await request(app())
      .post('/api/predict')
      .send({ ...body, airline: 'ZZ' });
    expect(airline.status).toBe(422);
    expect(airline.body.error).toMatchObject({
      code: 'UNKNOWN_CODE',
      details: { field: 'airline' },
    });

    const dest = await request(app())
      .post('/api/predict')
      .send({ ...body, dest: 'XYZ' });
    expect(dest.status).toBe(422);
    expect(dest.body.error.details).toEqual({ field: 'dest', value: 'XYZ' });
  });

  it('422 for a route with no 2015 flights', async () => {
    const response = await request(app())
      .post('/api/predict')
      .send({ ...body, dest: 'BOS' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('UNKNOWN_ROUTE');
  });

  it('503 when no model is loaded, and /health says so', async () => {
    const response = await request(app(null)).post('/api/predict').send(body);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: { code: 'MODEL_UNAVAILABLE', message: 'The prediction model is not loaded' },
    });

    expect((await request(app(null)).get('/api/health')).body.modelLoaded).toBe(false);
    expect((await request(app()).get('/api/health')).body.modelLoaded).toBe(true);
  });
});
