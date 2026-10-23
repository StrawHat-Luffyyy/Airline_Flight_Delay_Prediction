import {
  CANCELLATION_REASONS,
  type CancellationReasonCode,
  type CancellationRowSchema,
  type CauseRow,
  type CascadeResponse,
} from '@flight-delay/shared';
import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { z } from 'zod';
import { useCancellations, useCascade, useCauses } from '../api/hooks';
import { EmptyBlock, QueryState } from '../components/QueryState';
import {
  AXIS_TICK,
  Note,
  PageHeader,
  Section,
  Segmented,
  Swatch,
  TOOLTIP_STYLE,
  useChartMotion,
} from '../components/ui';
import { formatInteger, formatMillions, formatPercent, hourLabel } from '../lib/format';
import { CAUSE_META, CAUSE_ORDER } from '../lib/labels';

type CancellationRow = z.infer<typeof CancellationRowSchema>;
type CauseGrouping = 'month' | 'airline';
type CauseMode = 'minutes' | 'share';

interface CauseChartRow {
  axis: string;
  name: string;
  total: number;
  lateAircraft: number;
  carrier: number;
  nas: number;
  weather: number;
  security: number;
  shares: CauseRow['shares'];
}

const REASON_ORDER: readonly CancellationReasonCode[] = ['A', 'B', 'C', 'D'];
const REASON_COLORS: Record<CancellationReasonCode | 'unknown', string> = {
  A: 'var(--color-cause-carrier)',
  B: 'var(--color-cause-weather)',
  C: 'var(--color-cause-nas)',
  D: 'var(--color-cause-security)',
  unknown: 'var(--color-ink-3)',
};

function toChartRows(rows: readonly CauseRow[], by: CauseGrouping): CauseChartRow[] {
  return rows.map((row) => ({
    axis: by === 'month' ? row.label.slice(0, 3) : String(row.key),
    name: row.label,
    total: row.totalMinutes,
    lateAircraft: row.minutes.lateAircraft / 1_000_000,
    carrier: row.minutes.carrier / 1_000_000,
    nas: row.minutes.nas / 1_000_000,
    weather: row.minutes.weather / 1_000_000,
    security: row.minutes.security / 1_000_000,
    shares: row.shares,
  }));
}

function CauseLegend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-2">
      {CAUSE_ORDER.map((key) => (
        <li key={key}>
          <Swatch color={CAUSE_META[key].color} />
          {CAUSE_META[key].label}
        </li>
      ))}
    </ul>
  );
}

function CauseChart({
  rows,
  by,
  mode,
}: {
  rows: readonly CauseRow[];
  by: CauseGrouping;
  mode: CauseMode;
}) {
  const chartMotion = useChartMotion();
  const data = toChartRows(rows, by);
  const height = Math.max(280, data.length * 30 + 40);
  return (
    <div
      role="img"
      aria-label={`Stacked bars of delay minutes by cause, by ${by}, shown as ${
        mode === 'share' ? 'share of the total' : 'millions of minutes'
      }`}
      style={{ height }}
      className="w-full"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          stackOffset={mode === 'share' ? 'expand' : 'none'}
          margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
        >
          <CartesianGrid stroke="rgba(255,255,255,0.08)" horizontal={false} />
          <XAxis
            type="number"
            tick={AXIS_TICK}
            stroke="rgba(255,255,255,0.16)"
            tickLine={false}
            tickFormatter={(value: number) =>
              mode === 'share' ? formatPercent(value, 0) : `${value}M`
            }
          />
          <YAxis
            type="category"
            dataKey="axis"
            width={by === 'month' ? 44 : 36}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: 'rgba(255,255,255,0.05)' }}
            labelFormatter={(_label, payload) => {
              const first = payload[0];
              const row = first ? (first.payload as CauseChartRow | undefined) : undefined;
              return row ? `${row.name} · ${formatMillions(row.total)} min` : '';
            }}
            formatter={(value, name, item) => {
              const row = item.payload as CauseChartRow | undefined;
              const key = CAUSE_ORDER.find((k) => CAUSE_META[k].label === name);
              const share = row && key ? row.shares[key] : null;
              return [`${Number(value).toFixed(2)}M min · ${formatPercent(share)}`, name];
            }}
          />
          {CAUSE_ORDER.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              name={CAUSE_META[key].label}
              stackId="causes"
              fill={CAUSE_META[key].color}
              {...chartMotion}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CausesSection() {
  const [by, setBy] = useState<CauseGrouping>('month');
  const [mode, setMode] = useState<CauseMode>('minutes');
  const causes = useCauses(by);
  return (
    <Section
      title="Where the delay minutes come from"
      note="Cause minutes are only reported for flights that arrived 15+ minutes late, so these totals cover delayed flights only."
      actions={
        <div className="flex flex-wrap gap-3">
          <Segmented
            label="Group by"
            value={by}
            onChange={setBy}
            options={[
              { value: 'month', label: 'By month' },
              { value: 'airline', label: 'By airline' },
            ]}
          />
          <Segmented
            label="Show"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'minutes', label: 'Minutes' },
              { value: 'share', label: 'Share' },
            ]}
          />
        </div>
      }
    >
      <QueryState
        query={causes}
        label="the cause breakdown"
        skeletonClass="h-96"
        isEmpty={(data) => data.rows.length === 0}
        emptyMessage="No cause minutes are available. Run the stats build to populate them."
      >
        {(data) => (
          <div className="space-y-4">
            <CauseLegend />
            <CauseChart rows={data.rows} by={by} mode={mode} />
            {data.coverage ? <Note>{data.coverage.note}</Note> : null}
          </div>
        )}
      </QueryState>
    </Section>
  );
}

/** Hours whose cause minutes are under this share of the busiest hour are drawn hollow. */
const LOW_VOLUME_SHARE = 0.05;

function CascadeChart({ data }: { data: CascadeResponse }) {
  const chartMotion = useChartMotion();
  const peak = Math.max(...data.rows.map((row) => row.totalMinutes), 0);
  const floor = peak * LOW_VOLUME_SHARE;
  const rows = data.rows.map((row) => ({
    ...row,
    hourText: String(row.hour),
    thin: row.totalMinutes < floor,
    volume: row.totalMinutes / 1_000_000,
  }));
  return (
    <div className="space-y-3">
      <div
        role="img"
        aria-label="Late-aircraft share of delay minutes by scheduled departure hour, with total delay minutes per hour as bars"
        className="h-72 w-full"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
            <XAxis
              dataKey="hourText"
              tick={AXIS_TICK}
              stroke="rgba(255,255,255,0.16)"
              tickLine={false}
              interval={1}
            />
            <YAxis
              yAxisId="share"
              domain={[0, 1]}
              tickFormatter={(value: number) => formatPercent(value, 0)}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <YAxis yAxisId="volume" orientation="right" hide />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ stroke: 'rgba(255,255,255,0.3)' }}
              labelFormatter={(label) => `Departing ${hourLabel(Number(label))}`}
              formatter={(value, name) =>
                name === 'Delay minutes'
                  ? [`${Number(value).toFixed(2)}M min`, name]
                  : [formatPercent(Number(value)), name]
              }
            />
            <Bar
              yAxisId="volume"
              dataKey="volume"
              name="Delay minutes"
              fill="rgba(255,255,255,0.1)"
              {...chartMotion}
            />
            <Line
              yAxisId="share"
              type="monotone"
              dataKey="lateAircraftShare"
              name="Late-aircraft share"
              stroke="var(--color-cause-late)"
              strokeWidth={2}
              {...chartMotion}
              dot={(props: { cx?: number; cy?: number; index?: number }) => {
                const { cx, cy, index } = props;
                const row = index === undefined ? undefined : rows[index];
                if (cx === undefined || cy === undefined || !row) return <g key={index} />;
                return (
                  <circle
                    key={row.hour}
                    cx={cx}
                    cy={cy}
                    r={3.5}
                    fill={row.thin ? '#010101' : '#e8a54b'}
                    stroke={row.thin ? '#94938f' : '#e8a54b'}
                    strokeWidth={1.5}
                  />
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Note>
        Line: late-arriving aircraft as a share of delay minutes, by scheduled departure hour. Grey
        bars: total delay minutes in that hour. Hollow points mark hours with under{' '}
        {formatPercent(LOW_VOLUME_SHARE, 0)} of the busiest hour&apos;s minutes (
        {formatInteger(floor)} min), where the share rests on few flights.
      </Note>
      {data.coverage ? <Note>{data.coverage.note}</Note> : null}
    </div>
  );
}

function CancellationBars({ row }: { row: CancellationRow }) {
  const entries = [
    ...REASON_ORDER.map((code) => ({
      code,
      label: CANCELLATION_REASONS[code],
      count: row.reasons[code],
    })),
    ...(row.reasons.unknown > 0
      ? [{ code: 'unknown' as const, label: 'No reason recorded', count: row.reasons.unknown }]
      : []),
  ];
  const max = Math.max(...entries.map((entry) => entry.count), 1);
  return (
    <ul className="space-y-3">
      {entries.map((entry) => (
        <li key={entry.code}>
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span>
              <Swatch color={REASON_COLORS[entry.code]} />
              {entry.label}
            </span>
            <span className="num text-ink">
              {formatInteger(entry.count)}{' '}
              <span className="text-ink-3">
                ({formatPercent(row.total > 0 ? entry.count / row.total : null)})
              </span>
            </span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-wash">
            <div
              className="h-2 rounded-full"
              style={{
                width: `${(entry.count / max) * 100}%`,
                background: REASON_COLORS[entry.code],
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function CancellationsByMonth({ rows }: { rows: readonly CancellationRow[] }) {
  const chartMotion = useChartMotion();
  const data = rows.map((row) => ({
    axis: row.label.slice(0, 3),
    name: row.label,
    total: row.total,
    ...row.reasons,
  }));
  const hasUnknown = rows.some((row) => row.reasons.unknown > 0);
  return (
    <div
      role="img"
      aria-label="Stacked columns of cancelled flights per month, split by reason"
      className="h-72 w-full"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
          <XAxis
            dataKey="axis"
            tick={AXIS_TICK}
            stroke="rgba(255,255,255,0.16)"
            tickLine={false}
            interval={0}
          />
          <YAxis
            tickFormatter={(value: number) => formatInteger(value)}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={52}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: 'rgba(255,255,255,0.05)' }}
            labelFormatter={(_label, payload) => {
              const first = payload[0];
              const row = first
                ? (first.payload as { name: string; total: number } | undefined)
                : undefined;
              return row ? `${row.name} · ${formatInteger(row.total)} cancelled` : '';
            }}
            formatter={(value, name) => [formatInteger(Number(value)), name]}
          />
          {REASON_ORDER.map((code) => (
            <Bar
              key={code}
              dataKey={code}
              name={CANCELLATION_REASONS[code]}
              stackId="reasons"
              fill={REASON_COLORS[code]}
              {...chartMotion}
            />
          ))}
          {hasUnknown ? (
            <Bar
              dataKey="unknown"
              name="No reason recorded"
              stackId="reasons"
              fill={REASON_COLORS.unknown}
              {...chartMotion}
            />
          ) : null}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CancellationsSection() {
  const overall = useCancellations('overall');
  const byMonth = useCancellations('month');
  return (
    <Section
      title="Why flights were cancelled"
      note="Cancellations are recorded with one BTS reason code each."
    >
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          <h3 className="mb-3 text-sm text-ink-2">All 2015</h3>
          <QueryState
            query={overall}
            label="cancellation reasons"
            skeletonClass="h-48"
            isEmpty={(data) => data.rows.length === 0}
          >
            {(data) => {
              const row = data.rows[0];
              return row ? (
                <CancellationBars row={row} />
              ) : (
                <EmptyBlock message="No cancellations." />
              );
            }}
          </QueryState>
        </div>
        <div>
          <h3 className="mb-3 text-sm text-ink-2">By month</h3>
          <QueryState
            query={byMonth}
            label="cancellations by month"
            skeletonClass="h-72"
            isEmpty={(data) => data.rows.length === 0}
          >
            {(data) => <CancellationsByMonth rows={data.rows} />}
          </QueryState>
        </div>
      </div>
    </Section>
  );
}

export default function Causes() {
  const cascade = useCascade();
  return (
    <div className="space-y-10">
      <PageHeader title="What causes delays">
        BTS attributes each delayed flight&apos;s minutes to five causes. Late-arriving aircraft is
        the knock-on effect of an earlier delay, so it grows through the day.
      </PageHeader>

      <CausesSection />

      <Section
        title="The cascade through the day"
        note="How much of the delay is inherited from a previous flight, by scheduled departure hour."
      >
        <QueryState
          query={cascade}
          label="the cascade"
          skeletonClass="h-72"
          isEmpty={(data) => data.rows.length === 0}
        >
          {(data) => <CascadeChart data={data} />}
        </QueryState>
      </Section>

      <CancellationsSection />
    </div>
  );
}
