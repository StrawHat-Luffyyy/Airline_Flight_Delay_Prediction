import type { StreamTotalsGroup, StreamWindowGroup } from '@flight-delay/shared';
import { describe, expect, it } from 'vitest';
import {
  ageLabel,
  heartbeatAgeSeconds,
  metricRows,
  pairGroups,
  plural,
  readable,
  spanOf,
} from './live';

const base = {
  modelVersion: 'lightgbm-a',
  threshold: 0.207,
  servedModel: true,
  lowSample: false,
};

// The real 8e window: 2,000 judged flights of 2015-12-31.
const windowGroup: StreamWindowGroup = {
  ...base,
  n: 2000,
  tp: 295,
  fp: 1502,
  fn: 21,
  tn: 182,
  precision: 295 / 1797,
  recall: 295 / 316,
  f1: 0.2792238523426408,
  baseRate: 0.158,
  // Rounded fixture values: 0.2385 (the measured value) sits on a rounding boundary.
  accuracy: { value: 0.2386, majorityBaseline: 0.842 },
  rocAuc: 0.5751638654198864,
};

const totalsGroup: StreamTotalsGroup = {
  ...base,
  n: 469717,
  tp: 56479,
  fp: 146806,
  fn: 40293,
  tn: 226139,
  precision: 0.27783161571193155,
  recall: 0.5836295622700781,
  f1: 0.3764551401900306,
  baseRate: 0.2060219238392479,
  accuracy: { value: 0.6016771800892878, majorityBaseline: 0.7939780761607521 },
  scored: 479230,
  noOutcome: 9513,
};

const row = (rows: ReturnType<typeof metricRows>, id: string) => {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

describe('metricRows', () => {
  const rows = metricRows(windowGroup, totalsGroup);

  it('puts each rate beside its own denominator', () => {
    expect(row(rows, 'precision').window).toEqual({ value: '0.164', n: 1797, basis: 'flagged' });
    expect(row(rows, 'recall').window).toEqual({ value: '0.934', n: 316, basis: 'delayed' });
    expect(row(rows, 'f1').totals).toEqual({ value: '0.376', n: 469717, basis: 'judged' });
  });

  it('pairs accuracy with the majority baseline on the same sample', () => {
    expect(row(rows, 'accuracy').window).toEqual({ value: '23.9%', n: 2000, basis: 'judged' });
    expect(row(rows, 'baseline').window).toEqual({ value: '84.2%', n: 2000, basis: 'judged' });
    expect(row(rows, 'baseline').totals?.value).toBe('79.4%');
  });

  it('marks the delayed share as a delay figure', () => {
    expect(row(rows, 'baseRate').tone).toBe('delay');
    expect(row(rows, 'precision').tone).toBe('ink');
  });

  it('shows ROC-AUC for the window only', () => {
    expect(row(rows, 'rocAuc').window?.value).toBe('0.575');
    expect(row(rows, 'rocAuc').totals).toEqual({ value: '—', n: null, basis: 'window only' });
  });

  it('lists the confusion counts without a rate', () => {
    expect(row(rows, 'tp').window).toEqual({ value: '295', n: null, basis: null });
    expect(row(rows, 'tn').totals?.value).toBe('226,139');
  });

  it('shows a dash, never 0 or NaN, when a rate has no denominator', () => {
    const empty: StreamWindowGroup = {
      ...windowGroup,
      tp: 0,
      fp: 0,
      fn: 0,
      tn: 150,
      n: 150,
      precision: null,
      recall: null,
      f1: null,
      baseRate: 0,
      lowSample: true,
      rocAuc: null,
    };
    const emptyRows = metricRows(empty, undefined);
    expect(row(emptyRows, 'precision').window).toEqual({ value: '—', n: 0, basis: 'flagged' });
    expect(row(emptyRows, 'recall').window?.value).toBe('—');
    expect(row(emptyRows, 'rocAuc').window?.value).toBe('—');
    expect(row(emptyRows, 'precision').totals).toBeNull();
  });
});

describe('pairGroups', () => {
  it('matches window and totals groups by model version and threshold', () => {
    const other = { ...totalsGroup, modelVersion: 'lightgbm-b', servedModel: false };
    const pairs = pairGroups([windowGroup], [totalsGroup, other]);
    expect(pairs.map((p) => [p.modelVersion, Boolean(p.window), Boolean(p.totals)])).toEqual([
      ['lightgbm-a', true, true],
      ['lightgbm-b', false, true],
    ]);
  });
});

describe('ageLabel', () => {
  it('reads seconds and minutes', () => {
    expect(ageLabel(null)).toBe('—');
    expect(ageLabel(0)).toBe('just now');
    expect(ageLabel(4)).toBe('4 s ago');
    expect(ageLabel(59.6)).toBe('59 s ago');
    expect(ageLabel(125)).toBe('2 min ago');
    expect(ageLabel(7300)).toBe('2 h ago');
  });
});

describe('heartbeatAgeSeconds', () => {
  it('ages the API-measured age by the time since that answer, free of clock skew', () => {
    // The API said 3 s old; that answer arrived 10 s ago by the browser clock.
    expect(heartbeatAgeSeconds(3, 1_000_000, 1_010_000)).toBe(13);
  });

  it('is null without a heartbeat, and never negative', () => {
    expect(heartbeatAgeSeconds(null, 0, 1000)).toBeNull();
    expect(heartbeatAgeSeconds(0, 5000, 1000)).toBe(0);
  });
});

describe('readable', () => {
  it('replaces ISO timestamps, with Z or an offset, and leaves other text alone', () => {
    const plain = 'Kafka admin request timed out after 1000 ms';
    expect(readable(plain)).toBe(plain);
    for (const iso of ['2026-10-21T21:24:04.457Z', '2026-10-21T21:24:04+00:00']) {
      const text = readable(`Consumer stopped cleanly at ${iso}`);
      expect(text.startsWith('Consumer stopped cleanly at ')).toBe(true);
      expect(text).not.toContain(iso);
      expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
    }
  });

  it('keeps a timestamp it cannot parse instead of printing Invalid Date', () => {
    expect(readable('at 2026-13-45T99:99:99Z')).toBe('at 2026-13-45T99:99:99Z');
  });
});

describe('spanOf and plural', () => {
  it('collapses a span whose ends read the same', () => {
    expect(spanOf('a', 'a')).toBe('a');
    expect(spanOf('a', 'b')).toBe('a → b');
  });

  it('pluralises counts', () => {
    expect(plural(1, 'partition')).toBe('1 partition');
    expect(plural(3, 'partition')).toBe('3 partitions');
  });
});
