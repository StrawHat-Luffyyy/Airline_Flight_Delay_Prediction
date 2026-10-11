import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  mongo: z.enum(['up', 'down']),
  modelLoaded: z.boolean(),
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
