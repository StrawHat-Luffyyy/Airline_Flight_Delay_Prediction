import {
  CancellationsResponseSchema,
  CascadeResponseSchema,
  CausesResponseSchema,
  DelayDistributionResponseSchema,
  DelayRateResponseSchema,
  FeatureImportanceResponseSchema,
  FlightsResponseSchema,
  HeatmapResponseSchema,
  MetaResponseSchema,
  ModelMetricsResponseSchema,
  PredictResponseSchema,
  RoutesResponseSchema,
  SummaryResponseSchema,
  TrendResponseSchema,
  type CancellationsQuery,
  type CausesQuery,
  type DelayRateQuery,
  type PredictRequest,
  type TrendQuery,
} from '@flight-delay/shared';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';

export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => apiGet('/api/meta', MetaResponseSchema, undefined, signal),
  });
}

export function useSummary() {
  return useQuery({
    queryKey: ['summary'],
    queryFn: ({ signal }) =>
      apiGet('/api/analytics/summary', SummaryResponseSchema, undefined, signal),
  });
}

export function useTrend(granularity: TrendQuery['granularity'] = 'month') {
  return useQuery({
    queryKey: ['trend', granularity],
    queryFn: ({ signal }) =>
      apiGet('/api/analytics/trend', TrendResponseSchema, { granularity }, signal),
  });
}

export function useCauses(by: CausesQuery['by'] = 'overall') {
  return useQuery({
    queryKey: ['causes', by],
    queryFn: ({ signal }) => apiGet('/api/analytics/causes', CausesResponseSchema, { by }, signal),
    // No placeholder: a different `by` is a different row shape (months vs airlines).
  });
}

export interface DelayRateParams {
  by: DelayRateQuery['by'];
  minFlights?: number;
  limit?: number;
  order?: DelayRateQuery['order'];
}

/**
 * Keeps the previous rows while a new sort, minimum or limit loads, so boards can animate between
 * them. A different `by` is a different entity (airlines vs routes), so it never reuses old rows:
 * they would render under the new entity's columns and actions.
 */
export function useDelayRate(params: DelayRateParams) {
  const { by, minFlights = 500, limit = 20, order = 'worst' } = params;
  return useQuery({
    queryKey: ['delay-rate', by, minFlights, limit, order],
    queryFn: ({ signal }) =>
      apiGet(
        '/api/analytics/delay-rate',
        DelayRateResponseSchema,
        { by, minFlights, limit, order },
        signal,
      ),
    placeholderData: (previous, previousQuery) =>
      previous !== undefined && previousQuery?.queryKey[1] === by ? previous : undefined,
  });
}

export function useCascade() {
  return useQuery({
    queryKey: ['cascade'],
    queryFn: ({ signal }) =>
      apiGet('/api/analytics/cascade', CascadeResponseSchema, undefined, signal),
  });
}

export function useCancellations(by: CancellationsQuery['by'] = 'overall') {
  return useQuery({
    queryKey: ['cancellations', by],
    queryFn: ({ signal }) =>
      apiGet('/api/analytics/cancellations', CancellationsResponseSchema, { by }, signal),
  });
}

export function useDelayDistribution() {
  return useQuery({
    queryKey: ['delay-distribution'],
    queryFn: ({ signal }) =>
      apiGet(
        '/api/analytics/delay-distribution',
        DelayDistributionResponseSchema,
        undefined,
        signal,
      ),
  });
}

/** Destinations flown from `origin` in 2015, busiest first (only these can be scored). */
export function useRoutes(origin: string) {
  return useQuery({
    queryKey: ['routes', origin],
    enabled: origin !== '',
    queryFn: ({ signal }) => apiGet('/api/routes', RoutesResponseSchema, { origin }, signal),
  });
}

export function useHeatmap() {
  return useQuery({
    queryKey: ['heatmap'],
    queryFn: ({ signal }) =>
      apiGet('/api/analytics/heatmap', HeatmapResponseSchema, undefined, signal),
  });
}

export interface FlightsParams {
  route?: string;
  airline?: string;
  origin?: string;
  dest?: string;
  limit?: number;
}

/** The server's `nextCursor: null` on the last page means there is no next page (undefined). */
export function nextFlightsCursor(lastPage: { nextCursor: string | null }): string | undefined {
  return lastPage.nextCursor ?? undefined;
}

/** Cursor pagination: call fetchNextPage while hasNextPage. */
export function useFlights(params: FlightsParams, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['flights', params],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiGet(
        '/api/flights',
        FlightsResponseSchema,
        { ...params, limit: params.limit ?? 20, cursor: pageParam },
        signal,
      ),
    getNextPageParam: nextFlightsCursor,
  });
}

export function useModelMetrics() {
  return useQuery({
    queryKey: ['model-metrics'],
    queryFn: ({ signal }) =>
      apiGet('/api/model/metrics', ModelMetricsResponseSchema, undefined, signal),
  });
}

export function useFeatureImportance() {
  return useQuery({
    queryKey: ['feature-importance'],
    queryFn: ({ signal }) =>
      apiGet('/api/model/feature-importance', FeatureImportanceResponseSchema, undefined, signal),
  });
}

export function usePredict() {
  return useMutation({
    mutationFn: (body: PredictRequest) => apiPost('/api/predict', body, PredictResponseSchema),
  });
}
