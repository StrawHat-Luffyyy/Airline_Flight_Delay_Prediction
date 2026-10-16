import type { SummaryResponse } from '@flight-delay/shared';
import { useId } from 'react';
import { useSummary } from '../../api/hooks';
import { formatInteger, formatPercent, formatSignedMinutes } from '../../lib/format';
import { FEEDBACK_S, HERO } from '../../lib/motion';
import { ErrorBlock, Skeleton } from '../QueryState';
import { CountUp, useEntrance } from './entrance';

// Stable formatters (CountUp restarts if `format` changes identity).
const fmtRate = (value: number): string => formatPercent(value);
const fmtCancel = (value: number): string => formatPercent(value, 2);
const fmtMinutes = (value: number): string => formatSignedMinutes(value);

interface Stat {
  label: string;
  value: number;
  format: (value: number) => string;
  tone: string;
  /** Plain-language definition, worded from the backend formula (stats_daily DERIVED_RATES). */
  caption: string;
}

/**
 * Definitions match server/src/stats/builders.ts DERIVED_RATES:
 * delayRate = delayed / completed, cancelRate = cancelled / flights,
 * avgArrDelay = sum of arrival delays / completed (completed = not cancelled or diverted).
 */
function statsOf(summary: SummaryResponse): Stat[] {
  const stats: Stat[] = [];
  if (summary.delayRate !== null) {
    stats.push({
      label: 'Delay rate',
      value: summary.delayRate,
      format: fmtRate,
      tone: 'text-delayed',
      caption: `Share of completed flights (not cancelled or diverted) that arrived 15+ min late: ${formatInteger(summary.delayed)} of ${formatInteger(summary.completed)}.`,
    });
  }
  if (summary.cancelRate !== null) {
    stats.push({
      label: 'Cancel rate',
      value: summary.cancelRate,
      format: fmtCancel,
      tone: 'text-ink',
      caption: `Share of all scheduled flights that were cancelled: ${formatInteger(summary.cancelled)} of ${formatInteger(summary.flights)}.`,
    });
  }
  if (summary.avgArrDelay !== null) {
    stats.push({
      label: 'Avg arrival delay',
      value: summary.avgArrDelay,
      format: fmtMinutes,
      tone: 'text-ink',
      caption: 'Mean arrival delay of completed flights. Early arrivals count as negative minutes.',
    });
  }
  return stats;
}

function StatCell({
  stat,
  index,
  count,
  reduced,
}: {
  stat: Stat;
  index: number;
  count: number;
  reduced: boolean;
}) {
  const captionId = useId();
  const at = HERO.statsAt + index * HERO.statStagger;
  const [cellRef, cellEnter] = useEntrance<HTMLDivElement>(
    'hero-rise',
    at,
    HERO.statDuration,
    reduced,
  );
  const last = index === count - 1;

  return (
    <div
      ref={cellRef}
      tabIndex={0}
      aria-describedby={captionId}
      className={`group relative py-3 outline-none ${cellEnter} ${index > 0 ? 'border-l border-white/10 pl-3 sm:pl-4' : ''}`}
    >
      {/* Soft highlight: opacity only. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-white/[0.04] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        style={{ transitionDuration: `${FEEDBACK_S * 1000}ms` }}
      />
      <dt className="relative text-[11px] text-ink-2 sm:text-xs">{stat.label}</dt>
      <dd
        className={`display-num relative mt-1 text-[clamp(1.35rem,4vw,2.25rem)] leading-none ${stat.tone}`}
      >
        <CountUp
          value={stat.value}
          format={stat.format}
          at={at}
          duration={HERO.statCountDuration}
          reduced={reduced}
        />
      </dd>
      <span
        id={captionId}
        role="tooltip"
        className={`pointer-events-none absolute top-full z-10 mt-2 w-max max-w-[min(26ch,80vw)] -translate-y-1 rounded-md border border-white/12 bg-ground/90 px-3 py-2 text-[12px] leading-snug text-ink-2 opacity-0 transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 ${last ? 'right-0' : 'left-0'}`}
      >
        {stat.caption}
      </span>
    </div>
  );
}

/** Hairlines draw left to right, then each stat rises and counts up, in stagger. */
function StatRow({ stats, reduced }: { stats: Stat[]; reduced: boolean }) {
  const [topRef, topEnter] = useEntrance<HTMLSpanElement>(
    'hero-draw',
    HERO.hairlinesAt,
    HERO.hairlineDuration,
    reduced,
  );
  const [bottomRef, bottomEnter] = useEntrance<HTMLSpanElement>(
    'hero-draw',
    HERO.hairlinesAt + 0.08,
    HERO.hairlineDuration,
    reduced,
  );
  return (
    <dl className="relative grid grid-cols-3">
      <span
        ref={topRef}
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-px origin-left bg-white/15 ${topEnter}`}
      />
      {stats.map((stat, index) => (
        <StatCell
          key={stat.label}
          stat={stat}
          index={index}
          count={stats.length}
          reduced={reduced}
        />
      ))}
      <span
        ref={bottomRef}
        aria-hidden="true"
        className={`absolute inset-x-0 bottom-0 h-px origin-left bg-white/15 ${bottomEnter}`}
      />
    </dl>
  );
}

export function HeroStats({ reduced }: { reduced: boolean }) {
  const summary = useSummary();
  if (summary.isError) {
    return (
      <ErrorBlock
        error={summary.error}
        label="the headline figures"
        onRetry={() => void summary.refetch()}
      />
    );
  }
  if (!summary.data) {
    return (
      <div role="status" className="grid grid-cols-3 gap-4 border-y border-white/10 py-3">
        <span className="sr-only">Loading headline figures</span>
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }
  return <StatRow stats={statsOf(summary.data)} reduced={reduced} />;
}
