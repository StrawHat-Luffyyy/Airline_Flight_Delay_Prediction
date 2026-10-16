import {
  domAnimation,
  LazyMotion,
  m,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router';
import { useMeta } from '../api/hooks';
import { formatInteger } from '../lib/format';
import { EASE_OUT_EXPO, HERO, PARALLAX_SPRING, ramp, resetHeroClock } from '../lib/motion';
import { Skeleton } from './QueryState';
import { CountUp, useEntrance } from './hero/entrance';
import { HeroActions } from './hero/HeroActions';
import { HeroBackground } from './hero/HeroBackground';
import { HeroStats } from './hero/HeroStats';

const HEADLINE_LINES = ['Flight Delay', 'Prediction'] as const;
const fmtFlights = (value: number): string => formatInteger(Math.round(value));

/** Each line slides up from behind its own mask, sharpening as it lands. */
function Headline({ reduced }: { reduced: boolean }) {
  return (
    <h1 className="font-display text-[clamp(3rem,9vw,6rem)] font-normal leading-[0.98]">
      {HEADLINE_LINES.map((line, index) => (
        <span key={line} className="block overflow-hidden pb-[0.08em]">
          <m.span
            className="block"
            // Opaque from the first frame (only the mask and blur animate), so the headline is
            // painted visibly at once and stays the LCP element.
            initial={reduced ? false : { y: '105%', filter: 'blur(6px)' }}
            animate={{ y: '0%', filter: 'blur(0px)' }}
            transition={{
              delay: index * HERO.lineStagger,
              duration: HERO.lineDuration,
              ease: EASE_OUT_EXPO,
            }}
          >
            {line}
            {index < HEADLINE_LINES.length - 1 ? ' ' : null}
          </m.span>
        </span>
      ))}
    </h1>
  );
}

/** Mounts only once the count is known, so its entrance always has an element to animate. */
function SublineText({ flights, reduced }: { flights: number; reduced: boolean }) {
  const [sublineRef, sublineStyle] = useEntrance<HTMLParagraphElement>(
    HERO.sublineAt,
    { opacity: [0, 1], y: [12, 0] },
    HERO.sublineDuration,
    reduced,
    { opacity: 0 },
  );
  return (
    <p
      ref={sublineRef}
      style={sublineStyle}
      className="max-w-[40ch] text-lg leading-relaxed text-ink sm:text-xl"
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

/** A hairline with a travelling segment; scrolls to the hand-off. Fades as scrolling begins. */
function ScrollCue({ onActivate, opacity }: { onActivate: () => void; opacity: number }) {
  return (
    <m.button
      type="button"
      onClick={onActivate}
      aria-label="Scroll to continue to the dashboard"
      className="absolute bottom-6 left-1/2 hidden h-12 w-8 -translate-x-1/2 items-start justify-center sm:flex"
      initial={{ opacity: 0 }}
      animate={{ opacity }}
      transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
    >
      <span className="relative block h-full w-px overflow-hidden bg-white/15">
        <span className="hero-cue-dot absolute inset-x-0 top-0 block h-1/3 bg-ink/80" />
      </span>
    </m.button>
  );
}

/**
 * The intro. A sticky frame inside a taller scroll stage: on load the headline, figures and
 * actions arrive in one sequence; scrolling then lifts the copy away, softens the sky, and hands
 * off to the dashboard. Under prefers-reduced-motion it is a plain one-viewport page.
 */
export function HeroSection() {
  const reduced = useReducedMotion() === true;
  const stageRef = useRef<HTMLDivElement>(null);
  const handoffRef = useRef<HTMLDivElement>(null);
  const [cueVisible, setCueVisible] = useState(false);
  const [handoffActive, setHandoffActive] = useState(false);

  useEffect(() => resetHeroClock, []);
  useEffect(() => {
    if (reduced) return;
    const timer = window.setTimeout(() => setCueVisible(true), HERO.cueAt * 1000);
    return () => window.clearTimeout(timer);
  }, [reduced]);

  // Scroll stage: 0 at the top, 1 once the stage has scrolled through.
  const { scrollYProgress } = useScroll({ target: stageRef, offset: ['start start', 'end end'] });
  // Function transforms on purpose: Motion hands array-mapped scroll opacity to a native
  // ViewTimeline, whose range is wrong for a sticky stage (opacity snapped back to 1 at the end).
  const contentOpacity = useTransform(scrollYProgress, (v) => 1 - ramp(v, 0, 0.5));
  const contentY = useTransform(scrollYProgress, (v) => -64 * ramp(v, 0, 0.5));
  const bgScale = useTransform(scrollYProgress, (v) => 1 + 0.08 * ramp(v, 0, 1));
  const bgBlur = useTransform(scrollYProgress, (v) => `blur(${(6 * ramp(v, 0, 1)).toFixed(2)}px)`);
  const handoffOpacity = useTransform(scrollYProgress, (v) => ramp(v, 0.55, 0.85));
  const handoffY = useTransform(scrollYProgress, (v) => 20 * (1 - ramp(v, 0.55, 0.85)));
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollYProgress, 'change', (progress) => {
    setScrolled(progress > 0.04);
    setHandoffActive(progress > 0.6);
  });

  // Mouse parallax, desktop fine pointers only; springs give the damping.
  const pointerX = useSpring(useMotionValue(0), PARALLAX_SPRING);
  const pointerY = useSpring(useMotionValue(0), PARALLAX_SPRING);
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (reduced || event.pointerType !== 'mouse' || window.innerWidth < 1024) return;
    pointerX.set(event.clientX / window.innerWidth - 0.5);
    pointerY.set(event.clientY / window.innerHeight - 0.5);
  };
  const onPointerLeave = () => {
    pointerX.set(0);
    pointerY.set(0);
  };

  const toHandoff = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const top = stage.offsetTop + stage.offsetHeight - window.innerHeight;
    window.scrollTo({ top, behavior: 'smooth' });
    handoffRef.current?.querySelector('a')?.focus({ preventScroll: true });
  };

  return (
    // `m` components + only the domAnimation features keep the eager bundle small; the dashboard's
    // Board (layout animations) loads full `motion` in its own lazy chunk.
    <LazyMotion features={domAnimation} strict>
      <div ref={stageRef} className={reduced ? undefined : 'relative h-[180dvh]'}>
        <section
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          className="sticky top-0 isolate flex min-h-[100dvh] w-full items-end overflow-hidden bg-ground"
        >
          <HeroBackground
            reduced={reduced}
            pointerX={pointerX}
            pointerY={pointerY}
            scale={bgScale}
            blur={bgBlur}
          />

          <m.div
            className="mx-auto w-full max-w-[1440px] px-5 pb-16 pt-24 md:px-10 md:pb-20"
            style={reduced ? undefined : { opacity: contentOpacity, y: contentY }}
            inert={handoffActive}
          >
            <div className="max-w-2xl space-y-6">
              <Headline reduced={reduced} />
              <div className="space-y-6">
                <Subline reduced={reduced} />
                <HeroStats reduced={reduced} />
                <HeroActions reduced={reduced} />
              </div>
            </div>
          </m.div>

          {reduced ? null : (
            <m.div
              ref={handoffRef}
              className="absolute inset-x-0 top-1/2 mx-auto w-full max-w-[1440px] -translate-y-1/2 px-5 md:px-10"
              style={{ opacity: handoffOpacity, y: handoffY }}
              inert={!handoffActive}
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
            </m.div>
          )}

          {reduced ? null : (
            <ScrollCue onActivate={toHandoff} opacity={cueVisible && !scrolled ? 1 : 0} />
          )}
        </section>
      </div>
    </LazyMotion>
  );
}
