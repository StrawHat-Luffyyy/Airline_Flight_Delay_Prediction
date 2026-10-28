/**
 * Pure logic behind the Compare page: the selection kept in the URL (so a comparison can be
 * shared or reloaded), the metric rows of the head-to-head table, and value/difference formatting.
 */
import {
  COMPARE_MAX,
  COMPARE_MIN_FLIGHTS,
  COMPARE_TYPES,
  isCompareIdFormat,
  type CompareDifferences,
  type CompareLeaderMetric,
  type CompareTotals,
  type CompareType,
} from '@flight-delay/shared';
import { formatInteger, formatPercent, formatPoints, formatSignedMinutes } from './format';

export interface Selection {
  type: CompareType;
  /** In order; the first is the baseline. */
  ids: string[];
  /** Flights below which an entity's rates count as an unreliable sample. */
  minFlights: number;
}

/** The thresholds the page offers (`?min=`); anything else falls back to the API default. */
export const MIN_FLIGHTS_OPTIONS = [100, 500, 1000, 5000] as const;

function isCompareType(value: string | null): value is CompareType {
  return value !== null && (COMPARE_TYPES as readonly string[]).includes(value);
}

/** Lenient read of `?type=&ids=`: anything malformed is dropped rather than failing the page. */
export function readSelection(params: URLSearchParams): Selection {
  const raw = params.get('type');
  const type = isCompareType(raw) ? raw : 'airline';
  const ids: string[] = [];
  for (const part of (params.get('ids') ?? '').split(',')) {
    const id = part.trim().toUpperCase();
    if (ids.length < COMPARE_MAX && isCompareIdFormat(type, id) && !ids.includes(id)) ids.push(id);
  }
  const min = Number(params.get('min'));
  const minFlights = (MIN_FLIGHTS_OPTIONS as readonly number[]).includes(min)
    ? min
    : COMPARE_MIN_FLIGHTS;
  return { type, ids, minFlights };
}

export function selectionSearch(selection: Selection): Record<string, string> {
  return {
    type: selection.type,
    ...(selection.ids.length > 0 ? { ids: selection.ids.join(',') } : {}),
    ...(selection.minFlights === COMPARE_MIN_FLIGHTS ? {} : { min: String(selection.minFlights) }),
  };
}

export function addId(selection: Selection, id: string): Selection {
  if (selection.ids.includes(id) || selection.ids.length >= COMPARE_MAX) return selection;
  return { ...selection, ids: [...selection.ids, id] };
}

export function removeId(selection: Selection, id: string): Selection {
  return { ...selection, ids: selection.ids.filter((current) => current !== id) };
}

export function makeBaseline(selection: Selection, id: string): Selection {
  return { ...selection, ids: [id, ...selection.ids.filter((current) => current !== id)] };
}

// ---------- Metrics ----------

export type MetricKind = 'count' | 'rate' | 'minutes';

export interface MetricRow {
  id: keyof CompareTotals & keyof CompareDifferences;
  label: string;
  /** How the value is derived, shown under the label. */
  definition: string;
  kind: MetricKind;
  /** Metrics where the lowest reliable value is marked. */
  leader?: CompareLeaderMetric;
}

/** The head-to-head rows, in reading order: volume, then delay, then disruption. */
export const METRIC_ROWS: readonly MetricRow[] = [
  { id: 'flights', label: 'Flights', definition: 'Scheduled in 2015', kind: 'count' },
  {
    id: 'completed',
    label: 'Completed',
    definition: 'Not cancelled or diverted',
    kind: 'count',
  },
  { id: 'delayed', label: 'Delayed', definition: 'Arrived 15+ min late', kind: 'count' },
  {
    id: 'delayRate',
    label: 'Delay rate',
    definition: 'Delayed ÷ completed',
    kind: 'rate',
    leader: 'delayRate',
  },
  {
    id: 'avgArrDelay',
    label: 'Average arrival delay',
    definition: 'Mean over completed; negative = early',
    kind: 'minutes',
    leader: 'avgArrDelay',
  },
  { id: 'cancelled', label: 'Cancelled', definition: 'Flights cancelled', kind: 'count' },
  {
    id: 'cancelRate',
    label: 'Cancellation rate',
    definition: 'Cancelled ÷ flights',
    kind: 'rate',
    leader: 'cancelRate',
  },
  { id: 'diverted', label: 'Diverted', definition: 'Landed elsewhere', kind: 'count' },
  {
    id: 'divertRate',
    label: 'Diversion rate',
    definition: 'Diverted ÷ flights',
    kind: 'rate',
    leader: 'divertRate',
  },
];

export function formatMetric(kind: MetricKind, value: number | null): string {
  if (kind === 'count') return formatInteger(value);
  if (kind === 'rate') return formatPercent(value);
  return formatSignedMinutes(value);
}

/** A difference from the baseline: signed counts, percentage points for rates, signed minutes. */
export function formatDifference(kind: MetricKind, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (kind === 'rate') return formatPoints(value);
  if (kind === 'minutes') return formatSignedMinutes(value);
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '−'}${formatInteger(Math.abs(value))}`;
}
