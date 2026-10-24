import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { kafkaClientConfig } from '../../src/stream/kafka-config.js';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017',
  MONGODB_DB: 'flight_delay',
  PORT: '3001',
  NODE_ENV: 'production',
};

describe('Kafka security settings (env)', () => {
  it('defaults to plaintext, as the local compose broker expects', () => {
    expect(parseEnv(base)).toMatchObject({ KAFKA_SECURITY_PROTOCOL: 'plaintext' });
  });

  it('needs a username, a password and a CA file for SASL_SSL', () => {
    expect(() => parseEnv({ ...base, KAFKA_SECURITY_PROTOCOL: 'sasl_ssl' })).toThrow(
      /KAFKA_SASL_USERNAME[\s\S]*KAFKA_SASL_PASSWORD[\s\S]*KAFKA_SSL_CA_FILE/,
    );
  });

  it('reads the SASL password from KAFKA_SASL_PASSWORD_FILE (a Docker secret), never echoing it', () => {
    const parsed = parseEnv(
      {
        ...base,
        KAFKA_SECURITY_PROTOCOL: 'sasl_ssl',
        KAFKA_SASL_USERNAME: 'flight_app',
        KAFKA_SASL_PASSWORD_FILE: '/run/secrets/kafka_app_password',
        KAFKA_SSL_CA_FILE: '/run/secrets/kafka_ca.crt',
      },
      (path) => {
        if (path !== '/run/secrets/kafka_app_password') throw new Error('ENOENT');
        return 'k4fka-p4ss\n';
      },
    );
    expect(parsed).toMatchObject({
      KAFKA_SECURITY_PROTOCOL: 'sasl_ssl',
      KAFKA_SASL_USERNAME: 'flight_app',
      KAFKA_SASL_PASSWORD: 'k4fka-p4ss',
      KAFKA_SSL_CA_FILE: '/run/secrets/kafka_ca.crt',
    });
    expect(() =>
      parseEnv({ ...base, KAFKA_SASL_PASSWORD: 'x', KAFKA_SASL_PASSWORD_FILE: '/f' }, () => 'y'),
    ).toThrow(/either KAFKA_SASL_PASSWORD or KAFKA_SASL_PASSWORD_FILE/);
  });
});

describe('kafkaClientConfig', () => {
  const plain = {
    brokers: ['127.0.0.1:9092'],
    clientId: 'flight-delay',
    timeoutMs: 10_000,
    securityProtocol: 'plaintext' as const,
  };

  it('adds no TLS or SASL for plaintext', () => {
    const config = kafkaClientConfig(plain);
    expect(config.kafkaJS).not.toHaveProperty('ssl');
    expect(config.kafkaJS).not.toHaveProperty('sasl');
    expect(config).not.toHaveProperty('ssl.ca.location');
  });

  it('uses TLS with the given CA, hostname verification, and SASL/PLAIN for sasl_ssl', () => {
    const config = kafkaClientConfig({
      ...plain,
      brokers: ['kafka1:9092', 'kafka2:9092'],
      securityProtocol: 'sasl_ssl',
      sasl: { username: 'flight_app', password: 'secret' },
      caFile: '/run/secrets/kafka_ca.crt',
    });
    expect(config.kafkaJS).toMatchObject({
      brokers: ['kafka1:9092', 'kafka2:9092'],
      ssl: true,
      sasl: { mechanism: 'plain', username: 'flight_app', password: 'secret' },
    });
    expect(config['ssl.ca.location']).toBe('/run/secrets/kafka_ca.crt');
    expect(config['ssl.endpoint.identification.algorithm']).toBe('https');
  });
});
