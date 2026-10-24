import { vi } from 'vitest';

/**
 * Timeouts for a MongoDB integration test file. These tests check results, not speed (latency is
 * measured separately, docs/EXPLAIN_RESULTS.md), but they build indexes and seed collections on a
 * shared MongoDB while the rest of the suite runs in parallel: on a busy machine an index build
 * took over the 5 s default (measured 2026-10-24), while it takes about 2 s alone. Unit tests keep
 * the strict defaults, so a real hang there still fails fast. Call once at the top of the file.
 */
export function useIntegrationTimeouts(): void {
  vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });
}
