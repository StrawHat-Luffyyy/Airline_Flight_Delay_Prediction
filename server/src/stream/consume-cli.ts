/**
 * `npm run stream:consume -- [--idle-exit SECONDS]`: runs the speed-layer consumer until Ctrl+C
 * (or SIGTERM), then shuts down gracefully: the in-flight batch finishes and commits, the group is
 * left cleanly and MongoDB is closed. `--idle-exit` stops on its own once no batch has arrived for
 * that long, for scripted measurement runs.
 */
import { hostname } from 'node:os';
import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { startConsumer } from './consumer.js';
import { consumerGroup, createKafka, topicNames } from './kafka.js';

const USAGE = 'Usage: npm run stream:consume -- [--idle-exit SECONDS]';

function parseArgs(argv: readonly string[]): { idleExitMs: number | undefined } {
  if (argv.length === 0) return { idleExitMs: undefined };
  if (argv[0] === '--idle-exit' && argv.length === 2) {
    const seconds = Number(argv[1]);
    if (Number.isFinite(seconds) && seconds > 0) return { idleExitMs: seconds * 1000 };
  }
  throw new Error(`Bad arguments. ${USAGE}`);
}

async function main(): Promise<void> {
  const { idleExitMs } = parseArgs(process.argv.slice(2));
  // Installed before anything starts, so Ctrl+C during startup still shuts down cleanly.
  let signalled = false;
  let onSignal: () => void = () => {
    signalled = true;
  };
  const handler = () => onSignal();
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);

  await connectToMongo();
  const groupId = consumerGroup();
  const instanceId = `${hostname()}-${process.pid}`;
  const running = await startConsumer({
    kafka: createKafka(),
    db: getDb(),
    topics: topicNames(),
    groupId,
    instanceId,
    logger,
  });
  logger.info({ groupId, instanceId, topics: topicNames(), idleExitMs }, 'stream:consume started');

  if (!signalled) {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      onSignal = () => {
        if (timer !== undefined) clearInterval(timer);
        resolve();
      };
      if (idleExitMs !== undefined) {
        // Idle time counts from the start too, so pick a value longer than the first rebalance.
        timer = setInterval(() => {
          if (Date.now() - running.lastBatchAt() >= idleExitMs) {
            clearInterval(timer);
            logger.info({ idleExitMs }, 'stream:consume idle, stopping');
            resolve();
          }
        }, 500);
      }
    });
  }
  process.off('SIGINT', handler);
  process.off('SIGTERM', handler);
  await running.stop();
  // The final counters for this process, for scripted runs.
  logger.info(
    { ...running.counters, heartbeat: `consumer:${groupId}:${instanceId}` },
    'stream:consume finished',
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'stream:consume failed (is Kafka up? docker compose up -d kafka)');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
