/**
 * `npm run stream:reset -- --db <MONGODB_DB> --yes`: empties the speed layer (stream_flights,
 * stream_stats, the consumer group's offsets and the stream topics' messages) for a clean 8g
 * measurement. Refuses unless --db names the configured database. See reset.ts for what it touches.
 * Stop the consumer (it refuses while the group has members) and any running replay first: a
 * producer still sending would leave its later messages behind.
 */
import { env } from '../config/env.js';
import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { ADMIN_TIMEOUT_MS, consumerGroup, createKafka, topicNames } from './kafka.js';
import { checkResetTarget, parseResetArgs, resetStream } from './reset.js';

async function main(): Promise<void> {
  checkResetTarget(parseResetArgs(process.argv.slice(2)), env.MONGODB_DB);
  const admin = createKafka().admin();
  try {
    await admin.connect();
    await connectToMongo();
    const summary = await resetStream({
      db: getDb(),
      admin,
      groupId: consumerGroup(),
      topics: topicNames(),
      timeoutMs: ADMIN_TIMEOUT_MS,
    });
    logger.info({ db: env.MONGODB_DB, groupId: consumerGroup(), ...summary }, 'stream:reset done');
  } finally {
    await admin.disconnect().catch(() => undefined);
    await closeMongo();
  }
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'stream:reset failed; nothing after the failing step was cleared');
  process.exitCode = 1;
});
