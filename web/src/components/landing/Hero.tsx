import type { RefObject } from 'react';
import { useMeta } from '../../api/hooks';
import { formatInteger } from '../../lib/format';
import { HERO } from '../../lib/motion';
import { Skeleton } from '../QueryState';
import { HeroActions } from '../hero/HeroActions';
import { HeroStats } from '../hero/HeroStats';
import { CountUp, useEntrance } from '../hero/entrance';

const HEADLINE_LINES = ['Flight Delay', 'Prediction'] as const;
const fmtFlights = (value: number): string => formatInteger(Math.round(value));

/**
 * Each line slides up from behind its own mask and sharpens (CSS keyframes). Opaque from the first
 * frame, so the headline paints at once and stays the LCP element.
 */
function Headline({ reduced }: { reduced: boolean }) {
  return (
    <h1
      id="chapter-intro"
      className="font-display text-[clamp(3rem,8.5vw,6rem)] font-normal leading-[0.98]"
    >
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

/** The first viewport: title, live count, headline rates and the two ways in. */
export function Hero({
  reduced,
  sectionRef,
  contentRef,
  magnetRef,
}: {
  reduced: boolean;
  sectionRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  magnetRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <section
      ref={sectionRef}
      aria-labelledby="chapter-intro"
      className="pointer-events-none relative mx-auto flex min-h-[100dvh] w-full max-w-[1440px] items-end px-5 pb-14 pt-[44dvh] md:items-center md:px-10 md:pb-16 md:pt-24"
    >
      <div ref={contentRef} className="landing-copy pointer-events-auto w-full max-w-2xl space-y-6">
        <Headline reduced={reduced} />
        <Subline reduced={reduced} />
        <HeroStats reduced={reduced} />
        <HeroActions reduced={reduced} magnetRef={magnetRef} />
      </div>
    </section>
  );
}
