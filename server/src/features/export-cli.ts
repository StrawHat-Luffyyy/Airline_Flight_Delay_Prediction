import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { exportTraining } from './export.js';

async function main(): Promise<void> {
  await connectToMongo();
  const run = await exportTraining(getDb(), logger);
  logger.info(
    {
      dir: run.dir,
      trainRows: run.trainRows,
      testRows: run.testRows,
      excludedUnresolvedAirport: run.excludedUnresolvedAirport,
      excludedNoOutcome: run.excludedNoOutcome,
      nullScheduledTime: run.nullScheduledTime,
      peakRssMb: run.peakRssMb,
      seconds: Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000),
    },
    'export:training complete',
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'export:training failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
