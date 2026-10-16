import { Plane } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useVideoVisibility } from '../../hooks/useVideoVisibility';
import { HERO } from '../../lib/motion';

const VIDEO_WEBM = '/videos/airplane-dusk.webm';
const VIDEO_MP4 = '/videos/airplane-dusk.mp4';
const POSTER_URL = '/videos/airplane-dusk-poster.jpg';

/**
 * The far layer: the dusk footage. The poster paints first; the video element is only created
 * once the browser is idle, so the headline never waits on 4 MB of video.
 */
function DuskFootage({ reduced }: { reduced: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loadVideo, setLoadVideo] = useState(false);
  useVideoVisibility(videoRef, 0.7);

  useEffect(() => {
    if (reduced) return;
    const idle = window.requestIdleCallback?.(() => setLoadVideo(true), { timeout: 1500 });
    const fallback = idle === undefined ? window.setTimeout(() => setLoadVideo(true), 600) : 0;
    return () => {
      if (idle !== undefined) window.cancelIdleCallback(idle);
      window.clearTimeout(fallback);
    };
  }, [reduced]);

  return (
    <>
      <img
        src={POSTER_URL}
        alt=""
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      {loadVideo ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster={POSTER_URL}
          className="absolute inset-0 h-full w-full object-cover object-center"
        >
          <source src={VIDEO_WEBM} type="video/webm" />
          <source src={VIDEO_MP4} type="video/mp4" />
        </video>
      ) : null}
    </>
  );
}

// ---------- Flight-path arc (right side, desktop only) ----------

const VIEW_W = 600;
const VIEW_H = 360;
/** West coast to Chicago to Atlanta: a stylised arc, not a geographic projection. */
const ARC = 'M40 290 C 150 120 270 70 370 96 S 520 170 560 250';
const AIRPORTS = [
  { code: 'LAX', x: 40, y: 290, delay: '0s', labelDx: -8, labelDy: 20, anchor: 'start' },
  { code: 'ORD', x: 370, y: 96, delay: '1.8s', labelDx: 0, labelDy: -14, anchor: 'middle' },
  { code: 'ATL', x: 560, y: 250, delay: '3.6s', labelDx: 8, labelDy: 20, anchor: 'end' },
] as const;
/** lucide's Plane points to the upper right, so a heading of θ needs θ + 45° of rotation. */
const PLANE_HEADING_OFFSET = 45;

/** Puts the plane at `progress` (0..1) along the arc, nose along the tangent (SVG transform). */
function placeOnPath(path: SVGPathElement, plane: SVGGElement, progress: number): void {
  const length = path.getTotalLength();
  const at = path.getPointAtLength(progress * length);
  const ahead = path.getPointAtLength(Math.min(length, progress * length + 1));
  const heading = (Math.atan2(ahead.y - at.y, ahead.x - at.x) * 180) / Math.PI;
  plane.setAttribute(
    'transform',
    `translate(${at.x.toFixed(2)} ${at.y.toFixed(2)}) rotate(${(heading + PLANE_HEADING_OFFSET).toFixed(1)})`,
  );
}

/**
 * The arc draws itself once (CSS stroke-dashoffset), then a plane loops along it with
 * requestAnimationFrame: no animation library on the eager path.
 */
function FlightPath({ reduced }: { reduced: boolean }) {
  const pathRef = useRef<SVGPathElement>(null);
  const planeRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const path = pathRef.current;
    const plane = planeRef.current;
    if (!path || !plane) return;
    if (reduced) {
      placeOnPath(path, plane, 0.62);
      plane.style.opacity = '0.7';
      return;
    }
    const start = performance.now() + (HERO.pathAt + HERO.pathDuration) * 1000;
    let frame = 0;
    const tick = (now: number) => {
      const since = (now - start) / 1000;
      if (since >= 0) {
        const phase = (since / HERO.planeLoopS) % 1;
        placeOnPath(path, plane, phase);
        // Fade in at the start of each loop and out at the end, so the jump back is never seen.
        plane.style.opacity = String(Math.min(1, phase / 0.06, (1 - phase) / 0.06) * 0.75);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced]);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="h-full w-full overflow-visible"
      fill="none"
      aria-hidden="true"
    >
      <path
        ref={pathRef}
        d={ARC}
        pathLength={1}
        stroke="rgba(242, 241, 236, 0.32)"
        strokeWidth={1}
        strokeLinecap="round"
        className={reduced ? undefined : 'hero-path'}
      />
      {AIRPORTS.map((airport) => (
        <g key={airport.code} className="hero-airport" style={{ animationDelay: airport.delay }}>
          <circle cx={airport.x} cy={airport.y} r={7} fill="rgba(242, 241, 236, 0.08)" />
          <circle cx={airport.x} cy={airport.y} r={2.5} fill="rgba(242, 241, 236, 0.85)" />
          <text
            x={airport.x + airport.labelDx}
            y={airport.y + airport.labelDy}
            textAnchor={airport.anchor}
            className="fill-ink font-mono text-[11px] tracking-wider"
          >
            {airport.code}
          </text>
        </g>
      ))}
      <g ref={planeRef} style={{ opacity: 0 }}>
        <g transform="translate(-7 -7)">
          <Plane width={14} height={14} strokeWidth={1.5} color="rgba(242, 241, 236, 0.9)" />
        </g>
      </g>
    </svg>
  );
}

type DivRef = RefObject<HTMLDivElement | null>;

/**
 * Looking out of a cabin window at dusk: footage (far), two drifting cloud bands, the breathing
 * sun, grain, and a faint flight path on the empty right side. Everything here is CSS or
 * requestAnimationFrame; the lazy enhancer later adds mouse parallax to the four layers and the
 * scroll-linked scale and blur to the stack, through the refs.
 */
export function HeroBackground({
  reduced,
  stackRef,
  videoRef,
  farRef,
  nearRef,
  pathRef,
}: {
  reduced: boolean;
  stackRef: DivRef;
  videoRef: DivRef;
  farRef: DivRef;
  nearRef: DivRef;
  pathRef: DivRef;
}) {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div ref={stackRef} className="absolute inset-0">
        {/* Oversized by the largest parallax travel so no edge is ever revealed. */}
        <div ref={videoRef} className="absolute -inset-6">
          <DuskFootage reduced={reduced} />
        </div>
        <div ref={farRef} className="absolute -inset-8">
          <div className="hero-cloud hero-cloud--far" />
          <div className="hero-sun" />
        </div>
        <div ref={nearRef} className="absolute -inset-8">
          <div className="hero-cloud hero-cloud--near" />
        </div>
      </div>

      {/* Readability: darken overall, more on the left (copy) and at the bottom (stats). */}
      <div className="absolute inset-0 bg-black/45" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(1,1,1,0.78)_0%,rgba(1,1,1,0.45)_45%,rgba(1,1,1,0.1)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-72 bg-gradient-to-b from-transparent to-ground" />

      <div
        ref={pathRef}
        className="absolute right-[3%] top-[14%] hidden aspect-[5/3] w-[min(44vw,640px)] opacity-80 lg:block"
      >
        <FlightPath reduced={reduced} />
      </div>

      <div className="absolute inset-0 overflow-hidden">
        <div className="hero-grain" />
      </div>
    </div>
  );
}
