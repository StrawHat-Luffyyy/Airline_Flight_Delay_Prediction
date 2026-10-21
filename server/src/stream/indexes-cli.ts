/**
 * `npm run stream:indexes`: creates (or migrates) the speed-layer indexes without starting a consumer:
 * the replay-order window index, the status count index and the heartbeat TTL. Idempotent.
 */
import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { ensureStreamIndexes, streamFlights } from './store.js';

async function main(): Promise<void> {
  await connectToMongo();
  const started = performance.now();
  await ensureStreamIndexes(getDb());
  const indexes = (await streamFlights(getDb()).indexes()).map((index) => index.name);
  logger.info({ indexes, ms: Math.round(performance.now() - started) }, 'stream:indexes done');
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'stream:indexes failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
