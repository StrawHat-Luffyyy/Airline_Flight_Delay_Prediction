import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  mongo: z.enum(['up', 'down']),
  modelLoaded: z.boolean(),
  /** Informational (Phase 8): never changes `status` or the HTTP code. */
  kafka: z.enum(['up', 'down']),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export * from './flights.js';
export * from './analytics.js';
export * from './model.js';
export * from './stream.js';
export * from './stream-status.js';
