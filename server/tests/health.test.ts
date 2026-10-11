import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

describe('GET /api/health', () => {
  it('returns the shared health response when MongoDB ping succeeds', async () => {
    const ping = vi.fn(async () => true);
    const response = await request(createApp({ pingMongo: ping })).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', mongo: 'up', modelLoaded: false });
    expect(ping).toHaveBeenCalledOnce();
  });

  it('returns 503 degraded when MongoDB is unreachable', async () => {
    const response = await request(createApp({ pingMongo: async () => false })).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'degraded', mongo: 'down', modelLoaded: false });
  });
});

describe('CORS', () => {
  const app = createApp({ pingMongo: async () => true, corsOrigin: 'http://localhost:5173' });

  it('allows the configured web origin', async () => {
    const response = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not allow other origins', async () => {
    const response = await request(app).get('/api/health').set('Origin', 'http://evil.example');

    // A fixed origin is always echoed; the browser blocks the mismatch. It must never be * or the caller.
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-origin']).not.toBe('http://evil.example');
  });
});
