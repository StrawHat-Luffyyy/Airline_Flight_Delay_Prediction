import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { EXPORT_RUNS, type ExportRunDoc } from '../features/export.js';
import { loadLookupFingerprint } from '../features/lookup.js';
import { logger } from '../logger.js';
import { chooseLookupPin } from './lookup-check.js';
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
  // Pin the lookup the model was trained on (recorded by the latest export), so the API and the
  // stream scorers can tell when delay_lookup is later rebuilt from different flights.
  const lastExport = await getDb()
    .collection<ExportRunDoc>(EXPORT_RUNS)
    .findOne({ status: 'completed' }, { sort: { finishedAt: -1 } });
  const current = await loadLookupFingerprint(getDb());
  const { pin: lookupFingerprint, problem } = chooseLookupPin({
    exported: lastExport?.lookupFingerprint,
    current,
  });
  if (problem === 'changed-since-export')
    logger.warn(
      { exported: lookupFingerprint, current },
      'delay_lookup was rebuilt from different data since export:training; pinning the exported lookup, so the API will report a mismatch until you retrain or rebuild',
    );
  else if (problem === 'export-unpinned')
    logger.warn(
      { current },
      'The latest export:training run predates lookup fingerprints; pinning the current delay_lookup. Re-export and retrain to pin the exact training lookup',
    );
  const doc = await registerModelRun(getDb(), run, { lookupFingerprint });
  logger.info(
    {
      modelVersion: doc.modelVersion,
      algorithm: doc.algorithm,
      testAuc: doc.metrics.auc,
      lookupFingerprint,
    },
    'ml:register complete',
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'ml:register failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
