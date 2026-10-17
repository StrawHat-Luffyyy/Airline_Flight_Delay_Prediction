/**
 * The DOM around the globe: a tooltip that follows the cursor over an arc or an airport, the
 * rotate/zoom controls, and the details panel for a selected route. All of it reads the globe
 * store, so a board row, an arc and this panel always agree on what is lit and selected.
 */
import { ArrowRight, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { formatInteger, formatPercent, formatSignedMinutes } from '../../lib/format';
import type { AirportPoint } from '../globe/Airports';
import { greatCircleMiles, parseRouteKey, type RouteArc } from '../globe/geo';
import { resetView, setSelected, useInteraction, zoomBy } from '../globe/store';

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

/** Follows the cursor (imperatively, no re-render per move) while the globe has a hover. */
export function GlobeTooltip({
  arcs,
  airports,
}: {
  arcs: readonly RouteArc[];
  airports: ReadonlyMap<string, AirportPoint>;
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
    if (arc) {
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
    if (airport) {
      body = (
        <>
          <p className="font-mono text-[13px] text-ink">{airport.code}</p>
          <p className="mt-0.5 max-w-[30ch] text-xs text-ink-2">{airport.name}</p>
          <p className="text-[11px] text-ink-3">{place(airport)}</p>
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
        className={`rounded-lg border border-rule-strong bg-[#0b0b0b] px-3 py-2 transition-opacity duration-150 ${body ? 'opacity-100' : 'opacity-0'}`}
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
      className={`fixed inset-x-3 bottom-3 z-30 rounded-2xl border border-rule-strong bg-[#0b0b0b]/95 p-5 transition-[opacity,translate] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] sm:inset-x-auto sm:bottom-8 sm:right-8 sm:w-[22rem] ${arc ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}
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
