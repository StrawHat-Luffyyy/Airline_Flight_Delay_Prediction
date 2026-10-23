import express from 'express';
import { MongoNetworkError } from 'mongodb';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema } from '@flight-delay/shared';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { errorHandler } from '../src/middleware/error.js';
import { kafkaUp } from './helpers/kafka.js';

const body = { date: '2015-12-21', airline: 'AA', origin: 'ORD', dest: 'LAX', schedDepHour: 17 };

describe('POST /api/predict rate limit (Phase 7)', () => {
  const app = createApp({
    kafkaProbe: kafkaUp,
    pingMongo: async () => true,
    model: null,
    predictRateLimit: { limit: 2, windowMs: 60_000 },
  });

  it('answers 429 RATE_LIMITED in the error shape once the window is spent', async () => {
    // model: null answers 503, which still counts toward the limit.
    expect((await request(app).post('/api/predict').send(body)).status).toBe(503);
    expect((await request(app).post('/api/predict').send(body)).status).toBe(503);
    const limited = await request(app).post('/api/predict').send(body);
    expect(limited.status).toBe(429);
    expect(ErrorResponseSchema.parse(limited.body).error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['ratelimit-policy']).toBeDefined();
  });

  it('counts malformed bodies too (the limiter runs before body parsing)', async () => {
    const limited = createApp({
      kafkaProbe: kafkaUp,
      pingMongo: async () => true,
      model: null,
      predictRateLimit: { limit: 1, windowMs: 60_000 },
    });
    const malformed = await request(limited)
      .post('/api/predict')
      .set('content-type', 'application/json')
      .send('{bad');
    expect(malformed.status).toBe(400);
    expect((await request(limited).post('/api/predict').send(body)).status).toBe(429);
  });

  it('does not limit the read-only endpoints', async () => {
    for (let i = 0; i < 4; i += 1) {
      expect((await request(app).get('/api/health')).status).toBe(200);
    }
  });
});

describe('POST /api/predict rate limit behind a reverse proxy', () => {
  const limitedApp = (trustProxyHops: number) =>
    createApp({
      kafkaProbe: kafkaUp,
      pingMongo: async () => true,
      model: null,
      predictRateLimit: { limit: 1, windowMs: 60_000 },
      trustProxyHops,
    });
  const predictFrom = (app: ReturnType<typeof createApp>, forwardedFor: string) =>
    request(app).post('/api/predict').set('x-forwarded-for', forwardedFor).send(body);

  it('ignores X-Forwarded-For when no proxy is trusted, so a client cannot spoof a fresh key', async () => {
    const app = limitedApp(0);
    expect((await predictFrom(app, '203.0.113.1')).status).toBe(503);
    expect((await predictFrom(app, '203.0.113.2')).status).toBe(429);
  });

  it('keys each client by the address the trusted proxy reports', async () => {
    const app = limitedApp(1);
    expect((await predictFrom(app, '203.0.113.1')).status).toBe(503);
    expect((await predictFrom(app, '203.0.113.2')).status).toBe(503);
    expect((await predictFrom(app, '203.0.113.1')).status).toBe(429);
  });

  it('trusts only the configured hops, so a prepended address does not escape the limit', async () => {
    const app = limitedApp(1);
    expect((await predictFrom(app, '198.51.100.7, 203.0.113.1')).status).toBe(503);
    // The client forged a different first address; the proxy-appended one is unchanged.
    expect((await predictFrom(app, '198.51.100.99, 203.0.113.1')).status).toBe(429);
  });
});

describe('error mapping and limits (Phase 7)', () => {
  it('maps a MongoDB outage to 503 DATABASE_UNAVAILABLE without leaking driver details', async () => {
    const failing = express();
    failing.get('/down', () => {
      throw new MongoNetworkError('connect ECONNREFUSED 127.0.0.1:27017');
    });
    failing.use(errorHandler);

    const response = await request(failing).get('/down');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is unavailable' },
    });
  });

  it('answers 503 through the full app when the database cannot be reached', async () => {
    const app = createApp({
      kafkaProbe: kafkaUp,
      pingMongo: async () => false,
      model: null,
      cacheTtlMs: 0,
      getDb: () => {
        throw new MongoNetworkError('connect ECONNREFUSED 127.0.0.1:27017');
      },
    });
    const response = await request(app).get('/api/analytics/summary');
    expect(response.status).toBe(503);
    expect(ErrorResponseSchema.parse(response.body).error.code).toBe('DATABASE_UNAVAILABLE');
  });

  it('caps JSON bodies at 10 kB (a /predict body is about 100 bytes)', async () => {
    const app = createApp({ kafkaProbe: kafkaUp, pingMongo: async () => true, model: null });
    const response = await request(app)
      .post('/api/predict')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ ...body, padding: 'x'.repeat(20_000) }));
    expect(response.status).toBe(413);
  });
});

describe('env (Phase 7)', () => {
  const base = {
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB: 'flight_delay',
    PORT: '3001',
    NODE_ENV: 'development',
  };

  it('binds to loopback and allows 30 predictions per minute by default', () => {
    expect(parseEnv(base)).toMatchObject({ HOST: '127.0.0.1', PREDICT_RATE_LIMIT_PER_MIN: 30 });
  });

  it('accepts overrides and rejects a non-positive limit', () => {
    expect(parseEnv({ ...base, HOST: '0.0.0.0', PREDICT_RATE_LIMIT_PER_MIN: '5' })).toMatchObject({
      HOST: '0.0.0.0',
      PREDICT_RATE_LIMIT_PER_MIN: 5,
    });
    expect(() => parseEnv({ ...base, PREDICT_RATE_LIMIT_PER_MIN: '0' })).toThrow(
      /PREDICT_RATE_LIMIT_PER_MIN/,
    );
  });

  it('trusts no proxy by default and accepts a hop count, never `true`', () => {
    expect(parseEnv(base)).toMatchObject({ TRUST_PROXY_HOPS: 0 });
    expect(parseEnv({ ...base, TRUST_PROXY_HOPS: '1' })).toMatchObject({ TRUST_PROXY_HOPS: 1 });
    expect(() => parseEnv({ ...base, TRUST_PROXY_HOPS: 'true' })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => parseEnv({ ...base, TRUST_PROXY_HOPS: '-1' })).toThrow(/TRUST_PROXY_HOPS/);
  });
});
