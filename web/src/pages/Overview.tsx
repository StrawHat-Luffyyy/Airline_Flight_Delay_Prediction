import type { CauseRow, DelayRateRow, SummaryResponse, TrendPoint } from '@flight-delay/shared';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useCauses, useDelayDistribution, useDelayRate, useSummary, useTrend } from '../api/hooks';
import { Board, RateCell, type BoardColumn } from '../components/Board';
import { QueryState } from '../components/QueryState';
import { AXIS_TICK, Note, PageHeader, Section, Swatch, TOOLTIP_STYLE } from '../components/ui';
import { formatInteger, formatPercent, formatSignedMinutes, monthName } from '../lib/format';
import { CAUSE_META, CAUSE_ORDER } from '../lib/labels';

/** Airlines with fewer flights than this are left out of the worst-airlines ranking. */
const MIN_FLIGHTS = 500;

/** Model split (PROJECT_OVERVIEW section 7): train Jan-Sep, test Oct-Dec. */
const TEST_FIRST_MONTH = 10;

function splitOf(period: string): 'train' | 'test' {
  return Number(period.slice(5, 7)) >= TEST_FIRST_MONTH ? 'test' : 'train';
}

function Kpis({ summary }: { summary: SummaryResponse }) {
  const items = [
    {
      label: 'Flights',
      value: formatInteger(summary.flights),
      sub: `${formatInteger(summary.completed)} completed`,
      tone: '',
    },
    {
      label: 'Delay rate',
      value: formatPercent(summary.delayRate),
      sub: `${formatInteger(summary.delayed)} arrived 15+ min late`,
      tone: 'text-delayed',
    },
    {
      label: 'Avg arrival delay',
      value: formatSignedMinutes(summary.avgArrDelay),
      sub: 'completed flights',
      tone: '',
    },
    {
      label: 'Cancel rate',
      value: formatPercent(summary.cancelRate, 2),
      sub: `${formatInteger(summary.cancelled)} cancelled · ${formatInteger(summary.diverted)} diverted`,
      tone: '',
    },
  ];
  return (
    <dl className="grid grid-cols-2 border-y border-rule-strong lg:grid-cols-4">
      {items.map((item, index) => (
        <div
          key={item.label}
          className={`py-4 ${index % 2 === 1 ? 'pl-5' : ''} ${index >= 1 ? 'lg:pl-5' : ''} ${
            index > 0 ? 'lg:border-l lg:border-rule' : ''
          } ${index === 1 || index === 3 ? 'border-l border-rule' : ''} ${
            index >= 2 ? 'border-t border-rule lg:border-t-0' : ''
          }`}
        >
          <dt className="text-xs text-ink-2">{item.label}</dt>
          <dd
            className={`display-num mt-1.5 text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1] ${item.tone}`}
          >
            {item.value}
          </dd>
          <dd className="num mt-1 text-[11px] text-ink-3">{item.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

function TrendChart({ points }: { points: readonly TrendPoint[] }) {
  const rates = points.map((p) => p.delayRate ?? 0);
  const maxRate = Math.max(...rates, 0);
  const lastIndex = points.length - 1;
  const firstTestIndex = points.findIndex((p) => splitOf(p.period) === 'test');
  const lastTrainIndex = firstTestIndex === -1 ? lastIndex : firstTestIndex - 1;
  const firstTest = firstTestIndex === -1 ? undefined : points[firstTestIndex];
  const lastTrain = points[lastTrainIndex];
  const last = points[lastIndex];
  const first = points[0];
  const span = Math.max(lastIndex, 1);
  return (
    <figure>
      {/* Split labels sit in a band above the plot, aligned to the plot area (axis 44px, right margin 12px). */}
      <div
        className="relative mb-1 h-6"
        style={{ marginLeft: 44, marginRight: 12 }}
        aria-hidden="true"
      >
        <span
          className="absolute inset-y-0 border-t border-rule-strong pt-1 pl-1 text-[11px] text-ink-3"
          style={{ left: 0, width: `${(lastTrainIndex / span) * 100}%` }}
        >
          train
        </span>
        {firstTestIndex !== -1 ? (
          <span
            className="absolute inset-y-0 right-0 border-t border-ink-3 pt-1 pl-1 text-[11px] text-ink-2"
            style={{ left: `${(firstTestIndex / span) * 100}%` }}
          >
            test
          </span>
        ) : null}
      </div>
      <div
        role="img"
        aria-label="Line chart of the monthly delay rate in 2015, split into train months (Jan-Sep) and test months (Oct-Dec). The same values are in the table below."
        className="h-64 w-full"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={[...points]} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
            {first && lastTrain ? (
              <ReferenceArea
                x1={first.period}
                x2={lastTrain.period}
                fill="rgba(255,255,255,0.02)"
                stroke="none"
              />
            ) : null}
            {firstTest && last ? (
              <ReferenceArea
                x1={firstTest.period}
                x2={last.period}
                fill="rgba(255,255,255,0.06)"
                stroke="none"
              />
            ) : null}
            <XAxis
              dataKey="period"
              tickFormatter={(value: string) => monthName(value, true)}
              tick={AXIS_TICK}
              stroke="rgba(255,255,255,0.16)"
              tickLine={false}
            />
            <YAxis
              tickFormatter={(value: number) => formatPercent(value, 0)}
              domain={[0, Math.ceil(maxRate * 20) / 20]}
              tickCount={Math.ceil(maxRate * 20) + 1}
              tick={AXIS_TICK}
              stroke="transparent"
              tickLine={false}
              width={44}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ stroke: 'rgba(255,255,255,0.3)' }}
              labelFormatter={(label) => monthName(String(label))}
              formatter={(value) => [formatPercent(Number(value)), 'Delay rate']}
            />
            <Line
              type="monotone"
              dataKey="delayRate"
              stroke="var(--color-delayed)"
              strokeWidth={2}
              dot={{ r: 3, fill: '#010101', stroke: '#e8a54b', strokeWidth: 2 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function monthColumns(maxRate: number): BoardColumn<TrendPoint>[] {
  return [
    {
      id: 'month',
      header: 'Month',
      rowHeader: true,
      cell: (row) => monthName(row.period),
      className: 'sm:w-28',
    },
    {
      id: 'split',
      header: 'Split',
      cell: (row) => <span className="text-ink-2">{splitOf(row.period)}</span>,
      className: 'hidden w-16 sm:table-cell',
    },
    {
      id: 'flights',
      header: 'Flights',
      align: 'right',
      cell: (row) => formatInteger(row.flights),
    },
    {
      id: 'rate',
      header: 'Delay rate',
      align: 'right',
      cell: (row) => <RateCell value={row.delayRate} max={maxRate} />,
      className: 'sm:min-w-48',
    },
    {
      id: 'cancel',
      header: 'Cancel',
      align: 'right',
      cell: (row) => formatPercent(row.cancelRate, 2),
    },
    {
      id: 'arr',
      header: 'Avg arr delay',
      align: 'right',
      cell: (row) => formatSignedMinutes(row.avgArrDelay),
      className: 'hidden sm:table-cell',
    },
  ];
}

const AIRLINE_COLUMNS: BoardColumn<DelayRateRow>[] = [
  {
    id: 'code',
    header: 'Code',
    cell: (row) => <span className="text-ink-2">{String(row.key)}</span>,
    className: 'w-10',
  },
  {
    id: 'airline',
    header: 'Airline',
    rowHeader: true,
    cell: (row) => (
      <span className="block max-w-[9.5rem] truncate font-sans sm:max-w-none" title={row.label}>
        {row.label}
      </span>
    ),
  },
  {
    id: 'rate',
    header: 'Delay rate',
    align: 'right',
    cell: (row) => <span className="text-delayed">{formatPercent(row.delayRate)}</span>,
  },
];

function CauseShare({ row }: { row: CauseRow }) {
  const parts = CAUSE_ORDER.map((key) => ({
    key,
    share: row.shares[key] ?? 0,
    ...CAUSE_META[key],
  }));
  return (
    <div>
      <div
        role="img"
        aria-label={`Share of delay minutes by cause: ${parts
          .map((p) => `${p.label} ${formatPercent(p.share)}`)
          .join(', ')}`}
        className="flex h-2.5 overflow-hidden rounded-full"
      >
        {parts.map((part) => (
          <span key={part.key} style={{ width: `${part.share * 100}%`, background: part.color }} />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 text-[12px] text-ink-2 sm:grid-cols-2">
        {parts.map((part) => (
          <li key={part.key} className="flex items-baseline justify-between gap-2">
            <span>
              <Swatch color={part.color} />
              {part.label}
            </span>
            <span className="num text-ink">{formatPercent(part.share)}</span>
          </li>
        ))}
      </ul>
      <p className="num mt-3 text-[11px] text-ink-3">
        {formatInteger(row.totalMinutes)} delay minutes in total
      </p>
    </div>
  );
}

function leadingCauseTitle(row: CauseRow): string {
  let top: (typeof CAUSE_ORDER)[number] | undefined;
  for (const key of CAUSE_ORDER) {
    const share = row.shares[key];
    if (share !== null && (top === undefined || share > (row.shares[top] ?? 0))) top = key;
  }
  return top ? `${CAUSE_META[top].label} leads` : 'Delay minutes by cause';
}

function CauseShareSection() {
  const causes = useCauses('overall');
  const row = causes.data?.rows[0];
  return (
    <Section
      title={row ? leadingCauseTitle(row) : 'Delay minutes by cause'}
      note="Share of delay minutes by cause. Causes are only reported for flights that arrived 15+ minutes late."
    >
      <QueryState
        query={causes}
        label="the cause breakdown"
        skeletonClass="h-32"
        isEmpty={(data) => data.rows.length === 0}
      >
        {(data) => {
          const first = data.rows[0];
          return first ? <CauseShare row={first} /> : null;
        }}
      </QueryState>
    </Section>
  );
}

export default function Overview() {
  const summary = useSummary();
  const trend = useTrend('month');
  const airlines = useDelayRate({
    by: 'airline',
    minFlights: MIN_FLIGHTS,
    limit: 5,
    order: 'worst',
  });
  const distribution = useDelayDistribution();

  return (
    <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 space-y-8">
        <div>
          <PageHeader title="US domestic flights, 2015">
            A flight counts as delayed when it arrives 15 or more minutes late (US DOT definition).
            Cancelled and diverted flights have no arrival outcome and are left out of delay rates.
          </PageHeader>
          <QueryState query={summary} label="the summary" skeletonClass="h-28">
            {(data) => <Kpis summary={data} />}
          </QueryState>
        </div>

        <Section
          title="Delay rate by month"
          note="Jan-Sep is the model's training period, Oct-Dec its test period (time-based split)."
        >
          <QueryState
            query={trend}
            label="the monthly trend"
            skeletonClass="h-[26rem]"
            isEmpty={(data) => data.points.length === 0}
            emptyMessage="No monthly statistics yet. Run the stats build to populate them."
          >
            {(data) => {
              const maxRate = Math.max(...data.points.map((p) => p.delayRate ?? 0), 0);
              return (
                <div className="space-y-6">
                  <TrendChart points={data.points} />
                  <Board
                    rows={data.points}
                    getKey={(row) => row.period}
                    columns={monthColumns(maxRate)}
                    caption="Monthly flights, delay rate, cancel rate and average arrival delay"
                    showRank={false}
                  />
                </div>
              );
            }}
          </QueryState>
        </Section>
      </div>

      <aside className="min-w-0 space-y-8">
        <Section
          title="Worst airlines"
          note={`Highest delay rate, airlines with at least ${formatInteger(MIN_FLIGHTS)} flights.`}
        >
          <QueryState
            query={airlines}
            label="the airline ranking"
            skeletonClass="h-48"
            isEmpty={(data) => data.rows.length === 0}
            emptyMessage={`No airlines meet the ${formatInteger(MIN_FLIGHTS)}-flight minimum.`}
          >
            {(data) => (
              <Board
                rows={data.rows}
                getKey={(row) => String(row.key)}
                columns={AIRLINE_COLUMNS}
                caption="Five airlines with the highest delay rate"
              />
            )}
          </QueryState>
        </Section>

        <CauseShareSection />

        <Section
          title="How late flights arrive"
          note="Share of completed flights by arrival delay."
        >
          <QueryState
            query={distribution}
            label="the delay distribution"
            skeletonClass="h-72"
            isEmpty={(data) => data.buckets.length === 0}
          >
            {(data) => {
              const rows = data.buckets.map((bucket) => ({
                label: bucket.label,
                flights: bucket.flights,
                share: data.completed > 0 ? bucket.flights / data.completed : 0,
                late: bucket.from >= 15,
              }));
              return (
                <div
                  role="img"
                  aria-label="Bar chart of completed flights by arrival delay bucket"
                  className="h-72 w-full"
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={rows}
                      layout="vertical"
                      margin={{ top: 0, right: 44, bottom: 0, left: 0 }}
                    >
                      <XAxis type="number" hide domain={[0, 'dataMax']} />
                      <YAxis
                        type="category"
                        dataKey="label"
                        width={150}
                        tick={AXIS_TICK}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                        formatter={(value) => [`${formatInteger(Number(value))} flights`, '']}
                        separator=""
                      />
                      <Bar dataKey="flights" radius={2} isAnimationActive={false}>
                        {rows.map((row) => (
                          <Cell
                            key={row.label}
                            fill={row.late ? 'var(--color-delayed)' : 'var(--color-ontime)'}
                          />
                        ))}
                        <LabelList
                          dataKey="share"
                          position="right"
                          formatter={(value) => formatPercent(Number(value))}
                          fill="#b9b8b3"
                          fontSize={11}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              );
            }}
          </QueryState>
          <div className="mt-2">
            <Note>
              <Swatch color="var(--color-ontime)" />
              Under 15 min late
              <span className="mx-3" />
              <Swatch color="var(--color-delayed)" />
              Delayed (15+ min)
            </Note>
          </div>
        </Section>
      </aside>
    </div>
  );
}
