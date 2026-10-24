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
    expect(parseEnv(valid)).toEqual({
      ...valid,
      PORT: 3001,
      CORS_ORIGIN: ['http://localhost:5173'],
      HOST: '127.0.0.1',
      PREDICT_RATE_LIMIT_PER_MIN: 30,
      TRUST_PROXY_HOPS: 0,
      KAFKA_BROKERS: ['127.0.0.1:9092'],
      KAFKA_CLIENT_ID: 'flight-delay',
      KAFKA_CONSUMER_GROUP: 'flight-stream',
      KAFKA_TOPIC_RAW: 'flights.raw',
      KAFKA_TOPIC_DLQ: 'flights.dlq',
      STREAM_WINDOW_SIZE: 2000,
      KAFKA_SESSION_TIMEOUT_MS: 10000,
    });
  });

  it('reduces CORS_ORIGIN to bare origins, so a pasted trailing slash cannot block the browser', () => {
    expect(
      parseEnv({ ...valid, CORS_ORIGIN: 'https://dashboard.example.org/' }).CORS_ORIGIN,
    ).toEqual(['https://dashboard.example.org']);
  });

  it('accepts several comma-separated CORS origins', () => {
    expect(
      parseEnv({
        ...valid,
        CORS_ORIGIN: 'https://dashboard.example.org, https://stats.example.org',
      }).CORS_ORIGIN,
    ).toEqual(['https://dashboard.example.org', 'https://stats.example.org']);
  });

  it('rejects a CORS origin that is not an http(s) URL, or a wildcard', () => {
    expect(() => parseEnv({ ...valid, CORS_ORIGIN: 'dashboard.example.org' })).toThrow(
      /CORS_ORIGIN/,
    );
    expect(() => parseEnv({ ...valid, CORS_ORIGIN: '*' })).toThrow(/CORS_ORIGIN/);
    expect(() => parseEnv({ ...valid, CORS_ORIGIN: 'ftp://x.example' })).toThrow(/CORS_ORIGIN/);
    expect(() => parseEnv({ ...valid, CORS_ORIGIN: ',' })).toThrow(/CORS_ORIGIN/);
  });

  it('needs no Kafka settings, and splits a broker list', () => {
    expect(parseEnv({ ...valid, KAFKA_BROKERS: 'a:9092, b:9093' }).KAFKA_BROKERS).toEqual([
      'a:9092',
      'b:9093',
    ]);
  });

  it('rejects a malformed broker or topic name', () => {
    expect(() => parseEnv({ ...valid, KAFKA_BROKERS: 'localhost' })).toThrow(/KAFKA_BROKERS/);
    expect(() => parseEnv({ ...valid, KAFKA_BROKERS: 'a:70000' })).toThrow(/KAFKA_BROKERS/);
    expect(parseEnv({ ...valid, KAFKA_BROKERS: 'a:9092,' }).KAFKA_BROKERS).toEqual(['a:9092']);
    expect(() => parseEnv({ ...valid, KAFKA_TOPIC_RAW: 'bad topic' })).toThrow(/KAFKA_TOPIC_RAW/);
  });

  it('defaults the consumer session timeout to 10 s, within broker limits', () => {
    expect(parseEnv(valid).KAFKA_SESSION_TIMEOUT_MS).toBe(10000);
    expect(parseEnv({ ...valid, KAFKA_SESSION_TIMEOUT_MS: '10000' }).KAFKA_SESSION_TIMEOUT_MS).toBe(
      10000,
    );
    // The broker's default group.min.session.timeout.ms is 6 s.
    expect(() => parseEnv({ ...valid, KAFKA_SESSION_TIMEOUT_MS: '1000' })).toThrow(
      /KAFKA_SESSION_TIMEOUT_MS/,
    );
  });

  it('names every missing variable in the error', () => {
    expect(() => parseEnv({})).toThrow(/MONGODB_URI[\s\S]*MONGODB_DB[\s\S]*NODE_ENV/);
  });

  it('needs no PORT, which processes without an HTTP port (the consumer) do not set', () => {
    expect(parseEnv({ ...valid, PORT: undefined }).PORT).toBe(3001);
    expect(parseEnv({ ...valid, PORT: '10000' }).PORT).toBe(10000);
  });

  it('rejects an invalid PORT and an unknown NODE_ENV', () => {
    expect(() => parseEnv({ ...valid, PORT: '70000' })).toThrow(/PORT/);
    expect(() => parseEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
