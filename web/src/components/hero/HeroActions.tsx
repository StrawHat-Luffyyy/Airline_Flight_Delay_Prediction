import { ArrowRight, Plane } from 'lucide-react';
import type { RefObject } from 'react';
import { Link } from 'react-router';
import { HERO } from '../../lib/motion';
import { useEntrance } from './entrance';

/**
 * Primary action. The arrow slide-in and brighter edge are CSS; the magnetic lean toward the
 * cursor is added later by the lazy enhancer, which drives `magnetRef` (fine pointers only).
 */
function OpenDashboard({ magnetRef }: { magnetRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={magnetRef}>
      <Link
        to="/overview"
        className="group relative inline-flex items-center rounded-full border border-rule-strong py-3 pl-7 pr-7 text-sm text-ink active:scale-[0.98]"
      >
        {/* Brighter edge on hover/focus: an overlay ring fading in (opacity only). */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full border border-white/55 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
        />
        <span className="transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-x-2 group-focus-visible:-translate-x-2">
          Open dashboard
        </span>
        <ArrowRight
          aria-hidden="true"
          size={15}
          strokeWidth={1.5}
          className="absolute right-4 -translate-x-1.5 opacity-0 transition duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
        />
      </Link>
    </div>
  );
}

/** Secondary action: underline draws in from the left, the plane nudges forward. */
function ScoreAFlight() {
  return (
    <Link
      to="/predict"
      className="group inline-flex items-center gap-2 px-4 py-3 text-sm text-ink-2 hover:text-ink focus-visible:text-ink"
    >
      <span className="relative">
        Score a flight
        <span
          aria-hidden="true"
          className="absolute inset-x-0 -bottom-0.5 h-px origin-left scale-x-0 bg-current transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-x-100 group-focus-visible:scale-x-100"
        />
      </span>
      <Plane
        aria-hidden="true"
        size={14}
        strokeWidth={1.5}
        className="transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1 group-hover:-translate-y-0.5 group-focus-visible:translate-x-1 group-focus-visible:-translate-y-0.5"
      />
    </Link>
  );
}

export function HeroActions({
  reduced,
  magnetRef,
}: {
  reduced: boolean;
  magnetRef: RefObject<HTMLDivElement | null>;
}) {
  const [rowRef, rowEnter] = useEntrance<HTMLDivElement>(
    'hero-rise',
    HERO.buttonsAt,
    HERO.buttonsDuration,
    reduced,
  );
  return (
    <div ref={rowRef} className={`flex flex-wrap items-center gap-2 pt-2 ${rowEnter}`}>
      <OpenDashboard magnetRef={magnetRef} />
      <ScoreAFlight />
    </div>
  );
}
