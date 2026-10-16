import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMeta } from '../api/hooks';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { formatInteger } from '../lib/format';
import { HERO, resetHeroClock } from '../lib/motion';
import { Skeleton } from './QueryState';
import { CountUp, useEntrance } from './hero/entrance';
import { HeroActions } from './hero/HeroActions';
import { HeroBackground } from './hero/HeroBackground';
import { HeroStats } from './hero/HeroStats';

const HEADLINE_LINES = ['Flight Delay', 'Prediction'] as const;
const fmtFlights = (value: number): string => formatInteger(Math.round(value));

/**
 * Each line slides up from behind its own mask and sharpens (CSS keyframes). Opaque from the first
 * frame, so the headline paints at once and stays the LCP element.
 */
function Headline({ reduced }: { reduced: boolean }) {
  return (
    <h1 className="font-display text-[clamp(3rem,9vw,6rem)] font-normal leading-[0.98]">
      {HEADLINE_LINES.map((line, index) => (
        <span key={line} className="block overflow-hidden pb-[0.08em]">
          <span
            className={reduced ? 'block' : 'hero-line block'}
            style={reduced ? undefined : { ['--delay' as string]: `${index * HERO.lineStagger}s` }}
          >
            {line}
            {index < HEADLINE_LINES.length - 1 ? ' ' : null}
          </span>
        </span>
      ))}
    </h1>
  );
}

/** Mounts only once the count is known, so its entrance always has an element to animate. */
function SublineText({ flights, reduced }: { flights: number; reduced: boolean }) {
  const [sublineRef, sublineEnter] = useEntrance<HTMLParagraphElement>(
    'hero-rise',
    HERO.sublineAt,
    HERO.sublineDuration,
    reduced,
  );
  return (
    <p
      ref={sublineRef}
      className={`max-w-[40ch] text-lg leading-relaxed text-ink sm:text-xl ${sublineEnter}`}
    >
      <CountUp
        value={flights}
        format={fmtFlights}
        at={HERO.sublineAt}
        duration={HERO.countDuration}
        reduced={reduced}
        className="num"
      />{' '}
      US domestic flights from 2015, stored in MongoDB and used to train a delay-prediction model.
    </p>
  );
}

function Subline({ reduced }: { reduced: boolean }) {
  const meta = useMeta();
  if (meta.isError) {
    return (
      <p className="text-ink-2" role="alert">
        The dataset summary could not be loaded.{' '}
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
  if (!meta.data) {
    return (
      <div role="status" className="space-y-2">
        <span className="sr-only">Loading dataset summary</span>
        <Skeleton className="h-6 max-w-md" />
        <Skeleton className="h-6 max-w-sm" />
      </div>
    );
  }
  return <SublineText flights={meta.data.flights} reduced={reduced} />;
}

/** A hairline with a travelling segment; scrolls to the hand-off. CSS-faded in and out. */
function ScrollCue({ onActivate, visible }: { onActivate: () => void; visible: boolean }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label="Scroll to continue to the dashboard"
      data-visible={visible ? '' : undefined}
      tabIndex={visible ? 0 : -1}
      className="hero-cue absolute bottom-6 left-1/2 hidden h-12 w-8 -translate-x-1/2 items-start justify-center sm:flex"
    >
      <span className="relative block h-full w-px overflow-hidden bg-white/15">
        <span className="hero-cue-dot absolute inset-x-0 top-0 block h-1/3 bg-ink/80" />
      </span>
    </button>
  );
}

/**
 * The intro. A sticky frame inside a taller scroll stage. The entrance is CSS and
 * requestAnimationFrame, so the first paint carries no animation library; Motion arrives in a
 * lazy chunk (hero/enhance.ts) that adds mouse parallax, the scroll-linked exit and hand-off, and
 * the magnetic primary action. Under prefers-reduced-motion it is a plain one-viewport page and
 * the Motion chunk is never loaded.
 */
export function HeroSection() {
  const reduced = usePrefersReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const handoffRef = useRef<HTMLDivElement>(null);
  const magnetRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLDivElement>(null);
  const farRef = useRef<HTMLDivElement>(null);
  const nearRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<HTMLDivElement>(null);
  const [enhanced, setEnhanced] = useState(false);
  const [cueDue, setCueDue] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => resetHeroClock, []);

  // Load the Motion layer once the browser is idle after first paint.
  useEffect(() => {
    if (reduced) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    const load = () => {
      void import('./hero/enhance').then(({ enhanceHero }) => {
        const nodes = {
          stage: stageRef.current,
          section: sectionRef.current,
          content: contentRef.current,
          handoff: handoffRef.current,
          stack: stackRef.current,
          video: videoRef.current,
          far: farRef.current,
          near: nearRef.current,
          path: pathRef.current,
          magnet: magnetRef.current,
        };
        if (cancelled || Object.values(nodes).some((node) => node === null)) return;
        cleanup = enhanceHero(nodes as { [K in keyof typeof nodes]: HTMLElement }, setScrolled);
        setEnhanced(true);
      });
    };
    const idle = window.requestIdleCallback?.(load, { timeout: 800 });
    const fallback = idle === undefined ? window.setTimeout(load, 200) : 0;
    const cue = window.setTimeout(() => setCueDue(true), HERO.cueAt * 1000);
    return () => {
      cancelled = true;
      if (idle !== undefined) window.cancelIdleCallback(idle);
      window.clearTimeout(fallback);
      window.clearTimeout(cue);
      cleanup?.();
    };
  }, [reduced]);

  const toHandoff = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const top = stage.offsetTop + stage.offsetHeight - window.innerHeight;
    window.scrollTo({ top, behavior: 'smooth' });
    handoffRef.current?.querySelector('a')?.focus({ preventScroll: true });
  };

  return (
    <div ref={stageRef} className={reduced ? undefined : 'relative h-[180dvh]'}>
      <section
        ref={sectionRef}
        className="sticky top-0 isolate flex min-h-[100dvh] w-full items-end overflow-hidden bg-ground"
      >
        <HeroBackground
          reduced={reduced}
          stackRef={stackRef}
          videoRef={videoRef}
          farRef={farRef}
          nearRef={nearRef}
          pathRef={pathRef}
        />

        <div
          ref={contentRef}
          className="mx-auto w-full max-w-[1440px] px-5 pb-16 pt-24 md:px-10 md:pb-20"
        >
          <div className="max-w-2xl space-y-6">
            <Headline reduced={reduced} />
            <div className="space-y-6">
              <Subline reduced={reduced} />
              <HeroStats reduced={reduced} />
              <HeroActions reduced={reduced} magnetRef={magnetRef} />
            </div>
          </div>
        </div>

        {reduced ? null : (
          // Driven by the Motion layer (opacity, lift, inert); hidden until then.
          <div
            ref={handoffRef}
            className="absolute inset-x-0 top-1/2 mx-auto w-full max-w-[1440px] -translate-y-1/2 px-5 opacity-0 md:px-10"
            inert
          >
            <Link
              to="/overview"
              className="group inline-flex items-baseline gap-4 font-display text-[clamp(2rem,5vw,3.5rem)] leading-tight text-ink"
            >
              <span className="relative">
                Continue to the dashboard
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-1 h-px origin-left scale-x-0 bg-current transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-x-100 group-focus-visible:scale-x-100"
                />
              </span>
              <ArrowRight
                aria-hidden="true"
                className="size-[0.6em] translate-y-[0.05em] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1.5"
                strokeWidth={1.25}
              />
            </Link>
          </div>
        )}

        {reduced ? null : (
          <ScrollCue onActivate={toHandoff} visible={enhanced && cueDue && !scrolled} />
        )}
      </section>
    </div>
  );
}
