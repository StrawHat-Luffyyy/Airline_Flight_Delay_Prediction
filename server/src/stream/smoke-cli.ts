/**
 * `npm run stream:smoke`: an end-to-end check of the speed layer against the real Kafka container
 * (PROJECT_OVERVIEW §15.11). Everything it touches is its own and removed afterwards: topics named
 * `smoke-<time>.raw/.dlq`, a consumer group of the same name, and the `flight_delay_smoke_test`
 * database. It replays a 7-row fixture (one transformer reject, one other month), injects one
 * malformed message, consumes, and checks conservation; then replays again and checks that no
 * document count changes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { MongoClient } from 'mongodb';
import { env } from '../config/env.js';
import type { ReferenceData } from '../ingest/transform.js';
import { logger } from '../logger.js';
import { startConsumer, type RunningConsumer } from './consumer.js';
import { ADMIN_TIMEOUT_MS, createKafka } from './kafka.js';
import { replayMonth, type EventSink } from './replay.js';
import { streamFlights } from './store.js';
import { initTopics, topicSpecs, type TopicAdmin } from './topics.js';

const SMOKE_DB = 'flight_delay_smoke_test';
const HEADER =
  'YEAR,MONTH,DAY,DAY_OF_WEEK,AIRLINE,FLIGHT_NUMBER,TAIL_NUMBER,ORIGIN_AIRPORT,DESTINATION_AIRPORT,' +
  'SCHEDULED_DEPARTURE,DEPARTURE_TIME,DEPARTURE_DELAY,TAXI_OUT,WHEELS_OFF,SCHEDULED_TIME,' +
  'ELAPSED_TIME,AIR_TIME,DISTANCE,WHEELS_ON,TAXI_IN,SCHEDULED_ARRIVAL,ARRIVAL_TIME,ARRIVAL_DELAY,' +
  'DIVERTED,CANCELLED,CANCELLATION_REASON,AIR_SYSTEM_DELAY,SECURITY_DELAY,AIRLINE_DELAY,' +
  'LATE_AIRCRAFT_DELAY,WEATHER_DELAY';
const row = (month: number, airline: string, flight: number, origin: string, dest: string) =>
  `2015,${month},21,1,${airline},${flight},N1,${origin},${dest},1730,1735,5,10,1745,275,270,250,` +
  `1744,2000,5,2005,2010,5,0,0,,,,,,`;
const FIXTURE = [
  HEADER,
  row(11, 'AA', 900, 'ORD', 'LAX'), // another month: never sent
  row(12, 'AA', 1, 'ORD', 'LAX'),
  row(12, 'AA', 2, 'LAX', 'ORD'),
  row(12, 'AA', 3, 'ORD', 'LAX'),
  row(12, 'ZZ', 4, 'ORD', 'LAX'), // unknown airline: producer DLQ
  row(12, 'AA', 5, 'LAX', 'ORD'),
  row(12, 'AA', 6, 'ORD', 'LAX'),
].join('\n');
const EXPECTED_EVENTS = 5;
const refs: ReferenceData = {
  airlines: new Map([['AA', 'American Airlines Inc.']]),
  airports: new Map([
    ['ORD', { city: 'Chicago', state: 'IL' }],
    ['LAX', { city: 'Los Angeles', state: 'CA' }],
  ]),
};

function check(condition: boolean, what: string, detail: unknown): void {
  if (!condition) throw new Error(`FAIL ${what}: ${JSON.stringify(detail)}`);
  logger.info({ detail }, `PASS ${what}`);
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  const prefix = `smoke-${Date.now()}`;
  const topics = { raw: `${prefix}.raw`, dlq: `${prefix}.dlq` };
  const dir = mkdtempSync(join(tmpdir(), 'stream-smoke-'));
  writeFileSync(join(dir, 'flights.csv'), `${FIXTURE}\n`);

  const kafka = createKafka();
  const admin = kafka.admin();
  const producer = kafka.producer({
    kafkaJS: { idempotent: true, acks: -1, maxInFlightRequests: 5 },
  });
  const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
  let consumer: RunningConsumer | undefined;

  await admin.connect();
  await producer.connect();
  await mongo.connect();
  const db = mongo.db(SMOKE_DB);
  try {
    await db.dropDatabase();
    const topicAdmin: TopicAdmin = {
      listTopics: () => admin.listTopics({ timeout: ADMIN_TIMEOUT_MS }),
      fetchTopicMetadata: ({ topics: names }) =>
        admin.fetchTopicMetadata({ topics: names, timeout: ADMIN_TIMEOUT_MS }),
      createTopics: ({ topics: specs }) =>
        admin.createTopics({ topics: specs, timeout: ADMIN_TIMEOUT_MS }),
    };
    await initTopics(topicAdmin, topicSpecs(topics));
    const sink: EventSink = {
      async send(topic, messages) {
        await producer.send({
          topic,
          messages: messages.map((m) => ({ key: m.key, value: m.value })),
        });
      },
    };
    const replay = () =>
      replayMonth(
        { month: 12, rate: 0, limit: undefined, dir },
        { sink, refs, topics, runId: prefix },
      );

    // 1. Replay: every month row goes to flights.raw or the DLQ.
    const first = await replay();
    check(
      first.monthRows === 6 && first.sentRaw === EXPECTED_EVENTS && first.sentDlq === 1,
      'producer conservation (month rows = raw + DLQ)',
      first,
    );
    // 2. A malformed message the consumer must dead-letter, not drop.
    await producer.send({
      topic: topics.raw,
      messages: [{ key: 'ORD', value: '{"v":1,"oops":true}' }],
    });

    // 3. Consume everything.
    consumer = await startConsumer({
      kafka,
      db,
      topics,
      groupId: prefix,
      instanceId: 'smoke',
      logger,
    });
    const running = consumer;
    await waitFor(() => running.counters.consumed >= EXPECTED_EVENTS + 1, 'the first consume');
    const stored = await streamFlights(db).countDocuments();
    check(
      running.counters.consumed === EXPECTED_EVENTS + 1 &&
        stored === EXPECTED_EVENTS &&
        running.counters.dlq === 1,
      'consumer conservation (raw = stored + DLQ)',
      { ...running.counters, stored },
    );

    // 4. Replay the same rows again: counts must not change.
    await replay();
    await waitFor(() => running.counters.consumed >= 2 * EXPECTED_EVENTS + 1, 'the second consume');
    const storedAgain = await streamFlights(db).countDocuments();
    check(
      storedAgain === EXPECTED_EVENTS && running.counters.redelivered === EXPECTED_EVENTS,
      'idempotent replay (no new documents)',
      { ...running.counters, storedAgain },
    );

    // 5. Both DLQ entries (producer reject + consumer reject) are on the DLQ topic.
    const dlqOffsets = await admin.fetchTopicOffsets(topics.dlq, {
      timeout: ADMIN_TIMEOUT_MS,
      isolationLevel: KafkaJS.IsolationLevel.READ_COMMITTED,
    });
    const dlqCount = dlqOffsets.reduce((sum, p) => sum + Number(p.high) - Number(p.low), 0);
    check(dlqCount === 2 + 1, 'DLQ holds every reject (2 producer runs + 1 consumer)', {
      dlqCount,
    });
    logger.info('stream:smoke passed');
  } finally {
    await consumer?.stop().catch(() => undefined);
    await admin.deleteGroups([prefix]).catch(() => undefined);
    await admin.deleteTopics({ topics: [topics.raw, topics.dlq] }).catch(() => undefined);
    await db.dropDatabase().catch(() => undefined);
    await Promise.allSettled([admin.disconnect(), producer.disconnect(), mongo.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'stream:smoke failed');
  process.exitCode = 1;
});
