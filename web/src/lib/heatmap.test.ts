import { describe, expect, it } from 'vitest';
import { divergingCells, MIN_HEATMAP_FLIGHTS } from './heatmap';

const cell = (dow: number, hour: number, delayRate: number | null, completed = 1000) => ({
  dow,
  hour,
  delayRate,
  completed,
});

describe('divergingCells', () => {
  it('centres on the overall rate: above is "above" with ▲, below is "below" with ▼', () => {
    const scale = divergingCells([cell(1, 8, 0.3), cell(1, 9, 0.1), cell(1, 10, 0.2)], 0.2);
    expect(scale.cells.get('1-8')).toMatchObject({ kind: 'above', marker: '▲' });
    expect(scale.cells.get('1-9')).toMatchObject({ kind: 'below', marker: '▼' });
    expect(scale.cells.get('1-10')).toMatchObject({ kind: 'at', marker: '' });
    expect(scale.overall).toBe(0.2);
  });

  it('clamps at the p95 absolute deviation, so one outlier does not wash out the rest', () => {
    // 20 cells at +/-0.01..0.19 around 0.5 and one outlier at +0.45.
    const cells = [
      ...Array.from({ length: 20 }, (_, i) => cell(1, i, 0.5 + (i % 2 ? 1 : -1) * (i + 1) * 0.01)),
      cell(2, 0, 0.95),
    ];
    const scale = divergingCells(cells, 0.5);
    expect(scale.clamp).toBeCloseTo(0.2, 10);
    expect(scale.cells.get('2-0')?.intensity).toBe(1);
    expect(scale.cells.get('1-0')?.intensity).toBeCloseTo(-0.05, 10);
  });

  it('shows cells below the minimum flight count as low-sample, without a direction', () => {
    const scale = divergingCells([cell(3, 3, 0.9, MIN_HEATMAP_FLIGHTS - 1), cell(3, 4, 0.2)], 0.2);
    expect(scale.cells.get('3-3')).toMatchObject({ kind: 'low', marker: '', intensity: 0 });
  });

  it('shows cells without a rate as no data', () => {
    const scale = divergingCells([cell(4, 4, null, 0)], 0.2);
    expect(scale.cells.get('4-4')).toMatchObject({ kind: 'none', marker: '' });
  });

  it('never divides by zero when every eligible cell sits on the overall rate', () => {
    const scale = divergingCells([cell(1, 1, 0.2), cell(1, 2, 0.2)], 0.2);
    expect(scale.cells.get('1-1')?.intensity).toBe(0);
  });
});
