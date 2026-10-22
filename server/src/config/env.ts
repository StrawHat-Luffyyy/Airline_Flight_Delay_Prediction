import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const envSchema = z.object({
  MONGODB_URI: z.string().url(),
  MONGODB_DB: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  // Browser origin allowed by CORS. The Vite dev server proxies /api, so this only matters for direct calls.
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  // Interface the API binds to. Loopback by default: the app is local-only (PROJECT_OVERVIEW §2).
  HOST: z.string().min(1).default('127.0.0.1'),
  // POST /api/predict requests per client IP per minute (the only write-like, CPU-bound endpoint).
  PREDICT_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(10_000).default(30),
  // Phase 8 speed layer (PROJECT_OVERVIEW §15). All optional: the API runs without Kafka.
  // Comma-separated host:port list. 127.0.0.1 rather than localhost: see docker-compose.yml.
  KAFKA_BROKERS: z
    .string()
    .default('127.0.0.1:9092')
    .transform((value) =>
      value
        .split(',')
        .map((broker) => broker.trim())
        .filter((broker) => broker !== ''),
    )
    .pipe(
      z
        .array(
          z
            .string()
            .regex(/^[^\s:,]+:\d{1,5}$/, 'expected host:port')
            .refine((broker) => Number(broker.split(':')[1]) <= 65535, 'port must be 1-65535'),
        )
        .min(1),
    ),
  KAFKA_CLIENT_ID: z.string().min(1).default('flight-delay'),
  KAFKA_CONSUMER_GROUP: z.string().min(1).default('flight-stream'),
  KAFKA_TOPIC_RAW: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,249}$/)
    .default('flights.raw'),
  KAFKA_TOPIC_DLQ: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,249}$/)
    .default('flights.dlq'),
  // Rolling window of GET /api/stream/status: the newest N judged flights in replay order.
  STREAM_WINDOW_SIZE: z.coerce.number().int().min(100).max(20_000).default(2_000),
  // Consumer group session timeout (ms), bounded by the broker's group.min/max.session.timeout.ms
  // defaults (6 s to 30 min). 10 s, not the client's 30 s: after a broker restart the consumer
  // resumed 36.9 s later with 30 s and 17.2 s later with 10 s (runs R2 and R3, docs/STREAMING.md).
  // librdkafka heartbeats from its own thread, so slow batches do not count against it.
  KAFKA_SESSION_TIMEOUT_MS: z.coerce.number().int().min(6_000).max(1_800_000).default(10_000),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parseEnv(process.env);
