import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema } from '@flight-delay/shared';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/middleware/error.js';

const app = createApp({ pingMongo: async () => true });

describe('error responses', () => {
  it('returns 404 NOT_FOUND for unknown routes', async () => {
    const response = await request(app).get('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(ErrorResponseSchema.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('returns 400 BAD_REQUEST for a malformed JSON body', async () => {
    const response = await request(app)
      .post('/api/health')
      .set('content-type', 'application/json')
      .send('{bad');

    expect(response.status).toBe(400);
    expect(ErrorResponseSchema.parse(response.body).error.code).toBe('BAD_REQUEST');
  });

  it('returns 413 PAYLOAD_TOO_LARGE for a body over the JSON limit', async () => {
    const response = await request(app)
      .post('/api/health')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(200_000) }));

    expect(response.status).toBe(413);
    expect(ErrorResponseSchema.parse(response.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns a generic 500 without leaking the internal error message', async () => {
    const failing = express();
    failing.get('/boom', () => {
      throw new Error('secret connection string mongodb://user:pass@host');
    });
    failing.use(errorHandler);

    const response = await request(failing).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    });
  });
});
