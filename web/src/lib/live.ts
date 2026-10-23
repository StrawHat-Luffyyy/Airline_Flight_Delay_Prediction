import type { StreamMetricGroup, StreamTotalsGroup, StreamWindowGroup } from '@flight-delay/shared';
import { formatInteger, formatPercent } from './format';
import { flaggedShare } from './selection';

const EM_DASH = '—';

/** One value of the live metric board, with the sample it was computed on. */
export interface MetricCell {
  value: string;
  /** The rate's own denominator (null for a raw count). */
  n: number | null;
  /** What n counts: "flagged", "delayed", "judged"; or why there is no value. */
  basis: string | null;
}

export interface MetricRow {
  id: string;
  label: string;
  /** Plain-language reading of the metric, for the row's description. */
  hint: string;
  /** Delay figures are amber (the Lit Column Rule); everything else stays ink. */
  tone: 'delay' | 'ink';
  /** Raw confusion counts sit below the rates, under their own heading. */
  kind: 'rate' | 'count';
  window: MetricCell | null;
  totals: MetricCell | null;
}

const fixed3 = (value: number | null) => (value === null ? EM_DASH : value.toFixed(3));

type Group = StreamMetricGroup & { rocAuc?: number | null };

interface Spec {
  id: string;
  label: string;
  hint: string;
  tone?: 'delay' | 'ink';
  kind?: 'rate' | 'count';
  cell: (group: Group, which: 'window' | 'totals') => MetricCell;
}

const SPECS: Spec[] = [
  {
    id: 'precision',
    label: 'Precision',
    hint: 'Of the flights flagged delayed, the share that were',
    cell: (g) => ({ value: fixed3(g.precision), n: g.tp + g.fp, basis: 'flagged' }),
  },
  {
    id: 'recall',
    label: 'Recall',
    hint: 'Of the flights that were delayed, the share flagged',
    cell: (g) => ({ value: fixed3(g.recall), n: g.tp + g.fn, basis: 'delayed' }),
  },
  {
    id: 'f1',
    label: 'F1',
    hint: 'Balance of precision and recall',
    cell: (g) => ({ value: fixed3(g.f1), n: g.n, basis: 'judged' }),
  },
  {
    id: 'accuracy',
    label: 'Accuracy',
    hint: 'Share of verdicts that were right',
    cell: (g) => ({ value: formatPercent(g.accuracy?.value), n: g.n, basis: 'judged' }),
  },
  {
    id: 'baseline',
    label: 'Majority baseline',
    hint: 'Accuracy of always answering the more common outcome',
    cell: (g) => ({ value: formatPercent(g.accuracy?.majorityBaseline), n: g.n, basis: 'judged' }),
  },
  {
    id: 'flagged',
    label: 'Share flagged',
    hint: 'Flights the model flagged delayed; compare with the delayed share below',
    cell: (g) => ({ value: formatPercent(flaggedShare(g)), n: g.n, basis: 'judged' }),
  },
  {
    id: 'baseRate',
    label: 'Delayed share',
    hint: 'Flights that arrived 15+ minutes late',
    tone: 'delay',
    cell: (g) => ({ value: formatPercent(g.baseRate), n: g.n, basis: 'judged' }),
  },
  {
    id: 'rocAuc',
    label: 'ROC-AUC',
    hint: 'Ranking quality of the stored probabilities (0.5 is a coin flip)',
    cell: (g, which) =>
      which === 'totals'
        ? { value: EM_DASH, n: null, basis: 'window only' }
        : { value: fixed3(g.rocAuc ?? null), n: g.n, basis: 'judged' },
  },
  ...(
    [
      ['tp', 'Flagged, was delayed', 'True positives'],
      ['fp', 'Flagged, was on time', 'False positives'],
      ['fn', 'Missed, was delayed', 'False negatives'],
      ['tn', 'Cleared, was on time', 'True negatives'],
    ] as const
  ).map(([id, label, hint]): Spec => ({
    id,
    label,
    hint,
    kind: 'count',
    cell: (g) => ({ value: formatInteger(g[id]), n: null, basis: null }),
  })),
];

/** The metric board's rows: each metric for the rolling window and for the whole replay. */
export function metricRows(
  window: StreamWindowGroup | undefined,
  totals: StreamTotalsGroup | undefined,
): MetricRow[] {
  return SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    hint: spec.hint,
    tone: spec.tone ?? 'ink',
    kind: spec.kind ?? 'rate',
    window: window ? spec.cell(window, 'window') : null,
    totals: totals ? spec.cell(totals, 'totals') : null,
  }));
}

export interface GroupPair {
  key: string;
  modelVersion: string;
  threshold: number;
  servedModel: boolean;
  window?: StreamWindowGroup;
  totals?: StreamTotalsGroup;
}

/**
 * A short reading of the consumer's rate against its backlog, for the throughput tile: a rate of
 * 0 is idle only when nothing is waiting. Null when there is nothing to add: events flowing with
 * no backlog, lag unknown, or no live consumer (a stopped one is neither idle nor catching up).
 */
export function throughputNote({
  fresh,
  throughput,
  lag,
}: {
  fresh: boolean;
  throughput: number | null;
  lag: number | null;
}): string | null {
  if (!fresh || lag === null || throughput === null) return null;
  if (lag > 0) return 'catching up';
  if (throughput === 0) return 'idle: no events arriving, consumer caught up';
  return null;
}

/** Window and totals groups matched by (modelVersion, threshold), in first-seen order. */
export function pairGroups(
  windowGroups: readonly StreamWindowGroup[],
  totalsGroups: readonly StreamTotalsGroup[],
): GroupPair[] {
  const pairs = new Map<string, GroupPair>();
  const entry = (group: StreamMetricGroup) => {
    const key = `${group.modelVersion}|${group.threshold}`;
    let pair = pairs.get(key);
    if (pair === undefined) {
      pair = {
        key,
        modelVersion: group.modelVersion,
        threshold: group.threshold,
        servedModel: group.servedModel,
      };
      pairs.set(key, pair);
    }
    return pair;
  };
  for (const group of windowGroups) entry(group).window = group;
  for (const group of totalsGroups) entry(group).totals = group;
  return [...pairs.values()];
}

/** 4 -> "4 s ago", 125 -> "2 min ago". */
export function ageLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return EM_DASH;
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds)} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

/**
 * Seconds since the newest heartbeat: the API's own measurement plus the browser time since that
 * answer arrived. Free of clock skew between browser and server, and it keeps ageing while polls
 * fail.
 */
export function heartbeatAgeSeconds(
  apiAgeSeconds: number | null,
  answeredAt: number,
  now: number,
): number | null {
  if (apiAgeSeconds === null) return null;
  return Math.max(0, apiAgeSeconds + (now - answeredAt) / 1000);
}

const DATE_TIME: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

/** "2026-10-20T12:44:30.017Z" -> "20 Oct, 18:14:30" in the viewer's time zone. */
export function dateTimeOf(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString('en-GB', DATE_TIME);
}

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** The API's reasons quote ISO timestamps; show each as a readable local date and time. */
export function readable(text: string): string {
  return text.replace(ISO_TIMESTAMP, (iso) => dateTimeOf(iso));
}

/** "a → b", or just "a" when both ends read the same. */
export function spanOf(from: string, to: string): string {
  return from === to ? from : `${from} → ${to}`;
}

/** 1 -> "1 partition", 3 -> "3 partitions". */
export function plural(count: number, noun: string): string {
  return `${formatInteger(count)} ${noun}${count === 1 ? '' : 's'}`;
}
