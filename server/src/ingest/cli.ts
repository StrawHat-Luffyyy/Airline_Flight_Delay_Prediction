import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { parseIngestArgs } from './args.js';
import { runIngest } from './run.js';

async function main(): Promise<void> {
  const args = parseIngestArgs(process.argv.slice(2));
  await connectToMongo();
  const summary = await runIngest(getDb(), args, logger);
  const { flights } = summary;
  logger.info(
    {
      airlines: summary.airlines.rowsInserted,
      airports: summary.airports.rowsInserted,
      rowsRead: flights.rowsRead,
      rowsInserted: flights.rowsInserted,
      rowsRejected: flights.rowsRejected,
      rejectReasons: flights.rejectReasons,
      peakRssMb: flights.peakRssMb,
      seconds: Math.round((flights.finishedAt.getTime() - flights.startedAt.getTime()) / 1000),
    },
    'Ingest complete',
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'Ingest failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
