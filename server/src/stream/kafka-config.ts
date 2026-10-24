import type { KafkaJS } from '@confluentinc/kafka-javascript';

export interface KafkaClientSettings {
  brokers: string[];
  clientId: string;
  /** Bounds connection and requests, so a stopped broker fails fast. */
  timeoutMs: number;
  /** `plaintext` for the local compose broker; `sasl_ssl` for the production cluster. */
  securityProtocol: 'plaintext' | 'sasl_ssl';
  sasl?: { username: string; password: string };
  /** PEM file with the CA that signed the brokers' certificates (sasl_ssl only). */
  caFile?: string;
}

/**
 * The client configuration for every Kafka user in the app (status probe, consumer, replay, CLIs).
 * With `sasl_ssl` the connection is TLS, verified against `caFile` including the broker's hostname,
 * and authenticated with SASL/PLAIN (the password travels only inside TLS).
 */
export function kafkaClientConfig(settings: KafkaClientSettings): KafkaJS.CommonConstructorConfig {
  const kafkaJS: KafkaJS.KafkaConfig = {
    brokers: settings.brokers,
    clientId: settings.clientId,
    connectionTimeout: settings.timeoutMs,
    requestTimeout: settings.timeoutMs,
  };
  if (settings.securityProtocol === 'plaintext') return { kafkaJS };
  if (settings.sasl === undefined || settings.caFile === undefined) {
    throw new Error('sasl_ssl needs SASL credentials and a CA file');
  }
  return {
    kafkaJS: {
      ...kafkaJS,
      ssl: true,
      sasl: {
        mechanism: 'plain',
        username: settings.sasl.username,
        password: settings.sasl.password,
      },
    },
    'ssl.ca.location': settings.caFile,
    'ssl.endpoint.identification.algorithm': 'https',
  };
}
