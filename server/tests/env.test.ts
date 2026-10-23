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
    expect(() => parseEnv({})).toThrow(/MONGODB_URI[\s\S]*MONGODB_DB[\s\S]*PORT[\s\S]*NODE_ENV/);
  });

  it('reads MONGODB_URI from the file MONGODB_URI_FILE names (a Docker secret), trimmed', () => {
    const rest = { ...valid, MONGODB_URI: undefined };
    const files: Record<string, string> = {
      '/run/secrets/mongodb_uri': 'mongodb://mongo:27017/flight_delay\n',
    };
    const parsed = parseEnv({ ...rest, MONGODB_URI_FILE: '/run/secrets/mongodb_uri' }, (path) => {
      const content = files[path];
      if (content === undefined) throw new Error('ENOENT');
      return content;
    });
    expect(parsed.MONGODB_URI).toBe('mongodb://mongo:27017/flight_delay');
  });

  it('refuses both MONGODB_URI and MONGODB_URI_FILE, and never echoes a secret it could not use', () => {
    expect(() =>
      parseEnv({ ...valid, MONGODB_URI_FILE: '/run/secrets/mongodb_uri' }, () => 'x'),
    ).toThrow(/either MONGODB_URI or MONGODB_URI_FILE/);
    const rest = { ...valid, MONGODB_URI: undefined };
    let message = '';
    try {
      parseEnv({ ...rest, MONGODB_URI_FILE: '/missing' }, () => {
        throw new Error('ENOENT');
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/MONGODB_URI_FILE: cannot read \/missing/);
    expect(() =>
      parseEnv({ ...rest, MONGODB_URI_FILE: '/bad' }, () => 'not a url with p4ssw0rd'),
    ).toThrow(/MONGODB_URI/);
    try {
      parseEnv({ ...rest, MONGODB_URI_FILE: '/bad' }, () => 'not a url with p4ssw0rd');
    } catch (error) {
      expect((error as Error).message).not.toContain('p4ssw0rd');
    }
  });

  it('rejects an invalid PORT and an unknown NODE_ENV', () => {
    expect(() => parseEnv({ ...valid, PORT: '70000' })).toThrow(/PORT/);
    expect(() => parseEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
