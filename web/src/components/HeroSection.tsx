import { useReducedMotion } from 'motion/react';
import { useRef } from 'react';
import { Link } from 'react-router';
import { useMeta, useSummary } from '../api/hooks';
import { useVideoVisibility } from '../hooks/useVideoVisibility';
import { formatInteger, formatPercent, formatSignedMinutes } from '../lib/format';
import { ErrorBlock, Skeleton } from './QueryState';

const VIDEO_WEBM = '/videos/airplane-dusk.webm';
const VIDEO_MP4 = '/videos/airplane-dusk.mp4';
const POSTER_URL = '/videos/airplane-dusk-poster.jpg';

function BackgroundVideo({ reduced }: { reduced: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useVideoVisibility(videoRef, 0.7);

  if (reduced) {
    return (
      <img
        src={POSTER_URL}
        alt=""
        className="h-full w-full object-cover object-center"
        decoding="async"
      />
    );
  }
  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
      className="h-full w-full object-cover object-center"
    >
      <source src={VIDEO_WEBM} type="video/webm" />
      <source src={VIDEO_MP4} type="video/mp4" />
    </video>
  );
}

function Figures() {
  const summary = useSummary();
  if (summary.isError) {
    return (
      <ErrorBlock
        error={summary.error}
        label="the headline figures"
        onRetry={() => void summary.refetch()}
      />
    );
  }
  if (!summary.data) {
    return (
      <div role="status">
        <span className="sr-only">Loading headline figures</span>
        <Skeleton className="h-16" />
      </div>
    );
  }
  const figures = [
    { label: 'Delay rate', value: formatPercent(summary.data.delayRate), tone: 'text-delayed' },
    { label: 'Cancel rate', value: formatPercent(summary.data.cancelRate, 2), tone: '' },
    {
      label: 'Avg arrival delay',
      value: formatSignedMinutes(summary.data.avgArrDelay),
      tone: '',
    },
  ];
  return (
    <dl className="grid grid-cols-3 border-y border-white/15">
      {figures.map((figure, index) => (
        <div
          key={figure.label}
          className={`py-3 ${index > 0 ? 'border-l border-white/10 pl-4' : ''}`}
        >
          <dt className="text-xs text-ink-2">{figure.label}</dt>
          <dd
            className={`display-num mt-1 text-[clamp(1.5rem,4vw,2.25rem)] leading-none ${figure.tone}`}
          >
            {figure.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Sentence() {
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
      <div role="status">
        <span className="sr-only">Loading dataset summary</span>
        <Skeleton className="h-6 max-w-md" />
      </div>
    );
  }
  return (
    <p className="max-w-[40ch] text-lg leading-relaxed text-ink sm:text-xl">
      <span className="num">{formatInteger(meta.data.flights)}</span> US domestic flights from 2015,
      stored in MongoDB and used to train a delay-prediction model.
    </p>
  );
}

/** The compact intro: one viewport, no scroll-jacking, then hand off to the dashboard. */
export function HeroSection() {
  const reduced = useReducedMotion() === true;
  return (
    <section className="relative isolate flex min-h-screen w-full items-end overflow-hidden bg-ground">
      <div className="absolute inset-0 -z-10" aria-hidden="true">
        <BackgroundVideo reduced={reduced} />
        <div className="absolute inset-0 bg-black/55" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_70%,rgba(0,0,0,0.1)_0%,rgba(0,0,0,0.8)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-gradient-to-b from-transparent to-ground" />
      </div>

      <div className="mx-auto w-full max-w-[1440px] px-5 pb-12 pt-24 md:px-10 md:pb-16">
        <div className="max-w-2xl space-y-6">
          <h1 className="rise font-display text-[clamp(3rem,9vw,6rem)] font-normal leading-[0.98] text-balance">
            Flight Delay Prediction
          </h1>
          <div className="rise space-y-6" style={{ animationDelay: '120ms' }}>
            <Sentence />
            <Figures />
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Link
                to="/overview"
                className="inline-flex items-center rounded-full border border-rule-strong px-7 py-3 text-sm text-ink hover:bg-wash"
              >
                Open dashboard
              </Link>
              <Link
                to="/predict"
                className="inline-flex items-center rounded-full px-5 py-3 text-sm text-ink-2 underline-offset-4 hover:text-ink hover:underline"
              >
                Score a flight
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
