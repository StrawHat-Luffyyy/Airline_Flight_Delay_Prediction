import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  mongo: z.enum(['up', 'down']),
  modelLoaded: z.literal(false),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
