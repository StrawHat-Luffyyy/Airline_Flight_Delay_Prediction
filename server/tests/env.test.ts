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
      CORS_ORIGIN: 'http://localhost:5173',
      HOST: '127.0.0.1',
      PREDICT_RATE_LIMIT_PER_MIN: 30,
      KAFKA_BROKERS: ['127.0.0.1:9092'],
      KAFKA_CLIENT_ID: 'flight-delay',
      KAFKA_CONSUMER_GROUP: 'flight-stream',
      KAFKA_TOPIC_RAW: 'flights.raw',
      KAFKA_TOPIC_DLQ: 'flights.dlq',
      STREAM_WINDOW_SIZE: 2000,
    });
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

  it('names every missing variable in the error', () => {
    expect(() => parseEnv({})).toThrow(/MONGODB_URI[\s\S]*MONGODB_DB[\s\S]*PORT[\s\S]*NODE_ENV/);
  });

  it('rejects an invalid PORT and an unknown NODE_ENV', () => {
    expect(() => parseEnv({ ...valid, PORT: '70000' })).toThrow(/PORT/);
    expect(() => parseEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
