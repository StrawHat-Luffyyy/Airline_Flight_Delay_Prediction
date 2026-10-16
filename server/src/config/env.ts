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
