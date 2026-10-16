import { m, useMotionValue, useSpring } from 'motion/react';
import { ArrowRight, Plane } from 'lucide-react';
import type { PointerEvent } from 'react';
import { Link } from 'react-router';
import { HERO, MAGNET_SPRING } from '../../lib/motion';
import { useEntrance } from './entrance';

/** How far the primary button may follow the cursor, in px. */
const MAGNET_MAX = 6;
const MAGNET_PULL = 0.18;

const finePointer = (): boolean => window.matchMedia('(pointer: fine)').matches;

/** Primary action: leans toward the cursor (fine pointers only), arrow slides in, edge brightens. */
function OpenDashboard({ reduced }: { reduced: boolean }) {
  const x = useSpring(useMotionValue(0), MAGNET_SPRING);
  const y = useSpring(useMotionValue(0), MAGNET_SPRING);

  const follow = (event: PointerEvent<HTMLAnchorElement>) => {
    if (reduced || event.pointerType !== 'mouse' || !finePointer()) return;
    const box = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - (box.left + box.width / 2)) * MAGNET_PULL;
    const dy = (event.clientY - (box.top + box.height / 2)) * MAGNET_PULL;
    x.set(Math.max(-MAGNET_MAX, Math.min(MAGNET_MAX, dx)));
    y.set(Math.max(-MAGNET_MAX, Math.min(MAGNET_MAX, dy)));
  };
  const release = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <m.div style={{ x, y }}>
      <Link
        to="/overview"
        onPointerMove={follow}
        onPointerLeave={release}
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
    </m.div>
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

export function HeroActions({ reduced }: { reduced: boolean }) {
  const [rowRef, rowStyle] = useEntrance<HTMLDivElement>(
    HERO.buttonsAt,
    { opacity: [0, 1], y: [10, 0] },
    HERO.buttonsDuration,
    reduced,
    { opacity: 0 },
  );
  return (
    <div ref={rowRef} style={rowStyle} className="flex flex-wrap items-center gap-2 pt-2">
      <OpenDashboard reduced={reduced} />
      <ScoreAFlight />
    </div>
  );
}
