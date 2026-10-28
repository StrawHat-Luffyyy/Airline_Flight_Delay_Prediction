import { Suspense, useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useMeta } from '../api/hooks';
import { useSlidingIndicator } from '../hooks/useSlidingIndicator';
import { formatDate, formatInteger } from '../lib/format';
import { Skeleton } from './QueryState';

const TABS = [
  { to: '/overview', label: 'Overview' },
  { to: '/causes', label: 'Causes' },
  { to: '/explorer', label: 'Explorer' },
  { to: '/compare', label: 'Compare' },
  { to: '/predict', label: 'Predict' },
  { to: '/model', label: 'Model' },
  { to: '/live', label: 'Live' },
] as const;

function DataStrip() {
  const meta = useMeta();
  const base = 'num text-xs tracking-wide text-ink-3';

  if (meta.isPending) {
    return (
      <p className={base} role="status">
        <span className="sr-only">Loading dataset summary</span>
        <span
          className="skeleton inline-block h-3 w-72 max-w-full align-middle"
          aria-hidden="true"
        />
      </p>
    );
  }
  if (meta.isError) {
    return (
      <p className={base} role="alert">
        Dataset summary unavailable.{' '}
        <button
          type="button"
          onClick={() => void meta.refetch()}
          className="text-ink underline underline-offset-4"
        >
          Retry
        </button>
      </p>
    );
  }
  const { flights, dateRange, statsBuiltAt } = meta.data;
  return (
    <p className={base}>
      <b className="font-normal text-ink">{formatInteger(flights)}</b> flights
      {dateRange ? ` · ${dateRange.from} → ${dateRange.to}` : ''}
      {' · '}
      {statsBuiltAt ? `stats built ${formatDate(statsBuiltAt)}` : 'stats not built'}
    </p>
  );
}

export function PageFallback() {
  return (
    <div role="status">
      <span className="sr-only">Loading page</span>
      <Skeleton className="h-96" />
    </div>
  );
}

/** The page tabs. One pill slides to the active tab rather than each tab lighting on its own. */
function Tabs() {
  const { pathname } = useLocation();
  const list = useRef<HTMLUListElement>(null);
  const pill = useSlidingIndicator(list, 'a[aria-current="page"]', pathname);

  // On phones the tab row scrolls sideways: bring the active tab into view after navigating.
  useEffect(() => {
    const row = list.current?.parentElement;
    const active = list.current?.querySelector('a[aria-current="page"]');
    if (!row || !active) return;
    const view = row.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left >= view.left && tab.right <= view.right) return;
    row.scrollBy({ left: tab.left - view.left - 16, behavior: 'instant' });
  }, [pathname]);
  return (
    <ul ref={list} className="relative flex gap-1 px-1 md:px-0">
      <span className="slide-pill bg-rule-strong" style={pill} aria-hidden="true" />
      {TABS.map((tab) => (
        <li key={tab.to} className="relative">
          <NavLink
            to={tab.to}
            className={({ isActive }) =>
              `block whitespace-nowrap rounded-full px-2.5 py-2 md:px-3.5 text-[13px] transition-colors duration-200 ${
                isActive ? 'text-ink' : 'text-ink-2 hover:bg-wash hover:text-ink'
              }`
            }
          >
            {tab.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function Shell() {
  const { pathname } = useLocation();
  return (
    <div className="min-h-screen">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-ink focus:px-3 focus:py-2 focus:text-ground"
      >
        Skip to content
      </a>
      <header className="flex flex-wrap items-center gap-x-10 gap-y-2 border-b border-rule px-5 py-3 md:px-10 xl:h-16 xl:flex-nowrap xl:py-0">
        <Link to="/" className="font-display text-[22px] leading-none whitespace-nowrap">
          Flight Delay Prediction
        </Link>
        <nav
          aria-label="Pages"
          className="-mx-1 w-full overflow-x-auto md:mx-0 md:w-auto md:overflow-visible"
        >
          <Tabs />
        </nav>
        {/* Below xl the seven tabs leave no room beside them, so the strip takes its own line. */}
        <div className="ml-auto w-full xl:w-auto">
          <DataStrip />
        </div>
      </header>
      <main id="content" className="mx-auto w-full max-w-[1440px] px-5 py-8 md:px-10">
        <Suspense fallback={<PageFallback />}>
          {/* Keyed by path: the entrance plays on navigation, never on a re-render. */}
          <div key={pathname} className="page-enter">
            <Outlet />
          </div>
        </Suspense>
      </main>
    </div>
  );
}
