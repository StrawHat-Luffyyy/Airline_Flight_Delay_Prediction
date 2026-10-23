import { closeMongo, connectToMongo, getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { resolveAirportIds } from './resolve.js';
import { fromRepoRoot } from '../paths.js';

const USAGE = 'Usage: npm run resolve:airport-ids [-- --apply]';
const MAP_FILE = fromRepoRoot('docs', 'airport-id-map.json');

function parseApply(argv: readonly string[]): boolean {
  for (const arg of argv)
    if (arg !== '--apply') throw new Error(`Unknown argument "${arg}". ${USAGE}`);
  return argv.includes('--apply');
}

async function main(): Promise<void> {
  const apply = parseApply(process.argv.slice(2));
  await connectToMongo();
  const { run, decisions } = await resolveAirportIds(getDb(), { apply, mapFile: MAP_FILE }, logger);
  const { peakRssMb, mode, rowsWithNumericIds, rowsFullyResolved } = run;
  logger.info(
    {
      mode,
      referenceRows: run.referenceRows,
      referenceKeys: run.referenceKeys,
      ambiguousKeys: run.ambiguousKeys,
      rowsWithNumericIds,
      rowsMatched: run.rowsMatched,
      distinctIds: run.distinctIds,
      mappedIds: run.mappedIds,
      unmapped: decisions
        .filter((d) => !d.accepted)
        .map((d) => `${d.id}:${d.reason}:${d.iata ?? '-'}:${d.votes}:${d.topShare.toFixed(4)}`),
      rowsFullyResolved,
      fullyResolvedShare: rowsWithNumericIds === 0 ? 0 : rowsFullyResolved / rowsWithNumericIds,
      rowsUpdated: run.rowsUpdated,
      peakRssMb,
      mapFile: MAP_FILE,
    },
    apply ? 'Applied airport id mapping' : 'Dry run: nothing written to flights (use --apply)',
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'resolve:airport-ids failed');
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
