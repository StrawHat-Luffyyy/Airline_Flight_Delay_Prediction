import { KafkaJS } from '@confluentinc/kafka-javascript';
import { flightKey, type FlightEvent, type PredictResponse } from '@flight-delay/shared';
import { MongoClient, type Db } from 'mongodb';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startConsumer, type RunningConsumer } from '../../src/stream/consumer.js';
import { createKafka } from '../../src/stream/kafka.js';
import type { Predictor } from '../../src/stream/score.js';
import { streamFlights } from '../../src/stream/store.js';
import { initTopics, topicSpecs, type TopicAdmin } from '../../src/stream/topics.js';

// End to end against a real Kafka broker (KAFKA_BROKERS, default 127.0.0.1:9092) and MongoDB:
// produce, consume with the real consumer (commit read-back included), store, replay. Everything it
// creates is its own and removed afterwards. Skipped when either service is unreachable; CI runs a
// broker so it always runs there.
const TEST_DB = 'flight_delay_broker_test';
const prefix = `test-broker-${Date.now()}`;
const topics = { raw: `${prefix}.raw`, dlq: `${prefix}.dlq` };
const FLIGHTS = 60;
const PROBE_TIMEOUT_MS = 3_000;
const READ_COMMITTED = {
  timeout: 10_000,
  isolationLevel: KafkaJS.IsolationLevel.READ_COMMITTED,
};

let kafka: KafkaJS.Kafka | undefined;
let admin: KafkaJS.Admin | undefined;
let producer: KafkaJS.Producer | undefined;
let mongo: MongoClient | undefined;
let db: Db;
let consumer: RunningConsumer | undefined;

function event(flightNumber: number): FlightEvent {
  const pre = {
    date: '2015-12-21',
    airline: 'AA',
    flightNumber,
    origin: 'ORD',
    dest: 'LAX',
    schedDepMin: 1050,
    schedDepHour: 17,
  };
  return {
    v: 1,
    key: flightKey(pre),
    runId: prefix,
    producedAt: Date.now(),
    pre,
    outcome: { depDelay: 20, arrDelay: 25, isDelayed: true, cancelled: false, diverted: false },
  };
}

const events = Array.from({ length: FLIGHTS }, (_unused, index) => event(index + 1));

const predict: Predictor = async (): Promise<PredictResponse> => ({
  probability: 0.4,
  label: 'delayed',
  threshold: 0.2,
  modelVersion: 'broker-test',
  derived: { dayOfWeek: 1, isHolidayWeek: true, distance: 1744, scheduledTime: 275 },
  topFactors: [],
});

async function produceAll(): Promise<void> {
  await producer!.send({
    topic: topics.raw,
    // Keyed by flight so the events spread over all three partitions (consumed concurrently).
    messages: events.map((e) => ({ key: e.key, value: JSON.stringify(e) })),
  });
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  const candidate = new MongoClient(process.env.MONGODB_URI ?? '', {
    serverSelectionTimeoutMS: 2_000,
  });
  try {
    await candidate.connect();
  } catch {
    await candidate.close();
    return;
  }
  const client = createKafka();
  const candidateAdmin = client.admin();
  try {
    await candidateAdmin.connect();
    await candidateAdmin.listTopics({ timeout: PROBE_TIMEOUT_MS });
  } catch {
    await candidateAdmin.disconnect().catch(() => undefined);
    await candidate.close();
    return;
  }
  mongo = candidate;
  kafka = client;
  admin = candidateAdmin;
  db = mongo.db(TEST_DB);
  await db.dropDatabase();
  producer = kafka.producer({ kafkaJS: { idempotent: true, acks: -1 } });
  await producer.connect();
  const topicAdmin: TopicAdmin = {
    listTopics: () => candidateAdmin.listTopics({ timeout: 10_000 }),
    fetchTopicMetadata: ({ topics: names }) =>
      candidateAdmin.fetchTopicMetadata({ topics: names, timeout: 10_000 }),
    createTopics: ({ topics: specs }) =>
      candidateAdmin.createTopics({ topics: specs, timeout: 10_000 }),
  };
  await initTopics(topicAdmin, topicSpecs(topics));
}, 60_000);

afterAll(async () => {
  await consumer?.stop().catch(() => undefined);
  if (admin) {
    await admin.deleteGroups([prefix]).catch(() => undefined);
    await admin.deleteTopics({ topics: [topics.raw, topics.dlq] }).catch(() => undefined);
  }
  if (mongo)
    await mongo
      .db(TEST_DB)
      .dropDatabase()
      .catch(() => undefined);
  await Promise.allSettled([admin?.disconnect(), producer?.disconnect(), mongo?.close()]);
}, 60_000);

describe('speed layer against a real broker', () => {
  it('stores and scores every event once, dead-letters a malformed one, and commits to the end', async (context) => {
    if (!kafka || !admin || !producer) return context.skip();
    await produceAll();
    await producer.send({
      topic: topics.raw,
      messages: [{ key: 'ORD', value: '{"v":1,"oops":1}' }],
    });

    consumer = await startConsumer({
      kafka,
      db,
      topics,
      groupId: prefix,
      instanceId: 'broker-test',
      logger: pino({ level: 'silent' }),
      predict,
      sessionTimeoutMs: 10_000,
    });
    const running = consumer;
    await waitFor(() => running.counters.consumed >= FLIGHTS + 1, 'the first consume');

    expect(running.counters).toMatchObject({ consumed: FLIGHTS + 1, inserted: FLIGHTS, dlq: 1 });
    expect(await streamFlights(db).countDocuments()).toBe(FLIGHTS);
    expect(
      await streamFlights(db).countDocuments({ 'prediction.modelVersion': 'broker-test' }),
    ).toBe(FLIGHTS);

    // The confirmed commits really reached the broker: committed = end offset on every partition.
    const ends = await admin.fetchTopicOffsets(topics.raw, READ_COMMITTED);
    const [committed] = await admin.fetchOffsets({ groupId: prefix, topics: [topics.raw] });
    const byPartition = new Map(
      (committed?.partitions ?? []).map((p) => [p.partition, Number(p.offset)]),
    );
    expect(ends.filter((end) => Number(end.high) > 0).length).toBeGreaterThan(1);
    for (const end of ends) {
      // A partition that never received a message has nothing to commit.
      if (Number(end.high) > 0) expect(byPartition.get(end.partition)).toBe(Number(end.high));
    }
    const dlqEnds = await admin.fetchTopicOffsets(topics.dlq, READ_COMMITTED);
    expect(dlqEnds.reduce((sum, p) => sum + Number(p.high) - Number(p.low), 0)).toBe(1);
  }, 90_000);

  it('absorbs a replay of the same flights without new documents', async (context) => {
    if (!consumer || !producer) return context.skip();
    const running = consumer;
    const before = running.counters.consumed;
    await produceAll();
    await waitFor(() => running.counters.consumed >= before + FLIGHTS, 'the replay');
    expect(running.counters.redelivered).toBe(FLIGHTS);
    expect(await streamFlights(db).countDocuments()).toBe(FLIGHTS);
  }, 90_000);
});
