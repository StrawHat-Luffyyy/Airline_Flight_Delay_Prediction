import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import {
  attachOperatingPoints,
  readModelRun,
  readOperatingPoints,
  registerModelRun,
} from './register.js';

async function main(): Promise<void> {
  const points = await readOperatingPoints();
  const metrics = await readModelRun();
  const run = points === null ? metrics : attachOperatingPoints(metrics, points);
  await connectToMongo();
  const doc = await registerModelRun(getDb(), run);
  logger.info(
    { modelVersion: doc.modelVersion, algorithm: doc.algorithm, testAuc: doc.metrics.auc },
    'ml:register complete',
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'ml:register failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
