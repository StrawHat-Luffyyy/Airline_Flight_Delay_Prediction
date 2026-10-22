/**
 * The DOM around the globe: a tooltip that follows the cursor over an arc or an airport, the
 * rotate/zoom controls, and the details panel for a selected route. All of it reads the globe
 * store, so a board row, an arc and this panel always agree on what is lit and selected.
 */
import type { RoutesResponse } from '@flight-delay/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { ArrowRight, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { formatInteger, formatPercent, formatPoints, formatSignedMinutes } from '../../lib/format';
import { QueryState } from '../QueryState';
import type { AirportPoint } from '../globe/Airports';
import { greatCircleMiles, parseRouteKey, type RouteArc } from '../globe/geo';
import { AMBER_HEX, BLUE_HEX, NEUTRAL_HEX } from '../globe/palette';
import {
  clearHover,
  resetView,
  setHover,
  setSelected,
  setSelectedAirport,
  useInteraction,
  zoomBy,
} from '../globe/store';
import { AIRPORT_MIN_FLIGHTS, NETWORK_SIZE, type AirportStats } from './useAirportStats';

export function RouteLabel({ id }: { id: string }) {
  const route = parseRouteKey(id);
  if (!route) return <>{id}</>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {route.origin}
      <ArrowRight aria-hidden="true" size={11} strokeWidth={1.5} className="text-ink-3" />
      <span className="sr-only">to</span>
      {route.dest}
    </span>
  );
}

const place = (airport: AirportPoint | undefined): string =>
  airport ? [airport.city, airport.state].filter(Boolean).join(', ') || airport.name : '';

/** Amber above the national rate, blue below (DESIGN.md Paired Encoding Rule). */
function rateTone(rate: number | null, national: number | null): string {
  if (rate === null || national === null) return 'text-ink';
  return rate > national ? 'text-delayed' : 'text-ontime';
}

/** Follows the cursor (imperatively, no re-render per move) while the globe has a hover. */
export function GlobeTooltip({
  arcs,
  airports,
  airportStats,
}: {
  arcs: readonly RouteArc[];
  airports: ReadonlyMap<string, AirportPoint>;
  airportStats: AirportStats;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { hover, hoverSource } = useInteraction();
  const active = hover !== null && hoverSource === 'globe';

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const follow = (event: PointerEvent) => {
      const flip = event.clientX > window.innerWidth - 280;
      node.style.transform = `translate(${event.clientX + (flip ? -16 : 16)}px, ${event.clientY + 18}px) translateX(${flip ? '-100%' : '0'})`;
    };
    window.addEventListener('pointermove', follow, { passive: true });
    return () => window.removeEventListener('pointermove', follow);
  }, []);

  let body = null;
  if (active && hover.kind === 'route') {
    const arc = arcs.find((candidate) => candidate.id === hover.id);
    if (arc?.kind === 'network') {
      body = (
        <>
          <p className="font-mono text-[13px] text-ink">
            <RouteLabel id={`${arc.origin}-${arc.dest}`} />
          </p>
          <p className="mt-0.5 text-xs text-ink-2">
            <span className="font-mono text-ink">{formatInteger(arc.flights)}</span> flights in 2015
          </p>
          <p className="mt-1 text-[11px] text-ink-3">{place(airports.get(arc.dest))}</p>
        </>
      );
    } else if (arc) {
      body = (
        <>
          <p className="font-mono text-[13px] text-ink">
            <RouteLabel id={arc.id} />
          </p>
          <p className="mt-0.5 text-xs text-ink-2">
            <span className={arc.kind === 'late' ? 'text-delayed' : 'text-ontime'}>
              {formatPercent(arc.delayRate)}
            </span>{' '}
            arrived 15+ min late
          </p>
          <p className="mt-1 text-[11px] text-ink-3">Click for details</p>
        </>
      );
    }
  } else if (active && hover.kind === 'airport') {
    const airport = airports.get(hover.code);
    const stat = airportStats.stats.get(hover.code);
    if (airport) {
      body = (
        <>
          <p className="font-mono text-[13px] text-ink">{airport.code}</p>
          <p className="mt-0.5 max-w-[30ch] text-xs text-ink-2">{airport.name}</p>
          <p className="text-[11px] text-ink-3">{place(airport)}</p>
          {stat ? (
            <>
              <p className="mt-1.5 text-xs text-ink-2">
                <span className="font-mono text-ink">{formatInteger(stat.flights)}</span>{' '}
                departures,{' '}
                <span className={`font-mono ${rateTone(stat.delayRate, airportStats.national)}`}>
                  {formatPercent(stat.delayRate)}
                </span>{' '}
                late
              </p>
              <p className="mt-1 text-[11px] text-ink-3">Click for its busiest routes</p>
            </>
          ) : null}
        </>
      );
    }
  }

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-30 will-change-transform"
    >
      <div
        className={`rounded-lg border border-rule-strong bg-surface px-3 py-2 transition-opacity duration-150 ${body ? 'opacity-100' : 'opacity-0'}`}
      >
        {body}
      </div>
    </div>
  );
}

/** Zoom and reset, plus the gesture hint; desktop only (touch keeps scrolling the page). */
export function GlobeControls() {
  const button =
    'grid size-8 place-items-center text-ink-2 transition-colors duration-150 hover:bg-wash hover:text-ink';
  return (
    <div className="fixed right-6 top-6 z-20 hidden items-center gap-3 lg:flex">
      <p className="text-[11px] text-ink-3">Drag to rotate. Ctrl + scroll to zoom.</p>
      <div
        role="group"
        aria-label="Globe view"
        className="flex overflow-hidden rounded-full border border-rule-strong bg-ground/60"
      >
        <button type="button" className={button} aria-label="Zoom in" onClick={() => zoomBy(1.3)}>
          <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`${button} border-x border-rule`}
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / 1.3)}
        >
          <Minus size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button type="button" className={button} aria-label="Reset view" onClick={resetView}>
          <RotateCcw size={13} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** Details of the selected route: real figures only, from the ranking and airports.csv. */
export function RouteDetails({
  arcs,
  airports,
}: {
  arcs: readonly RouteArc[];
  airports: ReadonlyMap<string, AirportPoint>;
}) {
  const { selected } = useInteraction();
  const arc = arcs.find((candidate) => candidate.id === selected);

  useEffect(() => {
    if (!arc) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [arc]);

  const origin = arc ? airports.get(arc.origin) : undefined;
  const dest = arc ? airports.get(arc.dest) : undefined;
  const rank = arc ? arcs.filter((other) => other.kind === arc.kind).indexOf(arc) + 1 : 0;

  return (
    <section
      aria-label="Selected route"
      aria-live="polite"
      className={`fixed inset-x-3 bottom-3 z-30 rounded-2xl border border-rule-strong bg-surface/95 p-5 transition-[opacity,translate] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] sm:inset-x-auto sm:bottom-8 sm:right-8 sm:w-[22rem] ${arc ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}
    >
      {arc ? (
        <>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs text-ink-3">
                {arc.kind === 'late' ? 'Most often late' : 'Most punctual'}, number {rank}
              </p>
              <h3 className="mt-1 font-mono text-base text-ink">
                <RouteLabel id={arc.id} />
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              aria-label="Close route details"
              className="-mr-1.5 -mt-1 grid size-8 place-items-center rounded-full text-ink-2 hover:bg-wash hover:text-ink"
            >
              <X size={15} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
          {origin && dest ? (
            <p className="mt-1 text-xs leading-relaxed text-ink-2">
              {place(origin)} to {place(dest)}
            </p>
          ) : null}
          <p
            className={`display-num mt-4 text-[clamp(1.75rem,3vw,2.5rem)] leading-none ${arc.kind === 'late' ? 'text-delayed' : 'text-ontime'}`}
          >
            {formatPercent(arc.delayRate)}
          </p>
          <p className="mt-1.5 text-xs text-ink-2">
            of {formatInteger(arc.completed)} completed flights arrived 15+ min late
          </p>
          <dl className="mt-4 grid grid-cols-3 border-y border-rule">
            <div className="py-2.5">
              <dt className="text-[11px] text-ink-3">Avg arrival</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-ink">
                {formatSignedMinutes(arc.avgArrDelay)}
              </dd>
            </div>
            <div className="border-l border-rule py-2.5 pl-3">
              <dt className="text-[11px] text-ink-3">Scheduled</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-ink">
                {formatInteger(arc.flights)}
              </dd>
            </div>
            <div className="border-l border-rule py-2.5 pl-3">
              <dt className="text-[11px] text-ink-3">Great circle</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-ink">
                {origin && dest ? `${formatInteger(greatCircleMiles(origin, dest))} mi` : 'n/a'}
              </dd>
            </div>
          </dl>
          <Link
            to={`/predict?origin=${arc.origin}&dest=${arc.dest}`}
            className="group mt-4 inline-flex items-center gap-2 rounded-full border border-rule-strong py-2 pl-4 pr-3.5 text-sm text-ink transition-colors duration-200 hover:bg-wash"
          >
            Score a flight
            <ArrowRight
              aria-hidden="true"
              size={14}
              strokeWidth={1.5}
              className="transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1"
            />
          </Link>
        </>
      ) : null}
    </section>
  );
}

/** The blue-ink-amber ramp of the beacons, as a CSS gradient from the same colours. */
const RAMP = `linear-gradient(90deg, ${BLUE_HEX}, ${NEUTRAL_HEX}, ${AMBER_HEX})`;
/** Beacons are fully blue or amber this far from the national rate (geo.delayTone's spread). */
const TONE_SPREAD = 0.08;

/**
 * What the beacons encode, with the real thresholds: column height is departures, colour is the
 * delay rate against the national rate. Only shown once the figures it names have loaded.
 */
export function GlobeLegend({
  airportStats,
  airports,
  interactive,
  reduced,
}: {
  airportStats: AirportStats;
  /** Airports with coordinates: only these get a column, so only these are counted. */
  airports: ReadonlyMap<string, AirportPoint>;
  interactive: boolean;
  /** Under reduced motion nothing moves along the routes, so the key does not mention it. */
  reduced: boolean;
}) {
  const { stats, national, complete, loaded } = airportStats;
  const { selected, selectedAirport } = useInteraction();
  if (!loaded || national === null) return null;
  // The details panel takes this corner while something is selected.
  const covered = selected !== null || selectedAirport !== null;
  const drawn = [...stats.keys()].filter((code) => airports.has(code)).length;
  return (
    <aside
      aria-label="Map key"
      aria-hidden={covered}
      className={`pointer-events-none fixed right-4 top-4 z-20 w-[13.5rem] text-[11px] leading-snug text-ink-3 transition-opacity duration-300 lg:right-6 lg:top-[4.25rem] lg:w-[15rem] ${covered ? 'opacity-0' : 'opacity-100'}`}
    >
      <p className="flex items-end gap-2">
        <span aria-hidden="true" className="flex h-4 shrink-0 items-end gap-[3px]">
          <span className="h-1.5 w-[3px] rounded-[1px] bg-ink-3" />
          <span className="h-2.5 w-[3px] rounded-[1px] bg-ink-2" />
          <span className="h-4 w-[3px] rounded-[1px] bg-ink" />
        </span>
        <span>
          Column height: 2015 departures, {formatInteger(drawn)} airports with{' '}
          {formatInteger(AIRPORT_MIN_FLIGHTS)}+{complete ? '' : ' (partial list)'}
        </span>
      </p>
      <div className="mt-2.5">
        <p>Colour: share arriving 15+ min late</p>
        <div
          aria-hidden="true"
          className="mt-1.5 h-1.5 rounded-full"
          style={{ background: RAMP }}
        />
        <p className="mt-1 flex justify-between font-mono text-[10.5px]">
          <span className="text-ontime">{formatPercent(Math.max(0, national - TONE_SPREAD))}</span>
          <span className="text-ink-2">{formatPercent(national)} national</span>
          <span className="text-delayed">{formatPercent(national + TONE_SPREAD)}</span>
        </p>
      </div>
      <p className="mt-2.5 hidden lg:block">
        {reduced ? '' : 'Moving lights: one per 1,000 flights on a route. '}
        {interactive ? 'Click a column for its busiest routes.' : ''}
      </p>
    </aside>
  );
}

type NetworkQuery = Pick<
  UseQueryResult<RoutesResponse, Error>,
  'data' | 'isPending' | 'isError' | 'error' | 'refetch'
>;

/**
 * The selected airport: its real figures from the origin ranking, and its busiest destinations
 * from /api/routes. Pointing at a destination lights its arc; each one opens Predict prefilled.
 */
export function AirportDetails({
  airports,
  airportStats,
  network,
}: {
  airports: ReadonlyMap<string, AirportPoint>;
  airportStats: AirportStats;
  network: NetworkQuery;
}) {
  const { selectedAirport } = useInteraction();
  const airport = selectedAirport ? airports.get(selectedAirport) : undefined;
  const stat = selectedAirport ? airportStats.stats.get(selectedAirport) : undefined;
  const open = airport !== undefined && stat !== undefined;
  const national = airportStats.national;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedAirport(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <section
      aria-label="Selected airport"
      aria-live="polite"
      className={`fixed inset-x-3 bottom-3 z-30 max-h-[62dvh] overflow-y-auto rounded-2xl border border-rule-strong bg-surface/95 p-5 transition-[opacity,translate] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] sm:inset-x-auto sm:bottom-8 sm:right-8 sm:max-h-[calc(100dvh-8rem)] sm:w-[22rem] ${open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}
    >
      {open ? (
        <>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs text-ink-3">{place(airport)}</p>
              <h3 className="mt-1 text-base leading-snug text-ink">
                <span className="font-mono">{airport.code}</span>
                <span className="ml-2 text-sm text-ink-2">{airport.name}</span>
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setSelectedAirport(null)}
              aria-label="Close airport details"
              className="-mr-1.5 -mt-1 grid size-8 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-wash hover:text-ink"
            >
              <X size={15} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
          <p
            className={`display-num mt-4 text-[clamp(1.75rem,3vw,2.5rem)] leading-none ${rateTone(stat.delayRate, national)}`}
          >
            {formatPercent(stat.delayRate)}
          </p>
          <p className="mt-1.5 text-xs text-ink-2">
            of {formatInteger(stat.completed)} completed departures arrived 15+ min late
          </p>
          <dl className="mt-4 grid grid-cols-3 border-y border-rule">
            <div className="py-2.5">
              <dt className="text-[11px] text-ink-3">Departures</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-ink">
                {formatInteger(stat.flights)}
              </dd>
            </div>
            <div className="border-l border-rule py-2.5 pl-3">
              <dt className="text-[11px] text-ink-3">Avg arrival</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-ink">
                {formatSignedMinutes(stat.avgArrDelay)}
              </dd>
            </div>
            <div className="border-l border-rule py-2.5 pl-3">
              <dt className="text-[11px] text-ink-3">vs national</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-ink">
                {stat.delayRate !== null && national !== null
                  ? formatPoints(stat.delayRate - national)
                  : 'n/a'}
              </dd>
            </div>
          </dl>
          <div className="mt-4">
            <QueryState query={network} label="its routes" skeletonClass="h-40">
              {(data) => <DestinationBoard origin={airport.code} data={data} airports={airports} />}
            </QueryState>
          </div>
          {airportStats.coverage ? (
            <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
              {airportStats.coverage.note}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** The busiest destinations as a small board; a row lights its arc and opens Predict prefilled. */
function DestinationBoard({
  origin,
  data,
  airports,
}: {
  origin: string;
  data: RoutesResponse;
  airports: ReadonlyMap<string, AirportPoint>;
}) {
  const rows = data.destinations.slice(0, NETWORK_SIZE);
  const busiest = Math.max(1, ...rows.map((row) => row.flights));
  return (
    <table className="w-full border-collapse font-mono text-[13px]">
      <caption className="pb-2 text-left font-sans text-xs text-ink-2">
        Busiest routes from {origin}, of {formatInteger(data.destinations.length)} flown in 2015
      </caption>
      <thead>
        <tr className="border-b border-rule-strong text-left font-sans text-[11px] tracking-[0.025em] text-ink-3">
          <th scope="col" className="py-1.5 font-normal">
            To
          </th>
          <th scope="col" className="py-1.5 text-right font-normal">
            Flights
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const route = { kind: 'route', id: `net:${origin}-${row.dest}` } as const;
          const city = airports.get(row.dest)?.city;
          return (
            <tr
              key={row.dest}
              className="h-8 border-b border-rule transition-colors duration-150 hover:bg-wash"
            >
              <th scope="row" className="p-0 text-left font-normal">
                <Link
                  to={`/predict?origin=${origin}&dest=${row.dest}`}
                  aria-label={`Score a flight from ${origin} to ${row.dest}`}
                  onMouseEnter={() => setHover(route, 'panel')}
                  onMouseLeave={() => clearHover(route)}
                  onFocus={() => setHover(route, 'panel')}
                  onBlur={() => clearHover(route)}
                  className="flex h-8 min-w-0 items-center gap-2 text-ink"
                >
                  {row.dest}
                  {city ? (
                    <span className="truncate font-sans text-xs text-ink-3">{city}</span>
                  ) : null}
                </Link>
              </th>
              <td className="text-right">
                <span className="inline-flex items-center justify-end gap-2">
                  <span
                    aria-hidden="true"
                    className="hidden h-1.5 w-12 rounded-full bg-wash sm:block"
                  >
                    <span
                      className="block h-full rounded-full bg-ink-2"
                      style={{ width: `${(row.flights / busiest) * 100}%` }}
                    />
                  </span>
                  <span className="tabular-nums text-ink-2">{formatInteger(row.flights)}</span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
