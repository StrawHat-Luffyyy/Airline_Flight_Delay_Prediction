import { describe, expect, it } from 'vitest';
import { deriveMetrics, LOW_SAMPLE_BELOW, rocAuc } from '../../src/stream/status/metrics.js';

describe('deriveMetrics', () => {
  it('derives precision, recall, F1, base rate and accuracy beside its majority baseline', () => {
    // 100 judged flights: 30 delayed (TP 20, FN 10), 70 on time (FP 15, TN 55).
    const m = deriveMetrics({ tp: 20, fp: 15, fn: 10, tn: 55 });
    expect(m.n).toBe(100);
    expect(m.precision).toBeCloseTo(20 / 35, 12);
    expect(m.recall).toBeCloseTo(20 / 30, 12);
    expect(m.f1).toBeCloseTo((2 * 20) / (2 * 20 + 15 + 10), 12);
    expect(m.baseRate).toBeCloseTo(0.3, 12);
    expect(m.accuracy).toEqual({ value: 0.75, majorityBaseline: 0.7 });
    expect(m.lowSample).toBe(true);
  });

  it('returns null, never 0 or NaN, when a denominator is zero', () => {
    // Nothing predicted delayed and nothing actually delayed.
    const m = deriveMetrics({ tp: 0, fp: 0, fn: 0, tn: 250 });
    expect(m.precision).toBeNull();
    expect(m.recall).toBeNull();
    expect(m.f1).toBeNull();
    expect(m.baseRate).toBe(0);
    expect(m.accuracy).toEqual({ value: 1, majorityBaseline: 1 });
    expect(m.lowSample).toBe(false);
  });

  it('returns null F1 when precision and recall are both 0', () => {
    const m = deriveMetrics({ tp: 0, fp: 5, fn: 5, tn: 190 });
    expect(m.precision).toBe(0);
    expect(m.recall).toBe(0);
    expect(m.f1).toBeNull();
  });

  it('returns no accuracy, baseline or base rate for an empty sample', () => {
    const m = deriveMetrics({ tp: 0, fp: 0, fn: 0, tn: 0 });
    expect(m).toMatchObject({ n: 0, baseRate: null, accuracy: null, lowSample: true });
  });

  it('marks samples under the low-sample threshold', () => {
    expect(LOW_SAMPLE_BELOW).toBe(200);
    expect(deriveMetrics({ tp: 1, fp: 1, fn: 1, tn: 196 }).lowSample).toBe(true);
    expect(deriveMetrics({ tp: 1, fp: 1, fn: 1, tn: 197 }).lowSample).toBe(false);
  });
});

describe('rocAuc', () => {
  it('is 1 when every delayed flight scores above every on-time one', () => {
    expect(
      rocAuc([
        { p: 0.9, y: true },
        { p: 0.8, y: true },
        { p: 0.2, y: false },
        { p: 0.1, y: false },
      ]),
    ).toBe(1);
  });

  it('is 0 when the ranking is fully inverted', () => {
    expect(
      rocAuc([
        { p: 0.1, y: true },
        { p: 0.9, y: false },
      ]),
    ).toBe(0);
  });

  it('counts a tie between a positive and a negative as one half', () => {
    expect(
      rocAuc([
        { p: 0.5, y: true },
        { p: 0.5, y: false },
      ]),
    ).toBe(0.5);
  });

  it('matches a hand-worked example with a tie', () => {
    // Positives 0.8, 0.4; negatives 0.6, 0.4, 0.2.
    // Pairs: (0.8 beats all 3) + (0.4 beats 0.2, ties 0.4, loses to 0.6) = 3 + 1 + 0.5 = 4.5 of 6.
    expect(
      rocAuc([
        { p: 0.8, y: true },
        { p: 0.4, y: true },
        { p: 0.6, y: false },
        { p: 0.4, y: false },
        { p: 0.2, y: false },
      ]),
    ).toBe(0.75);
  });

  it('is null when the window holds only one class', () => {
    expect(rocAuc([{ p: 0.3, y: false }])).toBeNull();
    expect(rocAuc([])).toBeNull();
  });
});
