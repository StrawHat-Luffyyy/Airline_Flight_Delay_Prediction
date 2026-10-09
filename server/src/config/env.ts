import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const envSchema = z.object({
  MONGODB_URI: z.string().url(),
  MONGODB_DB: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  NODE_ENV: z.enum(['development', 'test', 'production']),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = result.data;
