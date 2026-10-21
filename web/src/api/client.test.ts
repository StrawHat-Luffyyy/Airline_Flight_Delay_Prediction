import { HealthResponseSchema, SummaryResponseSchema } from '@flight-delay/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, apiPost, buildPath } from './client';
import { nextFlightsCursor } from './hooks';

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const summary = {
  flights: 10,
  completed: 9,
  delayed: 2,
  delayRate: 2 / 9,
  cancelled: 1,
  cancelRate: 0.1,
  diverted: 0,
  avgArrDelay: 3.2,
};

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildPath', () => {
  it('skips empty params', () => {
    expect(buildPath('/api/x', { a: 1, b: undefined, c: '', d: 'z' })).toBe('/api/x?a=1&d=z');
    expect(buildPath('/api/x')).toBe('/api/x');
  });
});

describe('health response (Phase 8 adds an informational kafka field)', () => {
  it('parses a health body that reports Kafka down, without changing status', async () => {
    stubFetch(json({ status: 'ok', mongo: 'up', modelLoaded: true, kafka: 'down' }));
    const health = await apiGet('/api/health', HealthResponseSchema);
    expect(health).toEqual({ status: 'ok', mongo: 'up', modelLoaded: true, kafka: 'down' });
  });

  it('rejects an unknown kafka value instead of passing it through', async () => {
    stubFetch(json({ status: 'ok', mongo: 'up', modelLoaded: true, kafka: 'maybe' }));
    await expect(apiGet('/api/health', HealthResponseSchema)).rejects.toThrow();
  });
});

describe('api client', () => {
  it('parses a success body with the schema', async () => {
    const fetchMock = stubFetch(json(summary));
    const result = await apiGet('/api/analytics/summary', SummaryResponseSchema);
    expect(result.flights).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError built from an error body', async () => {
    stubFetch(
      json(
        { error: { code: 'UNKNOWN_CODE', message: 'Unknown dest code ZZZ', details: { a: 1 } } },
        422,
      ),
    );
    const error = await failure(apiPost('/api/predict', {}, SummaryResponseSchema));
    expect(error.status).toBe(422);
    expect(error.code).toBe('UNKNOWN_CODE');
    expect(error.message).toBe('Unknown dest code ZZZ');
    expect(error.details).toEqual({ a: 1 });
  });

  it('uses HTTP_<status> when the error body is not JSON', async () => {
    stubFetch(new Response('<html>bad gateway</html>', { status: 502 }));
    const error = await failure(apiGet('/api/meta', SummaryResponseSchema));
    expect(error.code).toBe('HTTP_502');
    expect(error.status).toBe(502);
  });

  it('uses NETWORK when fetch rejects', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    const error = await failure(apiGet('/api/meta', SummaryResponseSchema));
    expect(error.code).toBe('NETWORK');
  });

  it('throws a CONTRACT error when the body does not match the schema', async () => {
    stubFetch(json({ flights: 'many' }));
    const error = await failure(apiGet('/api/analytics/summary', SummaryResponseSchema));
    expect(error.code).toBe('CONTRACT');
  });
});

describe('404 and pagination', () => {
  it('throws ApiError from a 404 error body', async () => {
    stubFetch(
      json(
        { error: { code: 'MODEL_NOT_REGISTERED', message: 'No model has been registered.' } },
        404,
      ),
    );
    const error = await failure(apiGet('/api/model/metrics', SummaryResponseSchema));
    expect(error.status).toBe(404);
    expect(error.code).toBe('MODEL_NOT_REGISTERED');
    expect(error.message).toBe('No model has been registered.');
  });

  it('maps a null nextCursor to undefined and keeps a real cursor', () => {
    expect(nextFlightsCursor({ nextCursor: null })).toBeUndefined();
    expect(nextFlightsCursor({ nextCursor: 'abc' })).toBe('abc');
  });
});
