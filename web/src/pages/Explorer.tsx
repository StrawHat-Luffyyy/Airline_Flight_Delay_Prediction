import type { DelayRateRow, FlightItem, HeatmapResponse } from '@flight-delay/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useDelayRate, useFlights, useHeatmap, useSummary } from '../api/hooks';
import { Board, RateCell, type BoardColumn } from '../components/Board';
import { cellFill, divergingCells, markerColour, MIN_HEATMAP_FLIGHTS } from '../lib/heatmap';
import { ErrorBlock, QueryState } from '../components/QueryState';
import { Note, PageHeader, Section, Segmented, SelectField } from '../components/ui';
import {
  dayName,
  formatInteger,
  formatPercent,
  formatPoints,
  formatSignedMinutes,
  hourLabel,
} from '../lib/format';

type Entity = 'airline' | 'origin' | 'route';

const ENTITY_OPTIONS = [
  { value: 'airline', label: 'Airlines' },
  { value: 'origin', label: 'Airports' },
  { value: 'route', label: 'Routes' },
] as const;

const ENTITY_NOUN: Record<Entity, string> = {
  airline: 'Airline',
  origin: 'Airport (origin)',
  route: 'Route',
};

const MIN_FLIGHTS_OPTIONS = [100, 500, 1000, 5000] as const;
const LIMIT_OPTIONS = [10, 20, 50] as const;

function boardColumns(
  entity: Entity,
  maxRate: number,
  onViewFlights: (route: string) => void,
  selectedRoute: string | null,
): BoardColumn<DelayRateRow>[] {
  const columns: BoardColumn<DelayRateRow>[] = [
    {
      id: 'name',
      header: ENTITY_NOUN[entity],
      rowHeader: true,
      cell: (row) =>
        entity === 'route' ? (
          <span className="whitespace-nowrap">{row.label}</span>
        ) : (
          <span className="block max-w-[9.5rem] truncate font-sans sm:max-w-none" title={row.label}>
            {row.label}
          </span>
        ),
    },
    {
      id: 'flights',
      header: 'Flights',
      align: 'right',
      cell: (row) => formatInteger(row.flights),
      className: 'hidden sm:table-cell',
    },
    {
      id: 'rate',
      header: 'Delay rate',
      align: 'right',
      className: 'sm:min-w-44',
      cell: (row) => <RateCell value={row.delayRate} max={maxRate} />,
    },
    {
      id: 'arr',
      header: 'Avg arr delay',
      align: 'right',
      cell: (row) => formatSignedMinutes(row.avgArrDelay),
      className: 'hidden md:table-cell',
    },
  ];
  if (entity === 'airline') {
    columns.unshift({
      id: 'code',
      header: 'Code',
      cell: (row) => <span className="text-ink-2">{String(row.key)}</span>,
      className: 'w-10',
    });
  }
  if (entity === 'route') {
    columns.push({
      id: 'action',
      header: <span className="sr-only">Flights</span>,
      align: 'right',
      cell: (row) => {
        const route = String(row.key);
        return (
          <button
            type="button"
            onClick={() => onViewFlights(route)}
            aria-pressed={selectedRoute === route}
            aria-label={`View flights on ${route}`}
            className="whitespace-nowrap rounded-full border border-rule-strong px-3 py-1 font-sans text-[12px] text-ink hover:bg-wash aria-pressed:bg-ink aria-pressed:text-ground"
          >
            View flights
          </button>
        );
      },
    });
  }
  return columns;
}

function statusOf(flight: FlightItem): { text: string; className: string } {
  if (flight.cancelled) return { text: 'cancelled', className: 'text-cancelled' };
  if (flight.diverted) return { text: 'diverted', className: 'text-cancelled' };
  if (flight.isDelayed) return { text: 'delayed', className: 'text-delayed' };
  return { text: 'on time', className: 'text-ontime' };
}

const FLIGHT_COLUMNS: BoardColumn<FlightItem>[] = [
  {
    id: 'date',
    header: 'Date',
    rowHeader: true,
    className: 'whitespace-nowrap',
    cell: (f) => f.date,
  },
  {
    id: 'flight',
    header: 'Flight',
    className: 'whitespace-nowrap',
    cell: (f) => `${f.airline} ${f.flightNumber}`,
  },
  {
    id: 'dep',
    header: 'Sched dep',
    className: 'hidden sm:table-cell',
    cell: (f) => f.schedDep,
  },
  {
    id: 'depDelay',
    header: 'Dep delay',
    align: 'right',
    className: 'hidden sm:table-cell',
    cell: (f) => formatSignedMinutes(f.depDelay, 0),
  },
  {
    id: 'arrDelay',
    header: 'Arr delay',
    align: 'right',
    cell: (f) => formatSignedMinutes(f.arrDelay, 0),
  },
  {
    id: 'status',
    header: 'Status',
    className: 'whitespace-nowrap',
    cell: (f) => {
      const status = statusOf(f);
      return <span className={status.className}>{status.text}</span>;
    },
  },
];

function FlightsPanel({ route, onClose }: { route: string; onClose: () => void }) {
  const flights = useFlights({ route, limit: 20 });
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const heading = headingRef.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'nearest' });
  }, [route]);

  const items = flights.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="route-flights-title" className="border-t border-rule-strong pt-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="route-flights-title"
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-2xl font-normal outline-none"
          >
            Flights on {route}
          </h2>
          <Note>Raw flights from the database, oldest first, 20 at a time.</Note>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-rule-strong px-4 py-1.5 text-[13px] hover:bg-wash"
        >
          Close
        </button>
      </div>
      {flights.isError && items.length === 0 ? (
        <ErrorBlock
          error={flights.error}
          label="these flights"
          onRetry={() => void flights.refetch()}
        />
      ) : flights.isPending ? (
        <div role="status">
          <span className="sr-only">Loading flights</span>
          <div className="skeleton h-64 w-full" aria-hidden="true" />
        </div>
      ) : items.length === 0 ? (
        <div role="status" className="border-y border-rule py-6 text-sm text-ink-2">
          No flights recorded on this route.
        </div>
      ) : (
        <div className="space-y-4">
          <Board
            rows={items}
            getKey={(flight) => flight.id}
            columns={FLIGHT_COLUMNS}
            caption={`Flights on ${route}`}
            showRank={false}
            animate={false}
          />
          <div className="flex items-center gap-4">
            {flights.hasNextPage ? (
              <button
                type="button"
                onClick={() => void flights.fetchNextPage()}
                disabled={flights.isFetchingNextPage}
                className="rounded-full border border-rule-strong px-5 py-2 text-[13px] hover:bg-wash disabled:opacity-60"
              >
                {flights.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            ) : (
              <span className="text-[13px] text-ink-3">All flights on this route are shown.</span>
            )}
            <span className="num text-[12px] text-ink-3">{formatInteger(items.length)} shown</span>
          </div>
          {flights.isFetchNextPageError ? (
            <ErrorBlock
              error={flights.error}
              label="more flights"
              onRetry={() => void flights.fetchNextPage()}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function RankingSection() {
  const [entity, setEntity] = useState<Entity>('airline');
  const [order, setOrder] = useState<'worst' | 'best'>('worst');
  const [minFlights, setMinFlights] = useState<number>(500);
  const [limit, setLimit] = useState<number>(20);
  const [route, setRoute] = useState<string | null>(null);
  const ranking = useDelayRate({ by: entity, minFlights, limit, order });

  const changeEntity = (next: Entity) => {
    setEntity(next);
    if (next !== 'route') setRoute(null);
  };

  return (
    <div className="space-y-8">
      <Section
        title="Delay rate rankings"
        note="Groups with fewer flights than the minimum are left out, so tiny groups do not top the table."
        actions={
          <Segmented label="Rank" value={entity} onChange={changeEntity} options={ENTITY_OPTIONS} />
        }
      >
        <div className="mb-5 flex flex-wrap items-end gap-x-6 gap-y-4">
          <Segmented
            label="Order"
            value={order}
            onChange={setOrder}
            options={[
              { value: 'worst', label: 'Worst' },
              { value: 'best', label: 'Best' },
            ]}
          />
          <div className="w-40">
            <SelectField
              label="Minimum flights"
              value={minFlights}
              onChange={(event) => setMinFlights(Number(event.target.value))}
            >
              {MIN_FLIGHTS_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {formatInteger(value)}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="w-32">
            <SelectField
              label="Show"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMIT_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value} rows
                </option>
              ))}
            </SelectField>
          </div>
        </div>
        <QueryState
          query={ranking}
          label="the ranking"
          skeletonClass="h-96"
          isEmpty={(data) => data.rows.length === 0}
          emptyMessage={`No ${ENTITY_NOUN[entity].toLowerCase()} group has ${formatInteger(
            minFlights,
          )} flights. Lower the minimum.`}
        >
          {(data) => {
            const maxRate = Math.max(...data.rows.map((row) => row.delayRate ?? 0), 0);
            return (
              <div className="space-y-3">
                <Board
                  rows={data.rows}
                  getKey={(row) => String(row.key)}
                  columns={boardColumns(entity, maxRate, setRoute, route)}
                  caption={`${data.order === 'worst' ? 'Highest' : 'Lowest'} delay rate by ${ENTITY_NOUN[entity].toLowerCase()}`}
                  selectedKey={route ?? undefined}
                />
                {data.coverage ? <Note>{data.coverage.note}</Note> : null}
              </div>
            );
          }}
        </QueryState>
      </Section>
      {route ? <FlightsPanel route={route} onClose={() => setRoute(null)} /> : null}
    </div>
  );
}

// ---------- Heatmap ----------

const DOWS = [1, 2, 3, 4, 5, 6, 7] as const;
const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

function Heatmap({ data, overall }: { data: HeatmapResponse; overall: number }) {
  const [readout, setReadout] = useState<string>('Hover or tap a cell to read it.');

  const { cells, scale } = useMemo(
    () => ({
      cells: new Map(data.cells.map((cell) => [`${cell.dow}-${cell.hour}`, cell])),
      scale: divergingCells(data.cells, overall),
    }),
    [data, overall],
  );

  const describe = (dow: number, hour: number) => {
    const cell = cells.get(`${dow}-${hour}`);
    const when = `${dayName(dow)} ${hourLabel(hour)}`;
    if (!cell || cell.delayRate === null) return `${when} · no delay rate (no completed flights)`;
    const rate = `${formatPercent(cell.delayRate)} of ${formatInteger(cell.completed)} flights delayed`;
    const kind = scale.cells.get(`${dow}-${hour}`)?.kind;
    if (kind === 'low') return `${when} · ${rate} (fewer than ${MIN_HEATMAP_FLIGHTS} flights)`;
    const vs = formatPoints(cell.delayRate - overall);
    return `${when} · ${rate} · ${vs} against the overall ${formatPercent(overall)}`;
  };

  const cellNode = (dow: number, hour: number, className: string) => {
    const scaled = scale.cells.get(`${dow}-${hour}`) ?? { kind: 'none', intensity: 0, marker: '' };
    const text = describe(dow, hour);
    const hatched = scaled.kind === 'none' || scaled.kind === 'low';
    return (
      <span
        key={`${dow}-${hour}`}
        title={text}
        onMouseEnter={() => setReadout(text)}
        onClick={() => setReadout(text)}
        className={`flex items-center justify-center rounded-[2px] border border-rule text-[9px] leading-none ${className} ${hatched ? 'hatch' : ''}`}
        style={{ background: cellFill(scaled), color: markerColour(scaled) }}
      >
        {scaled.marker}
      </span>
    );
  };

  return (
    <div className="space-y-3">
      {/* Visual grids are hidden from assistive tech; the table below carries every value. */}
      <div aria-hidden="true">
        {/* sm and up: 7 weekday rows by 24 hour columns */}
        <div
          className="hidden gap-[3px] sm:grid"
          style={{ gridTemplateColumns: '40px repeat(24, minmax(0, 1fr))' }}
        >
          <span />
          {HOURS.map((hour) => (
            <span key={hour} className="num text-center text-[10px] leading-none text-ink-3">
              {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
            </span>
          ))}
          {DOWS.map((dow) => (
            <HeatmapDayRow key={dow} dow={dow}>
              {HOURS.map((hour) => cellNode(dow, hour, 'h-7'))}
            </HeatmapDayRow>
          ))}
        </div>
        {/* below sm: transposed, 24 hour rows by 7 weekday columns */}
        <div
          className="grid gap-[2px] sm:hidden"
          style={{ gridTemplateColumns: '40px repeat(7, minmax(0, 1fr))' }}
        >
          <span />
          {DOWS.map((dow) => (
            <span key={dow} className="pb-1 text-center text-[11px] text-ink-2">
              {dayName(dow)}
            </span>
          ))}
          {HOURS.map((hour) => (
            <HeatmapHourRow key={hour} hour={hour}>
              {DOWS.map((dow) => cellNode(dow, hour, 'h-[18px]'))}
            </HeatmapHourRow>
          ))}
        </div>
      </div>

      {/* sr-only on the wrapper: a table ignores the 1px width and would widen the page. */}
      <div className="sr-only">
        <table>
          <caption>
            Delay rate by day of week and scheduled departure hour, against the overall{' '}
            {formatPercent(overall)}
          </caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Hour</th>
              <th scope="col">Delay rate</th>
              <th scope="col">Against overall</th>
              <th scope="col">Completed flights</th>
            </tr>
          </thead>
          <tbody>
            {DOWS.flatMap((dow) =>
              HOURS.map((hour) => {
                const cell = cells.get(`${dow}-${hour}`);
                return (
                  <tr key={`${dow}-${hour}`}>
                    <th scope="row">{dayName(dow, false)}</th>
                    <td>{hourLabel(hour)}</td>
                    <td>{formatPercent(cell?.delayRate ?? null)}</td>
                    <td>
                      {cell?.delayRate == null ? '—' : formatPoints(cell.delayRate - overall)}
                    </td>
                    <td>{formatInteger(cell?.completed ?? 0)}</td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>

      <p className="min-h-5 text-[12px] text-ink" aria-hidden="true">
        {readout}
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-ink-2">
        <span className="flex items-center gap-2">
          <span className="num text-ink">▼ {formatPoints(-scale.clamp)}</span>
          <span
            className="h-2.5 w-40 rounded-sm"
            style={{
              background:
                'linear-gradient(90deg, color-mix(in srgb, var(--positive) 85%, var(--surface)), var(--surface), color-mix(in srgb, var(--negative) 85%, var(--surface)))',
            }}
            aria-hidden="true"
          />
          <span className="num text-ink">▲ {formatPoints(scale.clamp)}</span>
          <span>
            against the overall delay rate of{' '}
            <span className="num text-ink">{formatPercent(overall)}</span> (colour saturates at the
            95th-percentile gap)
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="hatch h-2.5 w-6 rounded-sm border border-rule" aria-hidden="true" />
          Fewer than {MIN_HEATMAP_FLIGHTS} flights, or no rate
        </span>
      </div>
    </div>
  );
}

function HeatmapDayRow({ dow, children }: { dow: number; children: ReactNode }) {
  return (
    <>
      <span className="flex items-center text-[12px] text-ink-2">{dayName(dow)}</span>
      {children}
    </>
  );
}

function HeatmapHourRow({ hour, children }: { hour: number; children: ReactNode }) {
  return (
    <>
      <span className="num flex items-center text-[10px] leading-none text-ink-3">
        {hourLabel(hour)}
      </span>
      {children}
    </>
  );
}

export default function Explorer() {
  const heatmap = useHeatmap();
  const summary = useSummary();
  return (
    <div className="space-y-10">
      <PageHeader title="Where and when delays concentrate">
        Rank airlines, airports and routes by delay rate, open the raw flights behind a route, and
        see how the delay rate moves across the week.
      </PageHeader>

      <RankingSection />

      <Section
        title="Delay rate by hour and weekday"
        note="Scheduled departure hour against day of week, all of 2015."
      >
        <QueryState
          query={heatmap}
          label="the heatmap"
          skeletonClass="h-64"
          isEmpty={(data) => data.cells.length === 0}
          emptyMessage="No heatmap data yet. Run the stats build to populate it."
        >
          {(data) => (
            <div className="space-y-3">
              <QueryState query={summary} label="the overall delay rate" skeletonClass="h-64">
                {(totals) =>
                  totals.delayRate === null ? (
                    <Note>No overall delay rate yet, so the heatmap has no centre.</Note>
                  ) : (
                    <Heatmap data={data} overall={totals.delayRate} />
                  )
                }
              </QueryState>
              {data.coverage ? <Note>{data.coverage.note}</Note> : null}
            </div>
          )}
        </QueryState>
      </Section>
    </div>
  );
}
