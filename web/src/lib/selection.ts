/** How selective a set of verdicts is, from its confusion counts. */
export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** Share of flights flagged delayed; null when there are no flights. */
export function flaggedShare({ tp, fp, fn, tn }: Confusion): number | null {
  const n = tp + fp + fn + tn;
  return n === 0 ? null : (tp + fp) / n;
}

/**
 * Precision divided by the share of flights actually delayed: how much more likely a flagged
 * flight is to be delayed than any flight. 1 means the flag adds nothing. Null when nothing was
 * flagged or nothing was delayed.
 */
export function liftOverBaseRate({ tp, fp, fn, tn }: Confusion): number | null {
  const n = tp + fp + fn + tn;
  if (tp + fp === 0 || tp + fn === 0) return null;
  return tp / (tp + fp) / ((tp + fn) / n);
}
