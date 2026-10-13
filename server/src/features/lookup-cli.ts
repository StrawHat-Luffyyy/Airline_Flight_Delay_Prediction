import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { buildLookup } from './lookup.js';

async function main(): Promise<void> {
  await connectToMongo();
  const run = await buildLookup(getDb(), logger);
  logger.info(
    {
      m: run.m,
      cellsMs: run.cellsMs,
      cellsDocs: run.cellsDocs,
      lookupDocs: run.lookupDocs,
      totalMs: run.finishedAt.getTime() - run.startedAt.getTime(),
      scopes: run.scopes,
    },
    'build:lookup complete',
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'build:lookup failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
