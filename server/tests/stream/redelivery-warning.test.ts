import { describe, expect, it } from 'vitest';
import { createRedeliveryWarning } from '../../src/stream/redelivery-warning.js';

describe('createRedeliveryWarning', () => {
  const setup = () => {
    let clock = 0;
    const warnings: { redelivered: number; batches: number }[] = [];
    const report = createRedeliveryWarning({
      intervalMs: 10_000,
      now: () => clock,
      warn: (summary) => warnings.push(summary),
    });
    return { report, warnings, tick: (ms: number) => (clock += ms) };
  };

  it('says nothing while no stored flight is delivered again', () => {
    const { report, warnings } = setup();
    report(0);
    report(0);
    expect(warnings).toEqual([]);
  });

  it('warns on the first redelivered batch at once', () => {
    const { report, warnings } = setup();
    report(0);
    report(120);
    expect(warnings).toEqual([{ redelivered: 120, batches: 1 }]);
  });

  it('folds further redeliveries into one warning per interval', () => {
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
      { redelivered: 100, batches: 1 },
      { redelivered: 550, batches: 3 },
    ]);
  });

  it('reports held-back redeliveries on a clean batch once the interval has passed', () => {
    const { report, warnings, tick } = setup();
    report(100);
    tick(2_000);
    report(40);
    tick(9_000);
    report(0);
    report(0);
    expect(warnings).toEqual([
      { redelivered: 100, batches: 1 },
      { redelivered: 40, batches: 1 },
    ]);
  });

  it('does not carry clean batches into the count', () => {
    const { report, warnings, tick } = setup();
    report(10);
    tick(10_000);
    report(0);
    report(5);
    expect(warnings).toEqual([
      { redelivered: 10, batches: 1 },
      { redelivered: 5, batches: 1 },
    ]);
  });
});
