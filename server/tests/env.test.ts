import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const valid = {
  MONGODB_URI: 'mongodb://localhost:27017',
  MONGODB_DB: 'flight_delay',
  PORT: '3001',
  NODE_ENV: 'development',
};

describe('parseEnv', () => {
  it('accepts the documented contract and coerces PORT to a number', () => {
    expect(parseEnv(valid)).toEqual({ ...valid, PORT: 3001, CORS_ORIGIN: 'http://localhost:5173' });
  });

  it('names every missing variable in the error', () => {
    expect(() => parseEnv({})).toThrow(/MONGODB_URI[\s\S]*MONGODB_DB[\s\S]*PORT[\s\S]*NODE_ENV/);
  });

  it('rejects an invalid PORT and an unknown NODE_ENV', () => {
    expect(() => parseEnv({ ...valid, PORT: '70000' })).toThrow(/PORT/);
    expect(() => parseEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
