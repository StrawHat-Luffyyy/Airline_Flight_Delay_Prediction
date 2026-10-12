import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { buildStats } from './build.js';

async function main(): Promise<void> {
  await connectToMongo();
  const db = getDb();
  if ((await db.collection('flights').estimatedDocumentCount()) === 0) {
    throw new Error('flights is empty. Run `npm run ingest` first.');
  }
  const run = await buildStats(db, logger);
  logger.info(
    {
      buildId: run.buildId,
      totalMs: run.totalMs,
      peakRssMb: run.peakRssMb,
      collections: run.collections,
    },
    'build:stats complete',
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'build:stats failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
