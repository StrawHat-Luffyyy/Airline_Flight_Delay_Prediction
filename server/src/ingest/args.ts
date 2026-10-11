export type IngestMode = 'fresh' | 'drop' | 'append';

export interface IngestArgs {
  /** fresh: refuse when `flights` is non-empty; drop: rebuild; append: add to existing data. */
  mode: IngestMode;
  /** Stop after this many flight rows (smoke runs). */
  limit: number | undefined;
  /** Directory holding flights.csv, airlines.csv, airports.csv. */
  dir: string | undefined;
}

export const INGEST_USAGE = 'Usage: npm run ingest -- [--drop | --append] [--limit N] [--dir PATH]';

export function parseIngestArgs(argv: readonly string[]): IngestArgs {
  let drop = false;
  let append = false;
  let limit: number | undefined;
  let dir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--drop') drop = true;
    else if (arg === '--append') append = true;
    else if (arg === '--limit') {
      const value = Number(argv[(i += 1)]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit needs a positive integer. ${INGEST_USAGE}`);
      }
      limit = value;
    } else if (arg === '--dir') {
      const value = argv[(i += 1)];
      if (value === undefined || value === '')
        throw new Error(`--dir needs a path. ${INGEST_USAGE}`);
      dir = value;
    } else {
      throw new Error(`Unknown argument "${arg}". ${INGEST_USAGE}`);
    }
  }

  if (drop && append) throw new Error(`Use either --drop or --append, not both. ${INGEST_USAGE}`);
  return { mode: drop ? 'drop' : append ? 'append' : 'fresh', limit, dir };
}
