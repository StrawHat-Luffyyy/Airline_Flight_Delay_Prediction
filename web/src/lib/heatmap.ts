/**
 * The hour-by-weekday heatmap as a diverging scale around the overall delay rate (from
 * /api/analytics/summary), not a hardcoded midpoint. The scale is clamped at the p95 absolute
 * deviation so one extreme cell does not wash out the rest, cells with too few flights are shown
 * as low-sample (hatched, no direction), and every cell carries a ▲ / ▼ marker so the direction
 * never depends on hue alone.
 */

/** Below this many completed flights a cell's rate is too noisy to colour. */
export const MIN_HEATMAP_FLIGHTS = 300;

/** Deviations smaller than this (absolute) read as "at" the overall rate. */
const AT_OVERALL = 0.005;

export interface HeatmapInputCell {
  dow: number;
  hour: number;
  delayRate: number | null;
  completed: number;
}

export interface ScaledCell {
  kind: 'above' | 'below' | 'at' | 'low' | 'none';
  /** -1 (clamp below the overall rate) .. 1 (clamp above); 0 for at, low and none. */
  intensity: number;
  /** ▲ above, ▼ below, empty otherwise. */
  marker: '▲' | '▼' | '';
}

export interface DivergingScale {
  overall: number;
  /** The p95 absolute deviation from the overall rate: where the colour saturates. */
  clamp: number;
  cells: Map<string, ScaledCell>;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

export function divergingCells(
  cells: readonly HeatmapInputCell[],
  overall: number,
): DivergingScale {
  const eligible = cells.filter(
    (cell) => cell.delayRate !== null && cell.completed >= MIN_HEATMAP_FLIGHTS,
  );
  const clamp = percentile95(eligible.map((cell) => Math.abs(cell.delayRate! - overall)));
  const scaled = new Map<string, ScaledCell>();
  for (const cell of cells) {
    const key = `${cell.dow}-${cell.hour}`;
    if (cell.delayRate === null) {
      scaled.set(key, { kind: 'none', intensity: 0, marker: '' });
    } else if (cell.completed < MIN_HEATMAP_FLIGHTS) {
      scaled.set(key, { kind: 'low', intensity: 0, marker: '' });
    } else {
      const deviation = cell.delayRate - overall;
      if (Math.abs(deviation) < AT_OVERALL || clamp === 0) {
        scaled.set(key, { kind: 'at', intensity: 0, marker: '' });
      } else {
        const intensity = Math.max(-1, Math.min(1, deviation / clamp));
        scaled.set(key, {
          kind: deviation > 0 ? 'above' : 'below',
          intensity,
          marker: deviation > 0 ? '▲' : '▼',
        });
      }
    }
  }
  return { overall, clamp, cells: scaled };
}

/** Cell fill: a tint of rose (above) or cerulean (below) over the surface, by |intensity|. */
export function cellFill(cell: ScaledCell): string | undefined {
  if (cell.kind === 'above' || cell.kind === 'below') {
    const hue = cell.kind === 'above' ? 'var(--negative)' : 'var(--positive)';
    const share = Math.round(15 + 70 * Math.abs(cell.intensity));
    return `color-mix(in srgb, ${hue} ${share}%, var(--surface))`;
  }
  if (cell.kind === 'at') return 'var(--surface)';
  return undefined;
}

/** Marker colour: dark on strong fills, light on faint ones (contrast checked in DESIGN.md). */
export function markerColour(cell: ScaledCell): string {
  return Math.abs(cell.intensity) > 0.5 ? 'var(--bg)' : 'var(--text)';
}
