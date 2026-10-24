import type { StreamStatusResponse } from '@flight-delay/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { STREAM_POLL_MS, useStreamStatus } from '../api/hooks';
import { Board, type BoardColumn } from '../components/Board';
import { ErrorBlock, Skeleton } from '../components/QueryState';
import { Note, PageHeader, Section } from '../components/ui';
import { formatInteger, hourLabel } from '../lib/format';
import {
  ageLabel,
  dateTimeOf,
  heartbeatAgeSeconds,
  metricRows,
  pairGroups,
  plural,
  readable,
  spanOf,
  throughputNote,
  type MetricCell,
  type MetricRow,
} from '../lib/live';

type Status = StreamStatusResponse;

const STATE_LABEL: Record<Status['state'], string> = {
  live: 'Live',
  idle: 'Idle',
  degraded: 'Degraded',
};

/** Re-renders every second, so "updated 4 s ago" stays true between polls. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Age text that ticks every second on its own, without re-rendering the boards around it. */
function Ago({ seconds }: { seconds: (now: number) => number | null }) {
  const now = useNow();
  return <>{ageLabel(seconds(now))}</>;
}

/** A value that changed since the previous poll holds the board's amber lamp for a moment. */
function Lit({ value, className = '' }: { value: string; className?: string }) {
  const [shown, setShown] = useState(value);
  const [changes, setChanges] = useState(0);
  if (value !== shown) {
    // Derived state adjusted during render (React's documented pattern): the new key below
    // remounts the span, which restarts the lamp animation. The first render never lights.
    setShown(value);
    setChanges((count) => count + 1);
  }
  return (
    <span key={changes} className={`${changes > 0 ? 'lit-value' : ''} ${className}`}>
      {value}
    </span>
  );
}

function StatusLine({
  status,
  updatedAt,
  pollError,
}: {
  status: Status;
  updatedAt: number;
  pollError: Error | null;
}) {
  const fallback =
    status.state === 'live'
      ? 'The consumer is running and Kafka is reachable.'
      : 'No reason reported.';
  return (
    <div className="border-y border-rule-strong py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <p className="flex items-center gap-3" role="status">
          {/* While polls fail, the last answer is shown as last known: hollow beacon, dimmed word. */}
          <span
            className={`beacon ${pollError ? 'beacon-idle' : `beacon-${status.state}`}`}
            aria-hidden="true"
          />
          <span
            className={`font-display text-[1.75rem] leading-none ${
              pollError ? 'text-ink-3' : status.state === 'degraded' ? 'text-cancelled' : 'text-ink'
            }`}
          >
            {STATE_LABEL[status.state]}
            {pollError ? <span className="ml-2 font-sans text-[12px]">last known</span> : null}
          </span>
          <span className="text-[13px] text-ink-2">
            {status.reason === null ? fallback : readable(status.reason)}
          </span>
        </p>
        <p className="num ml-auto text-[12px] text-ink-3">
          updated <Ago seconds={(now) => (now - updatedAt) / 1000} /> · polls every{' '}
          {STREAM_POLL_MS / 1000} s
        </p>
      </div>
      {pollError ? (
        <p className="mt-2 text-[13px] text-cancelled" role="alert">
          Could not refresh: {pollError.message}{' '}
          <span className="text-ink-2">
            Showing the last answer; retrying every {STREAM_POLL_MS / 1000} s.
          </span>
        </p>
      ) : null}
    </div>
  );
}

/** Heartbeat age that keeps ageing between (and through failed) polls. */
function HeartbeatAge({ status, updatedAt }: { status: Status; updatedAt: number }) {
  return <Ago seconds={(now) => heartbeatAgeSeconds(status.consumer.ageSeconds, updatedAt, now)} />;
}

function PipelineRow({
  status,
  updatedAt,
  stale,
}: {
  status: Status;
  updatedAt: number;
  /** The last poll failed: these are the last known values. */
  stale: boolean;
}) {
  const { consumer, kafka, stored } = status;
  const heartbeat =
    consumer.status === null ? (
      'no consumer heartbeat'
    ) : consumer.fresh ? (
      <>
        heartbeat <HeartbeatAge status={status} updatedAt={updatedAt} />
      </>
    ) : (
      <>
        last heartbeat <HeartbeatAge status={status} updatedAt={updatedAt} /> · {consumer.status}
      </>
    );
  const items: { label: string; value: string; note?: string | null; sub: ReactNode }[] = [
    {
      label: 'Flights stored',
      value: formatInteger(stored?.flights),
      sub: stored
        ? `${formatInteger(stored.scored)} scored · ${formatInteger(stored.refused)} refused`
        : 'MongoDB unavailable',
    },
    {
      label: 'Consumer throughput',
      value: consumer.throughput === null ? '—' : `${formatInteger(consumer.throughput)}/s`,
      note: throughputNote({
        fresh: consumer.fresh,
        throughput: consumer.throughput,
        lag: kafka.lag?.total ?? null,
      }),
      sub: heartbeat,
    },
    {
      label: 'Consumer lag',
      value: formatInteger(kafka.lag?.total),
      sub: kafka.lag
        ? `messages behind · ${plural(kafka.lag.partitions.length, 'partition')}`
        : kafka.reachable
          ? 'Kafka topics missing'
          : 'Kafka unreachable',
    },
    {
      label: 'Dead-letter queue',
      value: formatInteger(kafka.dlqMessages),
      sub: kafka.dlqMessages === null ? 'not readable' : 'messages retained',
    },
  ];
  return (
    <dl
      className={`grid grid-cols-2 border-y border-rule-strong transition-opacity lg:grid-cols-4 ${
        stale ? 'opacity-50' : ''
      }`}
      aria-label={stale ? 'Pipeline, last known values' : 'Pipeline'}
    >
      {items.map((item, index) => (
        <div
          key={item.label}
          className={`min-w-0 py-4 ${index % 2 === 1 ? 'border-l border-rule pl-5' : ''} ${
            index >= 2 ? 'border-t border-rule lg:border-t-0' : ''
          } ${index === 2 ? 'lg:border-l lg:pl-5' : ''}`}
        >
          <dt className="text-xs text-ink-2">{item.label}</dt>
          <dd className="display-num mt-1.5 text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1]">
            <Lit value={item.value} />
          </dd>
          {item.note ? <dd className="mt-1 text-[12px] text-ink-2">{item.note}</dd> : null}
          <dd className="num mt-1 break-words text-[11px] text-ink-3">{item.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

function sampleText(cell: MetricCell): string {
  if (cell.n === null) return cell.basis ?? '';
  if (cell.basis === 'flagged') return `of ${formatInteger(cell.n)} flagged`;
  if (cell.basis === 'delayed') return `of ${formatInteger(cell.n)} delayed`;
  return `n ${formatInteger(cell.n)}`;
}

function ValueCell({ cell, tone }: { cell: MetricCell | null; tone: MetricRow['tone'] }) {
  if (cell === null) return <span className="text-ink-3">—</span>;
  const sample = sampleText(cell);
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <Lit value={cell.value} className={tone === 'delay' ? 'text-delayed' : 'text-ink'} />
      {sample ? <span className="mt-0.5 text-[11px] text-ink-3">{sample}</span> : null}
    </span>
  );
}

function ColumnHead({
  title,
  n,
  lowSample,
  lowSampleBelow,
}: {
  title: string;
  n: number | undefined;
  lowSample: boolean | undefined;
  lowSampleBelow: number;
}) {
  return (
    <span className="inline-flex flex-col items-end font-sans leading-tight">
      <span>{title}</span>
      <span className="num text-[11px] text-ink-3">
        {n === undefined ? 'no data' : `n ${formatInteger(n)}`}
        {lowSample ? (
          <span className="text-ink-2"> · low sample (under {formatInteger(lowSampleBelow)})</span>
        ) : null}
      </span>
    </span>
  );
}

/** Both boards share these widths so their value columns line up. */
const VALUE_COLUMN = 'w-28 sm:w-40';

function metricColumns(windowHead: ReactNode, totalsHead: ReactNode): BoardColumn<MetricRow>[] {
  return [
    {
      id: 'metric',
      header: 'Metric',
      rowHeader: true,
      cell: (row) => (
        <span className="flex flex-col py-1.5 font-sans leading-tight">
          <span className="text-ink">{row.label}</span>
          <span className="mt-0.5 hidden text-[11px] text-ink-3 sm:block">{row.hint}</span>
        </span>
      ),
    },
    {
      id: 'window',
      header: windowHead,
      align: 'right',
      className: VALUE_COLUMN,
      cell: (row) => <ValueCell cell={row.window} tone={row.tone} />,
    },
    {
      id: 'totals',
      header: totalsHead,
      align: 'right',
      className: VALUE_COLUMN,
      cell: (row) => <ValueCell cell={row.totals} tone={row.tone} />,
    },
  ];
}

function MetricBoards({ status }: { status: Status }) {
  const { window, totals } = status;
  if (window === null || totals === null) {
    return (
      <ErrorBlock
        label="the live metrics"
        error={new Error(readable(status.metricsReason ?? 'MongoDB metrics unavailable.'))}
      />
    );
  }
  const pairs = pairGroups(window.groups, totals.groups);
  if (pairs.length === 0) {
    return (
      <p className="border-y border-rule py-6 text-sm text-ink-2" role="status">
        No scored flight has an outcome yet. Start the consumer and a replay to see live metrics.
      </p>
    );
  }
  return (
    <div className="space-y-8">
      {window.mixedModelVersions || totals.mixedModelVersions ? (
        <Note>
          These predictions come from more than one model or threshold, so each one is shown
          separately rather than pooled.
        </Note>
      ) : null}
      {pairs.map((pair) => {
        const rows = metricRows(pair.window, pair.totals);
        const columns = metricColumns(
          <ColumnHead
            title={`Last ${formatInteger(window.size)}`}
            n={pair.window?.n}
            lowSample={pair.window?.lowSample}
            lowSampleBelow={status.lowSampleBelow}
          />,
          <ColumnHead
            title="Whole replay"
            n={pair.totals?.n}
            lowSample={pair.totals?.lowSample}
            lowSampleBelow={status.lowSampleBelow}
          />,
        );
        return (
          <div key={pair.key} className="space-y-6">
            <p className="num text-[12px] text-ink-3">
              Model <span className="text-ink-2">{pair.modelVersion}</span> · threshold{' '}
              <span className="text-ink-2">{pair.threshold.toFixed(4)}</span>
              {pair.servedModel ? (
                <span className="ml-2 rounded-full bg-ink px-2 py-0.5 font-sans text-[10px] text-ground">
                  served
                </span>
              ) : (
                <span className="ml-2 font-sans">not the model served now</span>
              )}
            </p>
            <Board
              rows={rows.filter((row) => row.kind === 'rate')}
              getKey={(row) => row.id}
              columns={columns}
              caption={`Live prediction metrics for model ${pair.modelVersion}: the rolling window beside the whole replay, each with its sample size`}
              showRank={false}
              animate={false}
            />
            <div>
              <h3 className="mb-2 font-display text-xl font-normal">Verdict counts</h3>
              <Board
                rows={rows.filter((row) => row.kind === 'count')}
                getKey={(row) => row.id}
                columns={columns}
                caption={`Confusion counts for model ${pair.modelVersion}: rolling window and whole replay`}
                showRank={false}
                animate={false}
              />
            </div>
          </div>
        );
      })}
      <Note>
        A flight counts as delayed when it arrives 15 or more minutes late. The threshold was{' '}
        {status.thresholdSource}. ROC-AUC needs every stored probability at once, so it is computed
        for the window only, never for the whole replay.
      </Note>
    </div>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-rule border-y border-rule text-[13px]">
      {rows.map(([term, value]) => (
        <div key={term} className="grid gap-x-6 gap-y-0.5 py-2.5 sm:grid-cols-[130px_1fr]">
          <dt className="text-ink-3">{term}</dt>
          <dd className="break-words text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WindowFacts({ status }: { status: Status }) {
  const { window, totals } = status;
  if (window === null || totals === null) return null;
  const n = (text: string) => <span className="num">{text}</span>;
  const hours = window.departureHours;
  return (
    <Facts
      rows={[
        ['Data', status.source],
        [
          'Flight dates',
          window.windowStart === null
            ? '—'
            : window.windowStart === window.windowEnd
              ? n(window.windowStart)
              : n(`${window.windowStart} → ${window.windowEnd}`),
        ],
        [
          'Departures',
          hours === null ? (
            '—'
          ) : (
            <>scheduled {n(`${hourLabel(hours.min)}–${String(hours.max).padStart(2, '0')}:59`)}</>
          ),
        ],
        [
          'Stored by consumer',
          window.writtenFrom === null || window.writtenTo === null
            ? '—'
            : n(spanOf(dateTimeOf(window.writtenFrom), dateTimeOf(window.writtenTo))),
        ],
        [
          'Order',
          <span className="text-ink-2">
            The order in which the consumer first stored each flight, not flight date. The replay
            follows the source file (date, then scheduled departure), so after a full replay the
            window is the latest departures of the last replayed day: a slice of the schedule, not a
            sample of the month.
          </span>,
        ],
        [
          'Whole replay',
          <span className="text-ink-2">
            Every stored flight, counted once however often Kafka delivered it.
          </span>,
        ],
      ]}
    />
  );
}

interface PartitionRow {
  partition: number;
  committed: number | null;
  end: number;
  lag: number;
}

const PARTITION_COLUMNS: BoardColumn<PartitionRow>[] = [
  { id: 'partition', header: 'Partition', rowHeader: true, cell: (row) => String(row.partition) },
  {
    id: 'committed',
    header: 'Committed',
    align: 'right',
    cell: (row) => (row.committed === null ? 'none' : formatInteger(row.committed)),
  },
  {
    id: 'end',
    header: 'End',
    align: 'right',
    cell: (row) => <Lit value={formatInteger(row.end)} />,
  },
  {
    id: 'lag',
    header: 'Lag',
    align: 'right',
    cell: (row) => <Lit value={formatInteger(row.lag)} className="text-ink" />,
  },
];

function KafkaPanel({ status, updatedAt }: { status: Status; updatedAt: number }) {
  const { kafka, consumer } = status;
  const n = (text: string) => <span className="num">{text}</span>;
  return (
    <div className="space-y-8">
      <Section
        title="Kafka"
        note={`Committed offsets of group ${consumer.groupId} against each partition's end.`}
      >
        {kafka.lag ? (
          <Board
            rows={kafka.lag.partitions}
            getKey={(row) => String(row.partition)}
            columns={PARTITION_COLUMNS}
            caption="Consumer lag per partition of the replay topic"
            showRank={false}
            animate={false}
          />
        ) : (
          <div className="border-y border-rule py-4 text-[13px]">
            <p className="text-cancelled">
              {kafka.reachable
                ? 'Kafka is reachable, but its topics are missing'
                : 'Kafka unreachable'}
            </p>
            <p className="mt-1 text-ink-2">
              {kafka.reason === null ? 'No reason reported.' : readable(kafka.reason)}
            </p>
            <p className="mt-1 text-ink-3">The rest of the app does not depend on Kafka.</p>
          </div>
        )}
      </Section>
      <Section title="Consumer">
        <Facts
          rows={[
            ['Status', consumer.status === null ? 'never started' : consumer.status],
            [
              'Last heartbeat',
              <span className="num">
                <HeartbeatAge status={status} updatedAt={updatedAt} />
              </span>,
            ],
            [
              'Liveness',
              <span className="text-ink-2">
                beats every <span className="num">{consumer.heartbeatIntervalSeconds}</span> s,
                stale after <span className="num">{consumer.staleAfterSeconds}</span> s
              </span>,
            ],
            ['Instance', consumer.instanceId === null ? '—' : n(consumer.instanceId)],
            ...(consumer.error === null
              ? []
              : [['Error', readable(consumer.error)] as [string, ReactNode]]),
          ]}
        />
      </Section>
    </div>
  );
}

function LiveBody({
  status,
  updatedAt,
  pollError,
}: {
  status: Status;
  updatedAt: number;
  pollError: Error | null;
}) {
  return (
    <div className="space-y-10">
      <div className="space-y-6">
        <StatusLine status={status} updatedAt={updatedAt} pollError={pollError} />
        <PipelineRow status={status} updatedAt={updatedAt} stale={pollError !== null} />
      </div>
      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-10">
          <Section
            title="How the live predictions hold up"
            note="Each streamed flight is scored before its outcome is read, then judged against what happened. Every value shows the sample it was computed on."
          >
            <MetricBoards status={status} />
          </Section>
          <Section title="What the window covers">
            <WindowFacts status={status} />
          </Section>
        </div>
        <KafkaPanel status={status} updatedAt={updatedAt} />
      </div>
    </div>
  );
}

export default function Live() {
  const status = useStreamStatus();
  return (
    <div className="space-y-10">
      <PageHeader title="Live replay">
        December 2015 flights replayed through Kafka. Each one is scored by the served model as it
        arrives, then judged against what actually happened. It is a replay of 2015 data, not a live
        feed.
      </PageHeader>
      {status.data === undefined ? (
        status.isError ? (
          <ErrorBlock
            label="the stream status"
            error={status.error}
            hint="Is the API running? Start it with npm run dev."
            onRetry={() => void status.refetch()}
          />
        ) : (
          <div role="status">
            <span className="sr-only">Loading the stream status</span>
            <Skeleton className="h-[36rem]" />
          </div>
        )
      ) : (
        <LiveBody
          status={status.data}
          updatedAt={status.dataUpdatedAt}
          pollError={status.isError ? status.error : null}
        />
      )}
    </div>
  );
}
