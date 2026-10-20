export interface ReplayArgs {
  /** Calendar month to replay, 1-12 (December by default: held-out test data). */
  month: number;
  /** Target events per second; 0 = as fast as possible. */
  rate: number;
  /** Stop after this many events from the month (smoke and measurement runs). */
  limit: number | undefined;
  /** Directory holding flights.csv (default data/raw). */
  dir: string | undefined;
}

export const REPLAY_USAGE =
  'Usage: npm run stream:replay -- [--month 1-12] [--rate EVENTS_PER_SEC|0] [--limit N] [--dir PATH]';

function value(argv: readonly string[], index: number, flag: string): string {
  const raw = argv[index];
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error(`${flag} needs a value. ${REPLAY_USAGE}`);
  }
  return raw;
}

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const args: ReplayArgs = { month: 12, rate: 1000, limit: undefined, dir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--month') {
      const month = Number(value(argv, (i += 1), flag));
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new Error(`--month must be 1-12. ${REPLAY_USAGE}`);
      }
      args.month = month;
    } else if (flag === '--rate') {
      const rate = Number(value(argv, (i += 1), flag));
      if (!Number.isFinite(rate) || rate < 0) {
        throw new Error(`--rate must be a number of events per second, or 0. ${REPLAY_USAGE}`);
      }
      args.rate = rate;
    } else if (flag === '--limit') {
      const limit = Number(value(argv, (i += 1), flag));
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(`--limit needs a positive integer. ${REPLAY_USAGE}`);
      }
      args.limit = limit;
    } else if (flag === '--dir') {
      args.dir = value(argv, (i += 1), flag);
    } else {
      throw new Error(`Unknown argument "${flag}". ${REPLAY_USAGE}`);
    }
  }
  return args;
}
