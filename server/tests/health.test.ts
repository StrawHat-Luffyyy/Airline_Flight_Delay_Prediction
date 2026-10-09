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
});
