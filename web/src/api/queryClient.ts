import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';

/** The dataset is static, so cache for a long time; never retry a client error. */
export const STALE_TIME_MS = 10 * 60 * 1000;

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  if (error instanceof ApiError && error.code === 'CONTRACT') return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
