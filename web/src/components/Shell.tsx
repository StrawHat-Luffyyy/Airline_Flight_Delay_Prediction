import { Link, NavLink, Outlet } from 'react-router';
import { useMeta } from '../api/hooks';
import { formatDate, formatInteger } from '../lib/format';

const TABS = [
  { to: '/overview', label: 'Overview' },
  { to: '/causes', label: 'Causes' },
  { to: '/explorer', label: 'Explorer' },
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

export function Shell() {
  return (
    <div className="min-h-screen">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-ink focus:px-3 focus:py-2 focus:text-ground"
      >
        Skip to content
      </a>
      <header className="flex flex-wrap items-center gap-x-10 gap-y-2 border-b border-rule px-5 py-3 md:h-16 md:flex-nowrap md:px-10 md:py-0">
        <Link to="/" className="font-display text-[22px] leading-none whitespace-nowrap">
          Flight Delay Prediction
        </Link>
        <nav
          aria-label="Pages"
          className="-mx-1 w-full overflow-x-auto md:mx-0 md:w-auto md:overflow-visible"
        >
          <ul className="flex gap-1 px-1 md:px-0">
            {TABS.map((tab) => (
              <li key={tab.to}>
                <NavLink
                  to={tab.to}
                  className={({ isActive }) =>
                    `block whitespace-nowrap rounded-full px-2.5 py-2 md:px-3.5 text-[13px] transition-colors ${
                      isActive ? 'bg-rule-strong text-ink' : 'text-ink-2 hover:text-ink'
                    }`
                  }
                >
                  {tab.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto w-full md:w-auto">
          <DataStrip />
        </div>
      </header>
      <main id="content" className="mx-auto w-full max-w-[1440px] px-5 py-8 md:px-10">
        <Outlet />
      </main>
    </div>
  );
}
