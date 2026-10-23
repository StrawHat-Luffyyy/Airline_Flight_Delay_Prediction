/**
 * `npm run stream:commit-check -- --mode raw|confirmed --yes [--out FILE]`: reproduces run R1's lost
 * offset commits against the real broker, on a throwaway topic and group (`commitcheck.<time>`,
 * removed afterwards; nothing in MongoDB or the stream topics is touched).
 *
 * It produces 6,000 messages, consumes them in batches of 100 with a short pause per batch,
 * committing after each, and stops the Kafka container (`docker compose stop kafka`) for 20 s
 * while it runs; hence --yes. `raw` commits with commitOffsets() alone, `confirmed` with
 * commitAndConfirm() as the consumer does. Exit code 0 when the verdict holds (commit-check.ts):
 * raw reproduces the defect, confirmed shows it fixed.
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { commitAndConfirm } from './commit.js';
import { CommitLog, commitVerdict, type CommitMode } from './commit-check.js';
import { ADMIN_TIMEOUT_MS, createKafka } from './kafka.js';

const MESSAGES = 6_000;
const BATCH = 100;
const PROCESS_MS = 150;
const DOWN_MS = 20_000;
const RECOVER_MS = 45_000;
const CONFIRM_TIMEOUT_MS = 2_000;
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Async, so the consumer keeps running (and heartbeating) while the broker stops and starts.
const compose = async (...args: string[]) =>
  (await promisify(execFile)('docker', ['compose', ...args], { cwd: REPO, encoding: 'utf8' }))
    .stdout;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      yes: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
    strict: true,
  });
  if (values.mode !== 'raw' && values.mode !== 'confirmed') {
    throw new Error('--mode must be raw or confirmed');
  }
  if (!values.yes) throw new Error('stops and starts the kafka container: pass --yes');
  const mode: CommitMode = values.mode;
  const name = `commitcheck.${Date.now()}`;
  const started = Date.now();
  const at = () => Math.round((Date.now() - started) / 100) / 10;

  const kafka = createKafka();
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: name, numPartitions: 1, replicationFactor: 1 }] });
  const consumer = kafka.consumer({
    kafkaJS: { groupId: name, fromBeginning: true, autoCommit: false, sessionTimeout: 10_000 },
    'js.consumer.max.batch.size': BATCH,
  });
  const log = new CommitLog();
  let brokerDown = false;
  let stopped = false;
  let describe: string;
  try {
    const producer = kafka.producer();
    await producer.connect();
    for (let i = 0; i < MESSAGES; i += 500) {
      await producer.send({
        topic: name,
        messages: Array.from({ length: 500 }, (_, j) => ({ value: String(i + j) })),
      });
    }
    await producer.disconnect();

    await consumer.connect();
    await consumer.subscribe({ topics: [name] });
    await consumer.run({
      eachBatch: async ({ batch, resolveOffset }) => {
        await sleep(PROCESS_MS);
        log.delivered(batch.messages.map((m) => Number(m.offset)));
        const next = String(Number(batch.lastOffset()) + 1);
        const target = { topic: name, partition: batch.partition, offset: next };
        const record = { t: at(), next: Number(next) };
        try {
          if (mode === 'raw') await consumer.commitOffsets([target]);
          else await commitAndConfirm(consumer, target, { timeoutMs: CONFIRM_TIMEOUT_MS });
        } catch (error) {
          log.commits.push({ ...record, brokerDown, outcome: 'rejected' });
          throw error;
        }
        // Classified when the commit completes: a commit the broker confirmed while still shutting
        // down is a real commit, not one believed while it was down.
        log.commits.push({ ...record, brokerDown, outcome: 'resolved' });
        resolveOffset(batch.lastOffset());
      },
    });

    await sleep(4_000);
    logger.info({ at: at() }, 'stopping the broker');
    stopped = true;
    await compose('stop', 'kafka');
    // Down from the moment the container has stopped until the start is issued.
    brokerDown = true;
    await sleep(DOWN_MS);
    brokerDown = false;
    await compose('start', 'kafka');
    stopped = false;
    logger.info({ at: at() }, 'broker started; waiting for the consumer to recover');
    await sleep(RECOVER_MS);
    await consumer.disconnect().catch(() => undefined);

    // Read with Kafka's own tool: the client's admin offset fetch is the call that crashes natively
    // after a broker restart (status/isolated-probe.ts).
    describe = await compose(
      'exec',
      '-T',
      'kafka',
      '/opt/kafka/bin/kafka-consumer-groups.sh',
      '--bootstrap-server',
      'localhost:9092',
      '--describe',
      '--group',
      name,
    );
  } finally {
    // Whatever failed: never leave the broker stopped, nor the throwaway topic and group behind.
    if (stopped) await compose('start', 'kafka').catch(() => undefined);
    await consumer.disconnect().catch(() => undefined);
    await admin.deleteGroups([name]).catch(() => undefined);
    await admin.deleteTopics({ topics: [name], timeout: ADMIN_TIMEOUT_MS }).catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
  }
  const row = describe.split('\n').find((line) => line.includes(name));
  const committed = row === undefined ? null : Number(row.trim().split(/\s+/)[3]);
  const summary = {
    mode,
    batchSize: BATCH,
    partitions: 1,
    brokerCommitted: Number.isFinite(committed) ? committed : null,
    ...log.summary(MESSAGES),
  };
  const verdict = commitVerdict(summary);

  const report = { topic: name, ...summary, verdict, commits: log.commits };
  if (values.out !== undefined) {
    // npm runs the script from server/; the path is relative to where it was typed.
    const out = resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  logger.info({ ...summary, verdict }, 'stream:commit-check done');
  if (!verdict.ok) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'stream:commit-check failed');
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 500).unref());
