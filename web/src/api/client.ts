import { ErrorResponseSchema } from '@flight-delay/shared';
import type { z } from 'zod';

/** Every failure the UI can see from the API, normalised to one shape. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export function buildPath(path: string, params?: QueryParams): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function request<S extends z.ZodType>(
  path: string,
  init: RequestInit,
  schema: S,
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the API. Check that the server is running.');
  }

  const body = await readJson(response);

  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiError(response.status, code, message, details);
    }
    throw new ApiError(
      response.status,
      `HTTP_${response.status}`,
      `The API answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`,
    );
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(
      response.status,
      'CONTRACT',
      'The API response did not match the expected shape.',
      result.error.issues,
    );
  }
  return result.data;
}

export function apiGet<S extends z.ZodType>(
  path: string,
  schema: S,
  params?: QueryParams,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  return request(
    buildPath(path, params),
    { method: 'GET', headers: { Accept: 'application/json' }, signal },
    schema,
  );
}

export function apiPost<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
): Promise<z.output<S>> {
  return request(
    path,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    schema,
  );
}
