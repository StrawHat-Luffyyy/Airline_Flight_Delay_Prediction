/**
 * The Kafka client for the Phase 8 speed layer: `@confluentinc/kafka-javascript` (librdkafka) through
 * its KafkaJS-compatible API. Only stream code imports this; the API server never requires Kafka.
 */
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { env } from '../config/env.js';

/** Bounds every admin call, so a stopped broker fails fast instead of hanging a CLI. */
export const ADMIN_TIMEOUT_MS = 10_000;

export function createKafka(): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: {
      brokers: env.KAFKA_BROKERS,
      clientId: env.KAFKA_CLIENT_ID,
      connectionTimeout: ADMIN_TIMEOUT_MS,
      requestTimeout: ADMIN_TIMEOUT_MS,
      logLevel: KafkaJS.logLevel.WARN,
    },
  });
}

export function consumerGroup(): string {
  return env.KAFKA_CONSUMER_GROUP;
}

export function topicNames(): { raw: string; dlq: string } {
  return { raw: env.KAFKA_TOPIC_RAW, dlq: env.KAFKA_TOPIC_DLQ };
}
