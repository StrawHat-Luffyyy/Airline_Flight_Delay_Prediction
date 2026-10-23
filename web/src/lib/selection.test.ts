import { describe, expect, it } from 'vitest';
import { flaggedShare, liftOverBaseRate } from './selection';

// The served LightGBM on the test months (ml/artifacts/metrics.json).
const test = { tn: 711981, fp: 472825, fn: 94948, tp: 132081 };

describe('flaggedShare', () => {
  it('is the share of flights the model flagged delayed', () => {
    expect(flaggedShare(test)).toBeCloseTo(604906 / 1411835, 12);
  });

  it('is null with no flights, 0 when nothing was flagged', () => {
    expect(flaggedShare({ tn: 0, fp: 0, fn: 0, tp: 0 })).toBeNull();
    expect(flaggedShare({ tn: 9, fp: 0, fn: 1, tp: 0 })).toBe(0);
  });
});

describe('liftOverBaseRate', () => {
  it('is precision divided by the share actually delayed', () => {
    const precision = 132081 / 604906;
    const baseRate = 227029 / 1411835;
    expect(liftOverBaseRate(test)).toBeCloseTo(precision / baseRate, 12);
  });

  it('is null when nothing was flagged or nothing was delayed', () => {
    expect(liftOverBaseRate({ tn: 9, fp: 0, fn: 1, tp: 0 })).toBeNull();
    expect(liftOverBaseRate({ tn: 9, fp: 1, fn: 0, tp: 0 })).toBeNull();
  });
});
