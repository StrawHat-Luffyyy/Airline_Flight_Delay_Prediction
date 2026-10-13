import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { readModelRun, registerModelRun } from './register.js';

async function main(): Promise<void> {
  const run = await readModelRun();
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
