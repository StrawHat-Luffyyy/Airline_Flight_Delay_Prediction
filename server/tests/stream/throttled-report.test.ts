import { describe, expect, it } from 'vitest';
import { createThrottledReport } from '../../src/stream/throttled-report.js';

describe('createThrottledReport', () => {
  const setup = () => {
    let clock = 0;
    const warnings: { count: number; batches: number }[] = [];
    const report = createThrottledReport({
      intervalMs: 10_000,
      now: () => clock,
      report: (summary) => warnings.push(summary),
    });
    return { report, warnings, tick: (ms: number) => (clock += ms) };
  };

  it('says nothing while every count is 0', () => {
    const { report, warnings } = setup();
    report(0);
    report(0);
    expect(warnings).toEqual([]);
  });

  it('reports the first batch with a count at once', () => {
    const { report, warnings } = setup();
    report(0);
    report(120);
    expect(warnings).toEqual([{ count: 120, batches: 1 }]);
  });

  it('folds further counts into one report per interval', () => {
    const { report, warnings, tick } = setup();
    report(100);
    tick(3_000);
    report(200);
    tick(3_000);
    report(300);
    expect(warnings).toHaveLength(1);
    tick(4_000);
    report(50);
    expect(warnings).toEqual([
      { count: 100, batches: 1 },
      { count: 550, batches: 3 },
    ]);
  });

  it('reports held-back counts on a clean batch once the interval has passed', () => {
    const { report, warnings, tick } = setup();
    report(100);
    tick(2_000);
    report(40);
    tick(9_000);
    report(0);
    report(0);
    expect(warnings).toEqual([
      { count: 100, batches: 1 },
      { count: 40, batches: 1 },
    ]);
  });

  it('reports what is held back when flushed, even inside the interval, and only once', () => {
    let clock = 0;
    const summaries: { count: number; batches: number }[] = [];
    const report = createThrottledReport({
      intervalMs: 10_000,
      now: () => clock,
      report: (summary) => summaries.push(summary),
    });
    report(100);
    clock += 2_000;
    report(4_900);
    report.flush();
    report.flush();
    expect(summaries).toEqual([
      { count: 100, batches: 1 },
      { count: 4_900, batches: 1 },
    ]);
  });

  it('does not carry clean batches into the count', () => {
    const { report, warnings, tick } = setup();
    report(10);
    tick(10_000);
    report(0);
    report(5);
    expect(warnings).toEqual([
      { count: 10, batches: 1 },
      { count: 5, batches: 1 },
    ]);
  });
});
