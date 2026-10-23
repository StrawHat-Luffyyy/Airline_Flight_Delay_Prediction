import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatPercent } from '../lib/format';

export interface BoardColumn<T> {
  id: string;
  header: ReactNode;
  align?: 'left' | 'right';
  /** Render the cell for a row; `rank` is 1-based. */
  cell: (row: T, rank: number) => ReactNode;
  /** Extra classes for the th and td, e.g. a width. */
  className?: string;
  /** Use this column as the row header (`<th scope="row">`). */
  rowHeader?: boolean;
}

interface BoardProps<T> {
  rows: readonly T[];
  getKey: (row: T) => string;
  columns: readonly BoardColumn<T>[];
  /** Accessible name of the table. */
  caption: string;
  /** Show the rank column (default true). */
  showRank?: boolean;
  /** Highlight the row at this key as the chosen one. */
  selectedKey?: string;
  /** Glide rows to new ranks and light changed rows (default true). Off for paged lists. */
  animate?: boolean;
}

const LAMP_MS = 1200;

/**
 * The departure board: a real table in fixed tabular columns. When rows are re-sorted or
 * refiltered they glide to their new rank (keyed by row key) and rows whose rank changed hold an
 * amber lamp for a moment. Nothing moves under prefers-reduced-motion.
 */
export function Board<T>({
  rows,
  getKey,
  columns,
  caption,
  showRank = true,
  selectedKey,
  animate = true,
}: BoardProps<T>) {
  const reduced = useReducedMotion() === true || !animate;
  const previousRanks = useRef<Map<string, number>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [lit, setLit] = useState<ReadonlySet<string>>(new Set());

  const signature = JSON.stringify(rows.map(getKey));

  useEffect(() => {
    const next = new Map<string, number>();
    (JSON.parse(signature) as string[]).forEach((key, index) => next.set(key, index));
    const previous = previousRanks.current;
    previousRanks.current = next;
    if (reduced || previous.size === 0) return;
    const changed = new Set<string>();
    next.forEach((rank, key) => {
      if (previous.get(key) !== rank) changed.add(key);
    });
    if (changed.size === 0) return;
    setLit(changed);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLit(new Set()), LAMP_MS);
  }, [signature, reduced]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full border-collapse text-left font-mono text-[13px] tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-rule-strong">
            {showRank ? (
              <th
                scope="col"
                className="w-10 py-2 pr-3 text-left font-sans text-[11px] font-normal tracking-wide text-ink-3"
              >
                <span aria-hidden="true">#</span>
                <span className="sr-only">Rank</span>
              </th>
            ) : null}
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={`whitespace-nowrap px-2 py-2 font-sans text-[11px] font-normal tracking-wide text-ink-3 first:pl-0 last:pr-0 ${
                  column.align === 'right' ? 'text-right' : 'text-left'
                } ${column.className ?? ''}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = getKey(row);
            const rank = index + 1;
            const rowClass = `h-9 border-b border-rule transition-colors duration-150 hover:bg-wash ${
              lit.has(key) ? 'lamp' : ''
            } ${selectedKey === key ? 'bg-wash' : ''}`;
            const content = (
              <>
                {showRank ? (
                  <td className="w-10 py-1 pr-3 text-ink-3">{String(rank).padStart(2, '0')}</td>
                ) : null}
                {columns.map((column) => {
                  const className = `px-2 py-1 first:pl-0 last:pr-0 ${
                    column.align === 'right' ? 'text-right' : 'text-left'
                  } ${column.className ?? ''}`;
                  return column.rowHeader ? (
                    <th key={column.id} scope="row" className={`${className} font-normal text-ink`}>
                      {column.cell(row, rank)}
                    </th>
                  ) : (
                    <td key={column.id} className={className}>
                      {column.cell(row, rank)}
                    </td>
                  );
                })}
              </>
            );
            return reduced ? (
              <tr key={key} className={rowClass}>
                {content}
              </tr>
            ) : (
              <motion.tr
                key={key}
                layout="position"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  layout: { duration: 0.55, ease: [0.16, 1, 0.3, 1] },
                  opacity: { duration: 0.3 },
                }}
                className={rowClass}
              >
                {content}
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The delay-rate cell (amber) or any other share (ink): an inline bar scaled to `max`, then the value. */
export function RateCell({
  value,
  max,
  digits = 1,
  tone = 'amber',
  barOnMobile = false,
}: {
  value: number | null;
  max: number;
  digits?: number;
  /** amber = a delay rate (default); ink = any other share. */
  tone?: 'amber' | 'ink';
  /** Keep the bar below `sm` (when the bar is the chart, e.g. feature importance). */
  barOnMobile?: boolean;
}) {
  const width = value !== null && max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  return (
    <span className="flex items-center justify-end gap-3">
      <span
        className={`h-1.5 flex-1 rounded-full bg-wash sm:block ${
          barOnMobile ? 'block min-w-28 sm:min-w-10' : 'hidden min-w-10'
        }`}
        aria-hidden="true"
      >
        <span
          className={`block h-1.5 rounded-full transition-[width] duration-500 ${
            tone === 'amber' ? 'bg-delayed' : 'bg-ink-2'
          }`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className={`w-12 text-right sm:w-14 ${tone === 'amber' ? 'text-delayed' : 'text-ink'}`}>
        {formatPercent(value, digits)}
      </span>
    </span>
  );
}
