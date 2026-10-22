/**
 * `npm run stream:watch -- --duration SECONDS [--every SECONDS] [--url URL] --out FILE`: samples
 * GET /api/stream/status at a fixed interval and writes the series (state, consumer lag, flights
 * stored, throughput) as JSON, for lag-over-time evidence in docs/STREAMING.md. It reads through
 * the API, so it never loads the Kafka client itself and keeps sampling through a broker outage.
 * Resolution: the endpoint caches its MongoDB counts for 3 s and its Kafka reading for 2 s.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StreamStatusResponseSchema } from '@flight-delay/shared';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

interface Sample {
  /** Seconds since the first sample. */
  t: number;
  at: string;
  state: string | null;
  reason: string | null;
  lag: number | null;
  stored: number | null;
  throughput: number | null;
  /** Set when the request itself failed (the API was unreachable). */
  error?: string;
}

function args() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      duration: { type: 'string' },
      every: { type: 'string', default: '2' },
      url: { type: 'string', default: `http://127.0.0.1:${env.PORT}` },
      out: { type: 'string' },
    },
    strict: true,
  });
  const duration = Number(values.duration);
  const every = Number(values.every);
  if (!(duration > 0) || !(every > 0) || values.out === undefined) {
    throw new Error(
      'Usage: npm run stream:watch -- --duration SECONDS [--every SECONDS] [--url URL] --out FILE',
    );
  }
  return { duration, every, url: values.url, out: values.out };
}

async function sample(url: string, t0: number): Promise<Sample> {
  const t = Math.round((Date.now() - t0) / 100) / 10;
  const at = new Date().toISOString();
  try {
    const response = await fetch(`${url}/api/stream/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = StreamStatusResponseSchema.parse(await response.json());
    return {
      t,
      at,
      state: body.state,
      reason: body.reason,
      lag: body.kafka.lag?.total ?? null,
      stored: body.stored?.flights ?? null,
      throughput: body.consumer.throughput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      t,
      at,
      state: null,
      reason: null,
      lag: null,
      stored: null,
      throughput: null,
      error: message,
    };
  }
}

async function main(): Promise<void> {
  const { duration, every, url, out } = args();
  const samples: Sample[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < duration * 1000) {
    const started = Date.now();
    samples.push(await sample(url, t0));
    await new Promise((r) => setTimeout(r, Math.max(0, every * 1000 - (Date.now() - started))));
  }
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ url, everySeconds: every, samples }, null, 2)}\n`);
  logger.info({ samples: samples.length, out: path }, 'stream:watch wrote the series');
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'stream:watch failed');
  process.exitCode = 1;
});
