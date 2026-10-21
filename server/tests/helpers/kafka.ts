import type { KafkaProbe, KafkaSnapshot } from '../../src/stream/status/kafka-probe.js';

/** A Kafka probe with a fixed answer, so app tests never touch a real broker. */
export function fixedKafka(snapshot: KafkaSnapshot): KafkaProbe {
  return { read: async () => snapshot, lastKnown: () => snapshot, close: async () => undefined };
}

export const kafkaUp = fixedKafka({
  reachable: true,
  reason: null,
  lag: { total: 0, partitions: [{ partition: 0, committed: 10, end: 10, lag: 0 }] },
  dlqMessages: 0,
});

export const kafkaDown = fixedKafka({
  reachable: false,
  reason: 'Kafka admin request timed out after 1000 ms',
  lag: null,
  dlqMessages: null,
});
