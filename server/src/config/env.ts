import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { fromRepoRoot } from '../paths.js';

dotenv.config({ path: fromRepoRoot('.env'), quiet: true });

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

const envSchema = z
  .object({
    MONGODB_URI: z.string().url(),
    MONGODB_DB: z.string().min(1),
    // Only the API listens; processes without an HTTP port (the consumer, the CLIs) need not set it.
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    NODE_ENV: z.enum(['development', 'test', 'production']),
    // Browser origins allowed by CORS, comma-separated. The Vite dev server proxies /api, so this
    // matters for direct calls: a dashboard served from another origin (VITE_API_BASE_URL). Each entry is
    // reduced to its origin, because a browser compares Access-Control-Allow-Origin exactly and a pasted
    // trailing slash (`https://dashboard.example.org/`) would otherwise block every request.
    CORS_ORIGIN: z
      .string()
      .default('http://localhost:5173')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin !== ''),
      )
      .pipe(
        z
          .array(
            z
              .string()
              .refine(isHttpUrl, 'expected an http(s) URL')
              .transform((origin) => new URL(origin).origin),
          )
          .min(1),
      ),
    // Interface the API binds to. Loopback by default: the app is local-only (PROJECT_OVERVIEW §2).
    HOST: z.string().min(1).default('127.0.0.1'),
    // POST /api/predict requests per client IP per minute (the only write-like, CPU-bound endpoint).
    PREDICT_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(10_000).default(30),
    // Reverse proxies in front of the API (Caddy in the production compose file: 1). Express then
    // takes the client address from that many X-Forwarded-For entries, counted from the right, so
    // the /predict limit is per client rather than per proxy. A hop count, never `true`: trusting
    // every entry would let a client forge its own rate-limit key. 0 = no proxy (local default).
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
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
    // `plaintext` for the local compose broker. `sasl_ssl` for the production cluster
    // (deploy/docker-compose.prod.yml): TLS verified against KAFKA_SSL_CA_FILE, including the
    // broker hostname, and SASL/PLAIN as KAFKA_SASL_USERNAME. The password may come from
    // KAFKA_SASL_PASSWORD_FILE (a Docker secret).
    KAFKA_SECURITY_PROTOCOL: z.enum(['plaintext', 'sasl_ssl']).default('plaintext'),
    KAFKA_SASL_USERNAME: z.string().min(1).optional(),
    KAFKA_SASL_PASSWORD: z.string().min(1).optional(),
    KAFKA_SSL_CA_FILE: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.KAFKA_SECURITY_PROTOCOL !== 'sasl_ssl') return;
    for (const key of [
      'KAFKA_SASL_USERNAME',
      'KAFKA_SASL_PASSWORD',
      'KAFKA_SSL_CA_FILE',
    ] as const) {
      if (value[key] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'required when KAFKA_SECURITY_PROTOCOL is sasl_ssl',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Variables that may instead be read from the file `<NAME>_FILE` names (a Docker secret). */
const SECRET_FILE_VARIABLES = ['MONGODB_URI', 'KAFKA_SASL_PASSWORD'] as const;

/**
 * MONGODB_URI and KAFKA_SASL_PASSWORD may instead come from the file `<NAME>_FILE` names (a Docker
 * secret mounted under /run/secrets in the production compose file), so credentials never sit in
 * the container's environment where `docker inspect` shows them. Errors name the variable, never
 * the value.
 */
function resolveSecretFiles(
  source: Record<string, string | undefined>,
  readFile: (path: string) => string,
): Record<string, string | undefined> {
  const resolved = { ...source };
  for (const name of SECRET_FILE_VARIABLES) {
    const file = source[`${name}_FILE`];
    if (file === undefined || file === '') continue;
    if (source[name] !== undefined && source[name] !== '') {
      throw new Error(
        `Invalid environment configuration:
set either ${name} or ${name}_FILE, not both`,
      );
    }
    let value: string;
    try {
      value = readFile(file);
    } catch {
      throw new Error(`Invalid environment configuration:
${name}_FILE: cannot read ${file}`);
    }
    resolved[name] = value.trim();
  }
  return resolved;
}

export function parseEnv(
  source: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Env {
  const result = envSchema.safeParse(resolveSecretFiles(source, readFile));
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parseEnv(process.env);
