import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSyncExternalStore } from 'react';
import { useMeta } from '../../api/hooks';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { resetHeroClock } from '../../lib/motion';
import { buildRouteArcs } from '../globe/geo';
import { resetGlobe } from '../globe/store';
import {
  HandoffChapter,
  ModelChapter,
  PredictChapter,
  RouteReadout,
  RoutesChapter,
  VolumeChapter,
} from './Chapters';
import { Hero } from './Hero';
import { useRouteRankings } from './useRouteRankings';

const GlobeScene = lazy(() => import('../globe/GlobeScene'));

const INTERACTIVE_QUERY = '(pointer: fine) and (min-width: 1024px)';
function subscribeInteractive(onChange: () => void): () => void {
  const list = window.matchMedia(INTERACTIVE_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}
/** Hover and drag on the globe only make sense with a mouse on a wide screen. */
function useInteractiveGlobe(): boolean {
  return useSyncExternalStore(
    subscribeInteractive,
    () => window.matchMedia(INTERACTIVE_QUERY).matches,
    () => false,
  );
}

/** No WebGL (or a lost context) leaves the page as it is: copy on the night ground. */
class GlobeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Waits for the browser to be idle after first paint, then flips to true once. */
function useIdle(): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const done = () => setIdle(true);
    const handle = window.requestIdleCallback?.(done, { timeout: 900 });
    const fallback = handle === undefined ? window.setTimeout(done, 250) : 0;
    return () => {
      if (handle !== undefined) window.cancelIdleCallback(handle);
      window.clearTimeout(fallback);
    };
  }, []);
  return idle;
}

/**
 * The landing page at `/`: a night-orbit globe of real 2015 routes behind a five-chapter scroll
 * story (volume, routes, prediction, honest evaluation, hand-off). The copy, headline figures and
 * entrance are eager and library-free; the globe (three.js) and the Motion layer load once the
 * browser is idle. Under prefers-reduced-motion the globe is a still frame, chapters do not
 * animate, and Motion is never requested.
 */
export function Landing() {
  const reduced = usePrefersReducedMotion();
  const interactive = useInteractiveGlobe();
  const idle = useIdle();
  const [globeReady, setGlobeReady] = useState(false);

  const heroRef = useRef<HTMLElement>(null);
  const heroContentRef = useRef<HTMLDivElement>(null);
  const magnetRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef<HTMLElement>(null);
  const routesRef = useRef<HTMLElement>(null);
  const predictRef = useRef<HTMLElement>(null);
  const modelRef = useRef<HTMLElement>(null);
  const handoffRef = useRef<HTMLElement>(null);

  const meta = useMeta();
  const rankings = useRouteRankings();

  const airportCoordinates = useMemo(
    () => new Map((meta.data?.airports ?? []).map((airport) => [airport.code, airport])),
    [meta.data],
  );
  const airports = useMemo(
    () =>
      (meta.data?.airports ?? []).flatMap((airport) =>
        airport.latitude !== null && airport.longitude !== null
          ? [{ code: airport.code, latitude: airport.latitude, longitude: airport.longitude }]
          : [],
      ),
    [meta.data],
  );
  const arcs = useMemo(
    () => [
      ...buildRouteArcs(rankings.late.data?.rows ?? [], airportCoordinates, 'late'),
      ...buildRouteArcs(rankings.punctual.data?.rows ?? [], airportCoordinates, 'punctual'),
    ],
    [rankings.late.data, rankings.punctual.data, airportCoordinates],
  );

  useEffect(
    () => () => {
      resetHeroClock();
      resetGlobe();
    },
    [],
  );

  // The Motion layer: scroll-to-chapter, reveals, hero exit, parallax, magnet.
  useEffect(() => {
    if (reduced || !idle) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import('./enhance').then(({ enhanceLanding }) => {
      const chapters = [heroRef, volumeRef, routesRef, predictRef, modelRef, handoffRef].map(
        (ref) => ref.current,
      );
      const heroContent = heroContentRef.current;
      const magnet = magnetRef.current;
      if (cancelled || !heroContent || !magnet || chapters.some((node) => node === null)) return;
      cleanup = enhanceLanding({ chapters: chapters as HTMLElement[], heroContent, magnet });
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [reduced, idle]);

  return (
    <div className="relative bg-ground">
      {/* The orbit: fixed behind every chapter. */}
      <div
        role="img"
        aria-label="A globe of the United States at night. Airports glow where they are; amber arcs are the routes most often late in 2015 and blue arcs the most punctual."
        className="fixed inset-0 z-0"
      >
        <div aria-hidden="true" className="landing-orbit-hint absolute inset-0" />
        <div
          className={`absolute inset-0 transition-opacity duration-[1400ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${globeReady ? 'opacity-100' : 'opacity-0'}`}
        >
          {idle && meta.data ? (
            <GlobeBoundary>
              <Suspense fallback={null}>
                <GlobeScene
                  arcs={arcs}
                  airports={airports}
                  reduced={reduced}
                  interactive={interactive}
                  onReady={() => setGlobeReady(true)}
                />
              </Suspense>
            </GlobeBoundary>
          ) : null}
        </div>
      </div>
      {/* Legibility scrims: from the left on desktop, from below on phones. */}
      <div aria-hidden="true" className="landing-scrim pointer-events-none fixed inset-0 z-[1]" />

      <main className="relative z-10">
        <Hero
          reduced={reduced}
          sectionRef={heroRef}
          contentRef={heroContentRef}
          magnetRef={magnetRef}
        />
        <VolumeChapter sectionRef={volumeRef} />
        <RoutesChapter sectionRef={routesRef} rankings={rankings} />
        <PredictChapter sectionRef={predictRef} />
        <ModelChapter sectionRef={modelRef} />
        <HandoffChapter sectionRef={handoffRef} />
      </main>

      {interactive ? <RouteReadout arcs={arcs} /> : null}
    </div>
  );
}
