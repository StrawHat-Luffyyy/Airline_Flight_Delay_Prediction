import type { z } from 'zod';

export interface ValidationIssue {
  path: string;
  message: string;
}

/** A request failed its zod contract; the error middleware turns it into a 400. */
export class RequestValidationError extends Error {
  constructor(
    message: string,
    readonly details: ValidationIssue[],
  ) {
    super(message);
  }
}

/** Parses req.query against a shared schema, or throws RequestValidationError. */
export function parseQuery<S extends z.ZodType>(schema: S, query: unknown): z.output<S> {
  const result = schema.safeParse(query);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  throw new RequestValidationError(details[0]?.message ?? 'Invalid query', details);
}
