import { closeMongo, connectToMongo, getDb } from './client.js';
import { ensureFlightIndexes, flightsSizes } from './indexes.js';
import { logger } from '../logger.js';

async function main(): Promise<void> {
  await connectToMongo();
  const db = getDb();
  const before = await flightsSizes(db);
  logger.info(before, 'flights stats before build:indexes');
  if (before.count === 0) throw new Error('flights is empty. Run `npm run ingest` first.');

  const started = performance.now();
  const outcomes = await ensureFlightIndexes(db, logger);
  const totalMs = Math.round(performance.now() - started);

  const after = await flightsSizes(db);
  logger.info(after, 'flights stats after build:indexes');
  logger.info({ outcomes, totalMs }, 'build:indexes complete');
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'build:indexes failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
