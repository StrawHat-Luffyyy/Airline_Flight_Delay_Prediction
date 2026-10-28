import type {
  CompareEntity,
  CompareResponse,
  CompareType,
  MetaResponse,
} from '@flight-delay/shared';
import { COMPARE_MAX } from '@flight-delay/shared';
import { TriangleAlert, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useCompare, useMeta, useRoutes } from '../api/hooks';
import { EmptyBlock, ErrorBlock, QueryState, Skeleton } from '../components/QueryState';
import type { FieldOption } from '../components/predict/FlightFields';
import { FlightSelect } from '../components/predict/FlightSelect';
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
import {
  METRIC_ROWS,
  MIN_FLIGHTS_OPTIONS,
  addId,
  formatDifference,
  formatMetric,
  makeBaseline,
  readSelection,
  removeId,
  selectionSearch,
  type MetricRow,
  type Selection,
} from '../lib/compare';
import { formatInteger, formatPercent, formatSignedMinutes } from '../lib/format';
import { CAUSE_META, CAUSE_ORDER } from '../lib/labels';

const TYPE_OPTIONS = [
  { value: 'airline', label: 'Airlines' },
  { value: 'airport', label: 'Airports' },
  { value: 'route', label: 'Routes' },
] as const;

const NOUN: Record<CompareType, { one: string; many: string }> = {
  airline: { one: 'airline', many: 'airlines' },
  airport: { one: 'airport', many: 'airports' },
  route: { one: 'route', many: 'routes' },
};

const MIN_FLIGHTS_FIELD: FieldOption[] = MIN_FLIGHTS_OPTIONS.map((value) => ({
  value: String(value),
  code: formatInteger(value),
  name: 'flights',
}));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The name beside the code: the airline's name, the airport's full name, the route's cities. */
function entityName(type: CompareType, entity: CompareEntity): string {
  return type === 'airline' ? entity.label : (entity.detail ?? entity.label);
}

function place(airport: MetaResponse['airports'][number]): string {
  return [airport.city, airport.state].filter(Boolean).join(', ');
}

// ---------- Choosing ----------

interface PickerProps {
  selection: Selection;
  onChange: (next: Selection) => void;
  minFlights: number;
  onMinFlights: (value: number) => void;
}

function Picker({ selection, onChange, minFlights, onMinFlights }: PickerProps) {
  const meta = useMeta();
  const [announcement, setAnnouncement] = useState('');
  const noun = NOUN[selection.type];
  const full = selection.ids.length >= COMPARE_MAX;

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const airline of meta.data?.airlines ?? []) map.set(airline.code, airline.name);
    for (const airport of meta.data?.airports ?? []) map.set(airport.code, airport.name);
    return map;
  }, [meta.data]);
  const nameOf = (id: string) =>
    selection.type === 'route' ? id.replace('-', ' → ') : (names.get(id) ?? id);

  const remove = (id: string) => {
    const next = removeId(selection, id);
    onChange(next);
    setAnnouncement(`Removed ${nameOf(id)}. ${next.ids.length} of ${COMPARE_MAX} chosen.`);
  };
  const add = (id: string) => {
    const next = addId(selection, id);
    onChange(next);
    setAnnouncement(`Added ${nameOf(id)}. ${next.ids.length} of ${COMPARE_MAX} chosen.`);
  };

  return (
    <Section
      title="Choose what to compare"
      note={`Pick two to four ${noun.many}. The first is the baseline: every difference below is measured from it.`}
      actions={
        <Segmented
          label="Compare"
          value={selection.type}
          onChange={(type) => onChange({ ...selection, type, ids: [] })}
          options={TYPE_OPTIONS}
        />
      }
    >
      <div className="space-y-5">
        {selection.ids.length > 0 ? (
          <ul aria-label={`Chosen ${noun.many}`} className="flex flex-wrap gap-2">
            {selection.ids.map((id, index) => (
              <li
                key={id}
                className="flex items-center gap-1 rounded-full border border-rule-strong py-1 pl-3 pr-1 text-[12px]"
              >
                <span className="num text-ink">{id}</span>
                {selection.type !== 'route' ? (
                  <span className="ml-1 max-w-[11rem] truncate text-ink-2 sm:max-w-[16rem]">
                    {nameOf(id)}
                  </span>
                ) : null}
                {index === 0 ? (
                  <span className="ml-1.5 pr-2 text-ink-3">Baseline</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onChange(makeBaseline(selection, id))}
                    className="ml-1 rounded-full px-2 py-0.5 text-ink-3 hover:bg-wash hover:text-ink"
                    aria-label={`Set baseline: ${nameOf(id)}`}
                  >
                    Set baseline
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => remove(id)}
                  aria-label={`Remove ${nameOf(id)}`}
                  className="grid size-6 place-items-center rounded-full text-ink-3 hover:bg-wash hover:text-ink"
                >
                  <X size={13} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>

        {meta.isError ? (
          <ErrorBlock
            error={meta.error}
            label={`the ${noun.one} list`}
            onRetry={() => void meta.refetch()}
          />
        ) : meta.data === undefined ? (
          <div role="status">
            <span className="sr-only">Loading the {noun.one} list</span>
            <Skeleton className="h-11 max-w-[40rem]" />
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
            {selection.type === 'route' ? (
              <RouteAdder meta={meta.data} chosen={selection.ids} full={full} onAdd={add} />
            ) : (
              <FlightSelect
                key={`${selection.type}-${selection.ids.length}`}
                label={`Add an ${noun.one}`}
                className="w-full sm:w-80"
                value=""
                options={entityOptions(selection.type, meta.data).filter(
                  (option) => !selection.ids.includes(option.value),
                )}
                onChange={add}
                searchable
                searchNoun={selection.type === 'airline' ? 'code or name' : 'code, airport or city'}
                placeholder={
                  full ? `${COMPARE_MAX} chosen. Remove one to add another.` : `Search ${noun.many}`
                }
                disabled={full}
                minListWidth={320}
              />
            )}
            <FlightSelect
              label="Minimum flights"
              className="w-40"
              value={String(minFlights)}
              options={MIN_FLIGHTS_FIELD}
              minListWidth={176}
              onChange={(next) => onMinFlights(Number(next))}
            />
          </div>
        )}
      </div>
    </Section>
  );
}

function entityOptions(type: CompareType, meta: MetaResponse): FieldOption[] {
  if (type === 'airline') {
    return meta.airlines.map((airline) => ({
      value: airline.code,
      code: airline.code,
      name: airline.name,
    }));
  }
  return [...meta.airports]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((airport) => ({
      value: airport.code,
      code: airport.code,
      name: airport.name,
      detail: place(airport),
    }));
}

/** Origin, then a destination actually flown from it in 2015, then Add. */
function RouteAdder({
  meta,
  chosen,
  full,
  onAdd,
}: {
  meta: MetaResponse;
  chosen: readonly string[];
  full: boolean;
  onAdd: (route: string) => void;
}) {
  const [origin, setOrigin] = useState('');
  const [dest, setDest] = useState('');
  const routes = useRoutes(origin);
  const airportNames = useMemo(
    () => new Map(meta.airports.map((airport) => [airport.code, airport.name])),
    [meta.airports],
  );
  const destOptions: FieldOption[] = (routes.data?.destinations ?? [])
    .filter((route) => !chosen.includes(`${origin}-${route.dest}`))
    .map((route) => ({
      value: route.dest,
      code: route.dest,
      name: airportNames.get(route.dest) ?? '',
      detail: `${formatInteger(route.flights)} flights in 2015`,
    }));
  const destPlaceholder =
    origin === ''
      ? 'Choose an origin first'
      : routes.isPending
        ? 'Loading routes…'
        : routes.isError
          ? 'Routes unavailable'
          : destOptions.length === 0
            ? `No other 2015 routes from ${origin}`
            : 'Search destinations';
  const ready = origin !== '' && dest !== '' && !full;

  return (
    <>
      <FlightSelect
        label="Origin"
        className="w-full sm:w-64"
        value={origin}
        options={entityOptions('airport', meta)}
        onChange={(next) => {
          setOrigin(next);
          setDest('');
        }}
        searchable
        searchNoun="code, airport or city"
        placeholder="Search airports"
        disabled={full}
        minListWidth={320}
      />
      <FlightSelect
        label="Destination"
        hint={routes.isSuccess ? `${destOptions.length} flown` : undefined}
        className="w-full sm:w-64"
        value={dest}
        options={destOptions}
        onChange={setDest}
        searchable
        searchNoun="code, airport or city"
        placeholder={destPlaceholder}
        disabled={full || origin === '' || destOptions.length === 0}
        minListWidth={320}
      />
      <button
        type="button"
        disabled={!ready}
        onClick={() => {
          onAdd(`${origin}-${dest}`);
          setDest('');
        }}
        className="h-11 rounded-full border border-rule-strong px-5 text-[13px] text-ink hover:bg-wash disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        {full ? `${COMPARE_MAX} chosen` : 'Add route'}
      </button>
    </>
  );
}

// ---------- Head to head ----------

function SampleBadge({ entity, minFlights }: { entity: CompareEntity; minFlights: number }) {
  if (entity.sample === 'ok') return null;
  const text = entity.sample === 'none' ? 'No 2015 flights' : `Under ${formatInteger(minFlights)}`;
  return (
    <span className="inline-flex items-center gap-1 text-ink-2">
      <TriangleAlert size={12} strokeWidth={1.5} aria-hidden="true" />
      {text}
    </span>
  );
}

/** Paired encoding for delay metrics: more delay reads amber, less reads blue. */
function differenceTone(row: MetricRow, value: number | null): string {
  if (row.id !== 'delayRate' && row.id !== 'avgArrDelay') return 'text-ink-3';
  // A difference that rounds to 0.0 pp or 0.0 min is shown as zero, so it is not coloured.
  const shownAsZero = value === null || Math.abs(value) < (row.kind === 'rate' ? 0.0005 : 0.05);
  if (shownAsZero) return 'text-ink-3';
  return value > 0 ? 'text-delayed' : 'text-ontime';
}

/** "Tied" when every reliable choice shares the lowest value, so no column stands out. */
function leaderBadge(data: CompareResponse, row: MetricRow): string {
  if (!row.leader) return '';
  const leaders = data.leaders[row.leader];
  const eligible = data.entities.filter(
    (entity) => entity.sample === 'ok' && entity.totals[row.id] !== null,
  ).length;
  return leaders.length > 1 && leaders.length === eligible ? 'Tied' : 'Lowest';
}

function HeadToHead({ data }: { data: CompareResponse }) {
  const baseline = data.entities[0];
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[34rem] border-collapse text-left text-[13px]">
        <caption className="sr-only">
          {`${NOUN[data.type].many} compared on 2015 outcomes; differences are from ${data.baselineId}`}
        </caption>
        <thead>
          <tr className="border-b border-rule-strong">
            <th
              scope="col"
              className="sticky left-0 z-10 w-[8.5rem] min-w-[8.5rem] bg-ground py-3 pr-4 align-bottom text-[11px] font-normal tracking-wide text-ink-3 sm:w-56"
            >
              Metric
            </th>
            {data.entities.map((entity, index) => (
              <th
                key={entity.id}
                scope="col"
                className="min-w-[8.5rem] px-3 py-3 text-right align-bottom font-normal last:pr-0"
              >
                <span className="num block text-[15px] tracking-[0.03em] text-ink">
                  {entity.id}
                </span>
                <span
                  className="ml-auto block max-w-[13rem] truncate text-[12px] text-ink-2"
                  title={entityName(data.type, entity)}
                >
                  {entityName(data.type, entity)}
                </span>
                <span className="mt-1 block min-h-4 text-[11px] text-ink-3">
                  {index === 0 ? 'Baseline' : null}
                  {index === 0 && entity.sample !== 'ok' ? ' · ' : null}
                  <SampleBadge entity={entity} minFlights={data.minFlights} />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRIC_ROWS.map((row) => (
            <tr key={row.id} className="border-b border-rule">
              <th
                scope="row"
                className="sticky left-0 z-10 w-[8.5rem] min-w-[8.5rem] bg-ground py-2.5 pr-4 font-normal sm:w-56"
              >
                <span className="block text-ink">{row.label}</span>
                <span className="block text-[11px] leading-snug text-ink-3">{row.definition}</span>
              </th>
              {data.entities.map((entity, index) => {
                const value = entity.totals[row.id];
                const lowest = row.leader ? data.leaders[row.leader].includes(entity.id) : false;
                const badge = leaderBadge(data, row);
                const diff = entity.differences ? entity.differences[row.id] : null;
                return (
                  <td key={entity.id} className="px-3 py-2.5 text-right align-top last:pr-0">
                    <span className="flex items-center justify-end gap-2">
                      {lowest ? (
                        <span className="rounded-full border border-rule-strong px-1.5 text-[10px] leading-4 text-ink-2">
                          {badge}
                        </span>
                      ) : null}
                      <span
                        className={`num whitespace-nowrap ${
                          row.id === 'delayRate' && value !== null ? 'text-delayed' : 'text-ink'
                        } ${entity.sample === 'ok' ? '' : 'opacity-70'}`}
                      >
                        {formatMetric(row.kind, value)}
                      </span>
                    </span>
                    {index > 0 && baseline ? (
                      <span
                        className={`num block whitespace-nowrap text-[11px] ${differenceTone(row, diff)}`}
                      >
                        {formatDifference(row.kind, diff)}
                        <span className="sr-only"> compared with {baseline.id}</span>
                      </span>
                    ) : (
                      <span className="block text-[11px]" aria-hidden="true">
                        &nbsp;
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Warnings({ data }: { data: CompareResponse }) {
  const lines: string[] = [];
  const baseline = data.entities[0];
  if (baseline && baseline.sample !== 'ok') {
    lines.push(
      `The baseline, ${baseline.id}, ${
        baseline.sample === 'none' ? 'has no 2015 flights' : 'is below the minimum'
      }, so differences from it say little. Use Set baseline to measure from a better-sampled choice.`,
    );
  }
  for (const entity of data.entities) {
    if (entity.sample === 'none') {
      lines.push(
        `${entity.id} has no 2015 flights in the pre-aggregated stats, so its rates are blank.`,
      );
    } else if (entity.sample === 'low') {
      lines.push(
        `${entity.id} has only ${formatInteger(entity.totals.flights)} flights, under the ${formatInteger(
          data.minFlights,
        )} minimum: its rates are shown dimmed and it is never marked lowest.`,
      );
    }
  }
  if (data.coverage) lines.push(data.coverage.note);
  if (lines.length === 0) return null;
  return (
    <ul className="mb-4 space-y-1.5" aria-label="Data warnings">
      {lines.map((line) => (
        <li key={line} className="flex max-w-[75ch] gap-2 text-[13px] leading-relaxed text-ink-2">
          <TriangleAlert
            size={14}
            strokeWidth={1.5}
            className="mt-[3px] shrink-0 text-ink-3"
            aria-hidden="true"
          />
          {line}
        </li>
      ))}
    </ul>
  );
}

// ---------- Charts ----------

const RATE_GROUPS = [
  { id: 'delayRate', label: 'Delay rate', basis: 'delayed ÷ completed', bar: 'bg-delayed' },
  {
    id: 'cancelRate',
    label: 'Cancellation rate',
    basis: 'cancelled ÷ flights',
    bar: 'bg-cancelled',
  },
  { id: 'divertRate', label: 'Diversion rate', basis: 'diverted ÷ flights', bar: 'bg-ink-2' },
] as const;

/** One bar group per rate, each scaled to its own largest value and starting from zero. */
function RateBars({ data }: { data: CompareResponse }) {
  return (
    <div className="space-y-6">
      {RATE_GROUPS.map((group) => {
        const max = Math.max(0, ...data.entities.map((e) => e.totals[group.id] ?? 0));
        return (
          <figure key={group.id}>
            <figcaption className="mb-2 text-[12px] text-ink-2">
              {group.label} <span className="text-ink-3">· {group.basis}</span>
            </figcaption>
            <ul className="space-y-1">
              {data.entities.map((entity) => {
                const value = entity.totals[group.id];
                const width = value !== null && max > 0 ? (value / max) * 100 : 0;
                return (
                  <li
                    key={entity.id}
                    className="grid grid-cols-[4.75rem_minmax(0,1fr)_4rem] items-center gap-3"
                  >
                    <span className="num truncate text-[12px] text-ink-2">{entity.id}</span>
                    <span
                      className={`h-1.5 rounded-full bg-wash ${value === null ? 'hatch' : ''}`}
                      aria-hidden="true"
                    >
                      <span
                        className={`block h-1.5 rounded-full transition-[width] duration-500 ${group.bar} ${
                          entity.sample === 'ok' ? '' : 'opacity-50'
                        }`}
                        style={{ width: `${width}%` }}
                      />
                    </span>
                    <span
                      className={`num text-right text-[13px] ${
                        group.id === 'delayRate' && value !== null ? 'text-delayed' : 'text-ink'
                      }`}
                    >
                      {formatPercent(value)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </figure>
        );
      })}
    </div>
  );
}

/** Mean arrival delay diverging from zero: late to the right in amber, early to the left in blue. */
function ArrivalDelayBars({ data }: { data: CompareResponse }) {
  const scale = Math.max(1, ...data.entities.map((e) => Math.abs(e.totals.avgArrDelay ?? 0)));
  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {data.entities.map((entity) => {
          const value = entity.totals.avgArrDelay;
          const width = value === null ? 0 : (Math.abs(value) / scale) * 50;
          return (
            <li
              key={entity.id}
              className="grid grid-cols-[4.75rem_minmax(0,1fr)_5rem] items-center gap-3"
            >
              <span className="num truncate text-[12px] text-ink-2">{entity.id}</span>
              <span className={`relative h-5 ${value === null ? 'hatch' : ''}`} aria-hidden="true">
                <span className="absolute inset-y-0 left-1/2 w-px bg-rule-strong" />
                {value !== null && value !== 0 ? (
                  <span
                    className={`absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full transition-[width] duration-500 ${
                      value > 0 ? 'left-1/2 bg-delayed' : 'right-1/2 bg-ontime'
                    } ${entity.sample === 'ok' ? '' : 'opacity-50'}`}
                    style={{ width: `${width}%` }}
                  />
                ) : null}
              </span>
              <span
                className={`num text-right text-[13px] ${
                  value === null || value === 0
                    ? 'text-ink'
                    : value > 0
                      ? 'text-delayed'
                      : 'text-ontime'
                }`}
              >
                {formatSignedMinutes(value)}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-2">
        <span>
          <Swatch color="var(--color-ontime)" />
          Early on average
        </span>
        <span>
          <Swatch color="var(--color-delayed)" />
          Late on average
        </span>
      </div>
    </div>
  );
}

interface CauseChartRow {
  axis: string;
  name: string;
  total: number;
  lateAircraft: number;
  carrier: number;
  nas: number;
  weather: number;
  security: number;
}

function CauseMix({ data }: { data: CompareResponse }) {
  const chartMotion = useChartMotion();
  const withCauses = data.entities.filter((e) => e.causes !== null && e.causes.totalMinutes > 0);
  const rows: CauseChartRow[] = withCauses.map((entity) => ({
    axis: entity.id,
    name: entityName(data.type, entity),
    total: entity.causes!.totalMinutes,
    ...entity.causes!.minutes,
  }));
  const missing = data.entities.filter((e) => e.causes !== null && e.causes.totalMinutes === 0);

  return (
    <div className="space-y-4">
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-2">
        {CAUSE_ORDER.map((key) => (
          <li key={key}>
            <Swatch color={CAUSE_META[key].color} />
            {CAUSE_META[key].label}
          </li>
        ))}
      </ul>
      {rows.length > 0 ? (
        <div
          role="img"
          aria-label="Share of delay minutes by cause for each choice; the table below lists the values"
          style={{ height: rows.length * 46 + 36 }}
          className="w-full"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              layout="vertical"
              stackOffset="expand"
              barCategoryGap={10}
              margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.08)" horizontal={false} />
              <XAxis
                type="number"
                tick={AXIS_TICK}
                stroke="rgba(255,255,255,0.16)"
                tickLine={false}
                tickFormatter={(value: number) => formatPercent(value, 0)}
              />
              <YAxis
                type="category"
                dataKey="axis"
                width={data.type === 'route' ? 64 : 44}
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                interval={0}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                labelFormatter={(_label, payload) => {
                  const row = payload[0]?.payload as CauseChartRow | undefined;
                  return row ? `${row.name} · ${formatInteger(row.total)} min` : '';
                }}
                formatter={(value, name, item) => {
                  const row = item.payload as CauseChartRow | undefined;
                  const share = row && row.total > 0 ? Number(value) / row.total : null;
                  return [`${formatPercent(share)} · ${formatInteger(Number(value))} min`, name];
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
      ) : null}
      {missing.length > 0 ? (
        <Note>
          {missing.map((e) => e.id).join(', ')} reported no cause minutes, so{' '}
          {missing.length > 1 ? 'they have' : 'it has'} no bar.
        </Note>
      ) : null}
      <Note>
        Cause minutes are reported only for flights that arrived 15+ minutes late. Each bar rests on
        that many flights:{' '}
        {data.entities
          .filter((e) => e.causes !== null)
          .map((e) => `${e.id} ${formatInteger(e.causes!.flightsWithCauses)}`)
          .join(' · ')}
        .
      </Note>
      <div className="sr-only">
        <table>
          <caption>Share of delay minutes by cause</caption>
          <thead>
            <tr>
              <th scope="col">Choice</th>
              {CAUSE_ORDER.map((key) => (
                <th key={key} scope="col">
                  {CAUSE_META[key].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.entities.map((entity) => (
              <tr key={entity.id}>
                <th scope="row">{entity.id}</th>
                {CAUSE_ORDER.map((key) => (
                  <td key={key}>{formatPercent(entity.causes?.shares[key] ?? null)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Delay rate per month as an amber strip per choice (the Explorer heatmap's encoding). */
function MonthlyStrip({ data }: { data: CompareResponse }) {
  const rates = data.entities.flatMap((e) =>
    (e.monthly ?? []).flatMap((m) => (m.delayRate === null ? [] : [m.delayRate])),
  );
  const min = rates.length ? Math.min(...rates) : 0;
  const max = rates.length ? Math.max(...rates) : 0;
  const alphaOf = (rate: number) => (max > min ? 0.1 + 0.9 * ((rate - min) / (max - min)) : 0.55);

  const cell = (entity: CompareEntity, monthIndex: number) => {
    const month = entity.monthly?.[monthIndex];
    const rate = month?.delayRate ?? null;
    const alpha = rate === null ? 0 : alphaOf(rate);
    const title =
      rate === null
        ? `${entity.id} · ${MONTHS[monthIndex]} · no completed flights`
        : `${entity.id} · ${MONTHS[monthIndex]} · ${formatPercent(rate)} of ${formatInteger(
            month?.completed ?? 0,
          )} completed flights delayed`;
    return (
      <span
        key={`${entity.id}-${monthIndex}`}
        title={title}
        className={`num grid h-9 place-items-center rounded-[2px] border border-rule text-[11px] ${
          rate === null ? 'hatch text-ink-3' : alpha > 0.6 ? 'text-ground' : 'text-ink'
        }`}
        style={rate === null ? undefined : { background: `rgba(232,165,75,${alpha})` }}
      >
        {rate === null ? '' : formatPercent(rate, 0)}
      </span>
    );
  };

  return (
    <div className="space-y-3">
      <div aria-hidden="true">
        {/* sm and up: a row per choice, a column per month */}
        <div
          className="hidden gap-[3px] sm:grid"
          style={{ gridTemplateColumns: '4.75rem repeat(12, minmax(0, 1fr))' }}
        >
          <span />
          {MONTHS.map((month) => (
            <span key={month} className="pb-1 text-center text-[11px] text-ink-3">
              {month}
            </span>
          ))}
          {data.entities.map((entity) => (
            <EntityRow key={entity.id} id={entity.id}>
              {MONTHS.map((_month, index) => cell(entity, index))}
            </EntityRow>
          ))}
        </div>
        {/* below sm: transposed, a row per month */}
        <div
          className="grid gap-[3px] sm:hidden"
          style={{ gridTemplateColumns: `2.5rem repeat(${data.entities.length}, minmax(0, 1fr))` }}
        >
          <span />
          {data.entities.map((entity) => (
            <span key={entity.id} className="num truncate pb-1 text-center text-[11px] text-ink-2">
              {entity.id}
            </span>
          ))}
          {MONTHS.map((month, index) => (
            <MonthRow key={month} month={month}>
              {data.entities.map((entity) => cell(entity, index))}
            </MonthRow>
          ))}
        </div>
      </div>
      <div className="sr-only">
        <table>
          <caption>Delay rate by month</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              {data.entities.map((entity) => (
                <th key={entity.id} scope="col">
                  {entity.id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MONTHS.map((month, index) => (
              <tr key={month}>
                <th scope="row">{month}</th>
                {data.entities.map((entity) => (
                  <td key={entity.id}>
                    {formatPercent(entity.monthly?.[index]?.delayRate ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-ink-2">
        {rates.length > 0 ? (
          <span className="flex items-center gap-2">
            <span className="num text-ink">{formatPercent(min)}</span>
            <span
              className="h-2.5 w-32 rounded-sm"
              style={{
                background: 'linear-gradient(90deg, rgba(232,165,75,0.1), rgba(232,165,75,1))',
              }}
              aria-hidden="true"
            />
            <span className="num text-ink">{formatPercent(max)}</span>
            <span>lowest to highest month shown</span>
          </span>
        ) : null}
        <span className="flex items-center gap-2">
          <span className="hatch h-2.5 w-6 rounded-sm border border-rule" aria-hidden="true" />
          No completed flights
        </span>
      </div>
    </div>
  );
}

function EntityRow({ id, children }: { id: string; children: ReactNode }) {
  return (
    <>
      <span className="num flex items-center truncate text-[12px] text-ink-2">{id}</span>
      {children}
    </>
  );
}

function MonthRow({ month, children }: { month: string; children: ReactNode }) {
  return (
    <>
      <span className="flex items-center text-[11px] text-ink-3">{month}</span>
      {children}
    </>
  );
}

// ---------- Page ----------

function Results({ data, stale }: { data: CompareResponse; stale: boolean }) {
  return (
    <div
      aria-busy={stale}
      className={`space-y-10 transition-opacity duration-200 ${stale ? 'opacity-50' : ''}`}
    >
      <Section
        title="Head to head"
        note={`Every rate is derived from summed 2015 counts. Differences are from ${data.baselineId}: counts and minutes as plain differences, rates in percentage points. "Lowest" marks the lowest value among reliable samples; "Tied" means every reliable choice shares it.`}
      >
        <Warnings data={data} />
        <HeadToHead data={data} />
      </Section>

      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-2">
        <Section
          title="Rates"
          note="Each group is scaled to its own largest value. Dimmed bars are below the reliable-sample minimum."
        >
          <RateBars data={data} />
        </Section>
        <Section
          title="Average arrival delay"
          note="Mean over completed flights, early arrivals counting as negative minutes."
        >
          <ArrivalDelayBars data={data} />
        </Section>
      </div>

      <Section
        title="What causes the delay minutes"
        note="Each cause's share of the reported delay minutes."
      >
        {data.availability.causes ? (
          <EmptyBlock message={data.availability.causes} />
        ) : (
          <CauseMix data={data} />
        )}
      </Section>

      <Section
        title="Delay rate by month"
        note="Delayed ÷ completed flights in each month of 2015, one shade scale across every cell."
      >
        {data.availability.monthly ? (
          <EmptyBlock message={data.availability.monthly} />
        ) : (
          <MonthlyStrip data={data} />
        )}
      </Section>
    </div>
  );
}

export default function Compare() {
  const [params, setParams] = useSearchParams();
  const selection = readSelection(params);
  const comparison = useCompare(selection.type, selection.ids, selection.minFlights);
  const noun = NOUN[selection.type];
  const missing = 2 - selection.ids.length;

  const change = (next: Selection) => setParams(selectionSearch(next), { replace: true });

  return (
    <div className="space-y-10">
      <PageHeader title="Compare side by side">
        Put two to four airlines, airports or routes next to each other. Every figure is summed from
        the pre-aggregated 2015 stats; airports are compared on their departures.
      </PageHeader>

      <Picker
        selection={selection}
        onChange={change}
        minFlights={selection.minFlights}
        onMinFlights={(minFlights) => change({ ...selection, minFlights })}
      />

      {missing > 0 ? (
        <EmptyBlock
          message={
            missing === 2
              ? `Choose two ${noun.many} to start a comparison.`
              : `Choose one more ${noun.one} to compare with ${selection.ids[0]}.`
          }
        />
      ) : (
        <QueryState
          query={comparison}
          label="the comparison"
          skeletonClass="h-[28rem]"
          hint={(error) =>
            error.code === 'UNKNOWN_ENTITY'
              ? `Remove the unknown ${noun.one} above and pick one from the list.`
              : undefined
          }
        >
          {(data) => <Results data={data} stale={comparison.isPlaceholderData} />}
        </QueryState>
      )}
    </div>
  );
}
