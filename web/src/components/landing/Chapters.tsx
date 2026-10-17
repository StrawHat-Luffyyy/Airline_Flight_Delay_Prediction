import type { DelayRateRow } from '@flight-delay/shared';
import { ArrowRight } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { Link } from 'react-router';
import { useMeta, useModelMetrics } from '../../api/hooks';
import { formatDate, formatInteger, formatPercent } from '../../lib/format';
import { QueryState } from '../QueryState';
import { parseRouteKey, type RouteArc } from '../globe/geo';
import { setFocusRoute, useFocusRoute } from '../globe/store';
import { ROUTE_MIN_FLIGHTS, type RouteRankings } from './useRouteRankings';

/** Rows per board in the routes chapter; the globe draws more. */
const BOARD_ROWS = 5;

const TITLE =
  'font-display text-[clamp(2.25rem,5vw,3.5rem)] font-normal leading-[1.02] text-balance';
const BODY = 'max-w-[52ch] text-[15px] leading-relaxed text-ink-2';

/**
 * One full-viewport chapter. The globe owns the right half on desktop and the top on phones, so
 * the copy sits left (desktop) or low (phones). Blocks marked data-reveal rise in on scroll.
 */
function Chapter({
  id,
  title,
  sectionRef,
  children,
}: {
  id: string;
  title: ReactNode;
  sectionRef: Ref<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <section
      ref={sectionRef}
      aria-labelledby={id}
      className="pointer-events-none relative mx-auto flex min-h-[100dvh] w-full max-w-[1440px] items-end px-5 pb-20 pt-[48dvh] md:items-center md:px-10 md:py-28"
    >
      <div className="landing-copy pointer-events-auto w-full max-w-[34rem] space-y-7">
        <h2 id={id} data-reveal className={TITLE}>
          {title}
        </h2>
        {children}
      </div>
    </section>
  );
}

function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="group inline-flex items-center gap-2 rounded-full border border-rule-strong py-2.5 pl-5 pr-4 text-sm text-ink transition-colors duration-200 hover:bg-wash"
    >
      {children}
      <ArrowRight
        aria-hidden="true"
        size={14}
        strokeWidth={1.5}
        className="transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1"
      />
    </Link>
  );
}

// ---------- Volume ----------

export function VolumeChapter({ sectionRef }: { sectionRef: Ref<HTMLElement> }) {
  const meta = useMeta();
  return (
    <Chapter id="chapter-volume" title="Every domestic flight of 2015." sectionRef={sectionRef}>
      <p data-reveal className={BODY}>
        The US DOT on-time file is streamed into MongoDB in batches of 10,000, then pre-aggregated
        into stats collections, so every page answers from a summary instead of a scan.
      </p>
      <div data-reveal>
        <QueryState query={meta} label="the dataset summary" skeletonClass="h-24">
          {(data) => (
            <dl className="grid grid-cols-3 border-y border-rule-strong">
              {[
                { label: 'Flights', value: formatInteger(data.flights) },
                { label: 'Airports', value: formatInteger(data.airports.length) },
                { label: 'Airlines', value: formatInteger(data.airlines.length) },
              ].map((item, index) => (
                <div
                  key={item.label}
                  className={`py-3 ${index > 0 ? 'border-l border-rule pl-3 sm:pl-4' : ''}`}
                >
                  <dt className="text-xs text-ink-2">{item.label}</dt>
                  <dd className="display-num mt-1 text-[clamp(1.5rem,3.4vw,2.25rem)] leading-none">
                    {item.value}
                  </dd>
                </div>
              ))}
              {data.dateRange ? (
                <div className="col-span-3 border-t border-rule py-2.5 font-mono text-xs text-ink-3">
                  {formatDate(data.dateRange.from)} to {formatDate(data.dateRange.to)}
                </div>
              ) : null}
            </dl>
          )}
        </QueryState>
      </div>
    </Chapter>
  );
}

// ---------- Routes ----------

function RouteLabel({ id }: { id: string }) {
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

/** A five-row departure board; pointing at a row lights its arc on the globe. */
function RouteBoard({
  caption,
  rows,
  tone,
  focus,
}: {
  caption: string;
  rows: readonly DelayRateRow[];
  tone: 'late' | 'punctual';
  focus: string | null;
}) {
  return (
    <table className="w-full border-collapse font-mono text-[13px]">
      <caption className="pb-2 text-left font-sans text-xs text-ink-2">
        <span
          aria-hidden="true"
          className={`mr-2 inline-block size-2 rounded-[2px] align-middle ${tone === 'late' ? 'bg-delayed' : 'bg-ontime'}`}
        />
        {caption}
      </caption>
      <thead>
        <tr className="border-b border-rule-strong text-left font-sans text-[11px] tracking-[0.025em] text-ink-3">
          <th scope="col" className="py-1.5 font-normal">
            Route
          </th>
          <th scope="col" className="py-1.5 text-right font-normal">
            Late
          </th>
          <th scope="col" className="py-1.5 text-right font-normal">
            Flights
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const id = String(row.key);
          const active = focus === id;
          return (
            <tr
              key={id}
              className={`h-9 border-b border-rule transition-colors duration-200 ${active ? 'bg-wash' : ''}`}
            >
              <th scope="row" className="p-0 text-left font-normal text-ink">
                <button
                  type="button"
                  onMouseEnter={() => setFocusRoute(id, 'board')}
                  onMouseLeave={() => setFocusRoute(null)}
                  onFocus={() => setFocusRoute(id, 'board')}
                  onBlur={() => setFocusRoute(null)}
                  onClick={() => setFocusRoute(active ? null : id, 'board')}
                  aria-pressed={active}
                  className="flex h-9 w-full items-center text-left"
                >
                  <RouteLabel id={id} />
                </button>
              </th>
              <td
                className={`text-right tabular-nums ${tone === 'late' ? 'text-delayed' : 'text-ontime'}`}
              >
                {formatPercent(row.delayRate)}
              </td>
              <td className="text-right tabular-nums text-ink-2">{formatInteger(row.flights)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function RoutesChapter({
  sectionRef,
  rankings,
}: {
  sectionRef: Ref<HTMLElement>;
  rankings: RouteRankings;
}) {
  const focus = useFocusRoute();
  return (
    <Chapter
      id="chapter-routes"
      title="Some routes run late. Some almost never do."
      sectionRef={sectionRef}
    >
      <p data-reveal className={BODY}>
        Share of completed flights arriving 15+ minutes late, among routes with at least{' '}
        {formatInteger(ROUTE_MIN_FLIGHTS)} flights in 2015. Point at a route to find it on the
        globe.
      </p>
      <div data-reveal className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
        <QueryState query={rankings.late} label="the most delay-prone routes" skeletonClass="h-52">
          {(data) => (
            <RouteBoard
              caption="Most often late"
              rows={data.rows.slice(0, BOARD_ROWS)}
              tone="late"
              focus={focus}
            />
          )}
        </QueryState>
        <QueryState query={rankings.punctual} label="the most punctual routes" skeletonClass="h-52">
          {(data) => (
            <RouteBoard
              caption="Most punctual"
              rows={data.rows.slice(0, BOARD_ROWS)}
              tone="punctual"
              focus={focus}
            />
          )}
        </QueryState>
      </div>
      {rankings.late.data?.coverage ? (
        <p data-reveal className="max-w-[60ch] text-xs leading-relaxed text-ink-3">
          {rankings.late.data.coverage.note}
        </p>
      ) : null}
    </Chapter>
  );
}

/** The focused route's real figures, pinned beside the globe (desktop). */
export function RouteReadout({ arcs }: { arcs: readonly RouteArc[] }) {
  const focus = useFocusRoute();
  const arc = arcs.find((candidate) => candidate.id === focus);
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed bottom-8 right-10 z-20 hidden w-64 border-t border-rule-strong pt-3 transition-[opacity,translate] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] lg:block ${arc ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}
    >
      {arc ? (
        <>
          <p className="font-mono text-sm text-ink">
            <RouteLabel id={arc.id} />
          </p>
          <p
            className={`display-num mt-1 text-[clamp(1.75rem,3vw,2.5rem)] leading-none ${arc.kind === 'late' ? 'text-delayed' : 'text-ontime'}`}
          >
            {formatPercent(arc.delayRate)}
          </p>
          <p className="mt-1.5 text-xs text-ink-2">
            of {formatInteger(arc.completed)} completed flights arrived 15+ min late
          </p>
          <p className="mt-1 font-mono text-[11px] text-ink-3">
            {formatInteger(arc.flights)} scheduled in 2015
          </p>
        </>
      ) : null}
    </div>
  );
}

// ---------- Predict ----------

export function PredictChapter({ sectionRef }: { sectionRef: Ref<HTMLElement> }) {
  const metrics = useModelMetrics();
  const threshold = metrics.data?.threshold.value;
  return (
    <Chapter
      id="chapter-predict"
      title="Score a flight before it leaves the gate."
      sectionRef={sectionRef}
    >
      <p data-reveal className={BODY}>
        Pick a date, airline, origin, destination and departure hour. The model returns the
        probability that the flight arrives 15+ minutes late
        {threshold === undefined
          ? '.'
          : `, and calls it late above a threshold of ${formatPercent(threshold)} tuned on held-out data.`}
      </p>
      <ul data-reveal className="flex flex-wrap gap-2" aria-label="What the model is told">
        {['Date', 'Airline', 'Origin', 'Destination', 'Departure hour'].map((input) => (
          <li
            key={input}
            className="rounded-full border border-rule-strong px-3 py-1 text-xs text-ink-2"
          >
            {input}
          </li>
        ))}
      </ul>
      <div data-reveal>
        <TextLink to="/predict">Score a flight</TextLink>
      </div>
    </Chapter>
  );
}

// ---------- Model ----------

export function ModelChapter({ sectionRef }: { sectionRef: Ref<HTMLElement> }) {
  const metrics = useModelMetrics();
  return (
    <Chapter
      id="chapter-model"
      title="An honest model, not a flattering one."
      sectionRef={sectionRef}
    >
      <p data-reveal className={BODY}>
        It learns from January to September and is scored on October to December, using only what is
        known before departure. Weather on the day and knock-on delays are invisible to it, which
        caps how good it can be.
      </p>
      <div data-reveal>
        <QueryState
          query={metrics}
          label="the model metrics"
          skeletonClass="h-24"
          hint={() => 'Register a model with npm run ml:register.'}
        >
          {(data) => {
            const rows = [
              { label: 'Baseline', value: data.models.baseline.test.auc, served: false },
              {
                label: 'Logistic regression',
                value: data.models.logisticRegression.test.auc,
                served: data.algorithm === 'logistic_regression',
              },
              {
                label: 'LightGBM',
                value: data.models.lightgbm.test.auc,
                served: data.algorithm === 'lightgbm',
              },
            ];
            return (
              <figure>
                <dl className="grid grid-cols-3 border-y border-rule-strong">
                  {rows.map((row, index) => (
                    <div
                      key={row.label}
                      className={`py-3 ${index > 0 ? 'border-l border-rule pl-3 sm:pl-4' : ''}`}
                    >
                      <dt className="text-xs text-ink-2">
                        {row.label}
                        {row.served ? <span className="sr-only"> (served)</span> : null}
                      </dt>
                      <dd
                        className={`display-num mt-1 text-[clamp(1.5rem,3.4vw,2.25rem)] leading-none ${row.served ? 'text-ink' : 'text-ink-3'}`}
                      >
                        {row.value.toFixed(3)}
                      </dd>
                    </div>
                  ))}
                </dl>
                <figcaption className="pt-2.5 font-mono text-xs text-ink-3">
                  ROC-AUC on {formatInteger(data.testRange.rows)} test flights,{' '}
                  {formatDate(data.testRange.from)} to {formatDate(data.testRange.to)}
                </figcaption>
              </figure>
            );
          }}
        </QueryState>
      </div>
      <div data-reveal>
        <TextLink to="/model">See the model</TextLink>
      </div>
    </Chapter>
  );
}

// ---------- Hand-off ----------

const PAGES = [
  { to: '/overview', label: 'Overview', blurb: 'Volume, monthly trend, worst airlines' },
  { to: '/causes', label: 'Causes', blurb: 'What the late minutes are made of' },
  { to: '/explorer', label: 'Explorer', blurb: 'Rank anything, open the raw flights' },
  { to: '/predict', label: 'Predict', blurb: 'Score one flight' },
  { to: '/model', label: 'Model', blurb: 'Test metrics and importance' },
] as const;

export function HandoffChapter({ sectionRef }: { sectionRef: Ref<HTMLElement> }) {
  return (
    <section
      ref={sectionRef}
      aria-labelledby="chapter-handoff"
      className="pointer-events-none relative mx-auto flex min-h-[100dvh] w-full max-w-[1440px] flex-col justify-end px-5 pb-12 pt-[40dvh] md:px-10 md:pb-16"
    >
      <div className="pointer-events-auto">
        <h2 id="chapter-handoff" className="sr-only">
          The dashboard
        </h2>
        <div data-reveal>
          <Link
            to="/overview"
            className="group inline-flex items-baseline gap-4 font-display text-[clamp(2.5rem,7vw,5.5rem)] leading-[1.02] text-ink"
          >
            <span className="relative">
              Continue to the dashboard
              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-1 h-px origin-left scale-x-0 bg-current transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-x-100 group-focus-visible:scale-x-100"
              />
            </span>
            <ArrowRight
              aria-hidden="true"
              className="size-[0.55em] translate-y-[0.05em] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-2"
              strokeWidth={1.1}
            />
          </Link>
        </div>
        <nav aria-label="Pages" data-reveal className="mt-12 border-t border-rule-strong">
          <ul className="grid sm:grid-cols-5">
            {PAGES.map((page, index) => (
              <li
                key={page.to}
                className={index > 0 ? 'border-t border-rule sm:border-l sm:border-t-0' : ''}
              >
                <Link
                  to={page.to}
                  className="group block py-4 transition-colors duration-200 hover:bg-wash sm:px-4 sm:first:pl-0"
                >
                  <span className="flex items-center justify-between text-sm text-ink">
                    {page.label}
                    <ArrowRight
                      aria-hidden="true"
                      size={13}
                      strokeWidth={1.5}
                      className="-translate-x-1 text-ink-3 opacity-0 transition duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
                    />
                  </span>
                  <span className="mt-1 block text-xs text-ink-3">{page.blurb}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </section>
  );
}
