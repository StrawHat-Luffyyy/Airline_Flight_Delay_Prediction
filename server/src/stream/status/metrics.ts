/**
 * Live-prediction metrics for GET /api/stream/status (PROJECT_OVERVIEW §15.8). Pure: the counts come
 * from stream_flights (status/queries.ts), never from consumer counters, so a redelivered flight is
 * never counted twice.
 */

/** Below this many judged flights a metric group is marked low-sample (numbers still returned). */
export const LOW_SAMPLE_BELOW = 200;

export interface ConfusionCounts {
  /** Predicted delayed, was delayed. */
  tp: number;
  /** Predicted delayed, was on time. */
  fp: number;
  /** Predicted on time, was delayed. */
  fn: number;
  /** Predicted on time, was on time. */
  tn: number;
}

export interface DerivedMetrics extends ConfusionCounts {
  n: number;
  lowSample: boolean;
  /** Null when nothing was predicted delayed (TP + FP = 0). */
  precision: number | null;
  /** Null when nothing was actually delayed (TP + FN = 0). */
  recall: number | null;
  /** Null when precision or recall is null, or both are 0. */
  f1: number | null;
  /** Share of judged flights that were delayed; null when n = 0. */
  baseRate: number | null;
  /** Accuracy only ever travels with the same-sample majority-class baseline; null when n = 0. */
  accuracy: { value: number; majorityBaseline: number } | null;
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

export function deriveMetrics(counts: ConfusionCounts): DerivedMetrics {
  const { tp, fp, fn, tn } = counts;
  const n = tp + fp + fn + tn;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  const baseRate = ratio(tp + fn, n);
  return {
    ...counts,
    n,
    lowSample: n < LOW_SAMPLE_BELOW,
    precision,
    recall,
    f1,
    baseRate,
    accuracy:
      baseRate === null
        ? null
        : { value: (tp + tn) / n, majorityBaseline: Math.max(baseRate, 1 - baseRate) },
  };
}

export interface ScoredPair {
  /** Stored predicted probability of delay. */
  p: number;
  /** Actual outcome: delayed. */
  y: boolean;
}

/**
 * ROC-AUC as the Mann-Whitney statistic: the share of (delayed, on-time) pairs ranked correctly,
 * ties counting one half. It holds every (p, y) entry in memory (O(n), not O(positives x
 * negatives)), so it is only computed for the bounded rolling window.
 * Null when the pairs hold only one class.
 */
export function rocAuc(pairs: readonly ScoredPair[]): number | null {
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  let positives = 0;
  let negatives = 0;
  let positiveRankSum = 0;
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (end < sorted.length && sorted[end]!.p === sorted[start]!.p) end += 1;
    // Ranks are 1-based; a run of ties shares the mean of its ranks.
    const meanRank = (start + 1 + end) / 2;
    for (let i = start; i < end; i += 1) {
      if (sorted[i]!.y) {
        positives += 1;
        positiveRankSum += meanRank;
      } else {
        negatives += 1;
      }
    }
    start = end;
  }
  if (positives === 0 || negatives === 0) return null;
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}
