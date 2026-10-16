import { m, useAnimationFrame, useMotionValue, useTransform, type MotionValue } from 'motion/react';
import { Plane } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useVideoVisibility } from '../../hooks/useVideoVisibility';
import { EASE_OUT_EXPO, HERO, PARALLAX_PX } from '../../lib/motion';

const VIDEO_WEBM = '/videos/airplane-dusk.webm';
const VIDEO_MP4 = '/videos/airplane-dusk.mp4';
const POSTER_URL = '/videos/airplane-dusk-poster.jpg';

/** Layer offset opposite the cursor: pointer is normalised to -0.5..0.5. */
function useParallax(pointer: MotionValue<number>, px: number): MotionValue<number> {
  return useTransform(pointer, (value) => -value * px * 2);
}

/**
 * The far layer: the dusk footage. The poster paints first (it is the LCP-safe frame); the video
 * element is only created once the browser is idle, so the headline never waits on 4 MB of video.
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

interface PlaneValues {
  x: MotionValue<number>;
  y: MotionValue<number>;
  rotate: MotionValue<number>;
}

/** Puts the plane at `progress` (0..1) along the arc, nose along the tangent. */
function placeOnPath(path: SVGPathElement, progress: number, plane: PlaneValues): void {
  const length = path.getTotalLength();
  const at = path.getPointAtLength(progress * length);
  const ahead = path.getPointAtLength(Math.min(length, progress * length + 1));
  const heading = (Math.atan2(ahead.y - at.y, ahead.x - at.x) * 180) / Math.PI;
  plane.x.set(at.x);
  plane.y.set(at.y);
  plane.rotate.set(heading + PLANE_HEADING_OFFSET);
}

function FlightPath({ reduced }: { reduced: boolean }) {
  const pathRef = useRef<SVGPathElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useMotionValue(0);
  const opacity = useMotionValue(0);

  useEffect(() => {
    if (!reduced || !pathRef.current) return;
    placeOnPath(pathRef.current, 0.62, { x, y, rotate });
    opacity.set(0.7);
  }, [reduced, x, y, rotate, opacity]);

  useAnimationFrame((time) => {
    if (reduced || !pathRef.current) return;
    const since = time / 1000 - (HERO.pathAt + HERO.pathDuration);
    if (since < 0) return;
    placeOnPath(pathRef.current, (since / HERO.planeLoopS) % 1, { x, y, rotate });
    // Fade in at the start of each loop and out at the end, so the jump back is never seen.
    const phase = (since / HERO.planeLoopS) % 1;
    opacity.set(Math.min(1, phase / 0.06, (1 - phase) / 0.06) * 0.75);
  });

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="h-full w-full overflow-visible"
      fill="none"
      aria-hidden="true"
    >
      <m.path
        ref={pathRef}
        d={ARC}
        stroke="rgba(242, 241, 236, 0.32)"
        strokeWidth={1}
        strokeLinecap="round"
        initial={reduced ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ delay: HERO.pathAt, duration: HERO.pathDuration, ease: EASE_OUT_EXPO }}
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
      <m.g style={{ x, y, opacity }}>
        <m.g style={{ rotate }}>
          <g transform="translate(-7 -7)">
            <Plane width={14} height={14} strokeWidth={1.5} color="rgba(242, 241, 236, 0.9)" />
          </g>
        </m.g>
      </m.g>
    </svg>
  );
}

/**
 * Looking out of a cabin window at dusk: footage (far), two drifting cloud bands, the breathing
 * sun, grain, and a faint flight path on the empty right side. Layers shift opposite the cursor
 * by different amounts (desktop only); scroll scales and softens the whole stack.
 */
export function HeroBackground({
  reduced,
  pointerX,
  pointerY,
  scale,
  blur,
}: {
  reduced: boolean;
  pointerX: MotionValue<number>;
  pointerY: MotionValue<number>;
  scale: MotionValue<number>;
  blur: MotionValue<string>;
}) {
  const videoX = useParallax(pointerX, PARALLAX_PX.video);
  const videoY = useParallax(pointerY, PARALLAX_PX.video);
  const farX = useParallax(pointerX, PARALLAX_PX.cloudsFar);
  const farY = useParallax(pointerY, PARALLAX_PX.cloudsFar);
  const nearX = useParallax(pointerX, PARALLAX_PX.cloudsNear);
  const nearY = useParallax(pointerY, PARALLAX_PX.cloudsNear);
  const pathX = useParallax(pointerX, PARALLAX_PX.path);
  const pathY = useParallax(pointerY, PARALLAX_PX.path);

  return (
    <div className="absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <m.div className="absolute inset-0" style={{ scale, filter: blur }}>
        {/* Oversized by the largest parallax travel so no edge is ever revealed. */}
        <m.div className="absolute -inset-6" style={{ x: videoX, y: videoY }}>
          <DuskFootage reduced={reduced} />
        </m.div>
        <m.div className="absolute -inset-8" style={{ x: farX, y: farY }}>
          <div className="hero-cloud hero-cloud--far" />
          <div className="hero-sun" />
        </m.div>
        <m.div className="absolute -inset-8" style={{ x: nearX, y: nearY }}>
          <div className="hero-cloud hero-cloud--near" />
        </m.div>
      </m.div>

      {/* Readability: darken overall, more on the left (copy) and at the bottom (stats). */}
      <div className="absolute inset-0 bg-black/45" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(1,1,1,0.78)_0%,rgba(1,1,1,0.45)_45%,rgba(1,1,1,0.1)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-72 bg-gradient-to-b from-transparent to-ground" />

      <m.div
        className="absolute right-[3%] top-[14%] hidden aspect-[5/3] w-[min(44vw,640px)] opacity-80 lg:block"
        style={{ x: pathX, y: pathY }}
      >
        <FlightPath reduced={reduced} />
      </m.div>

      <div className="absolute inset-0 overflow-hidden">
        <div className="hero-grain" />
      </div>
    </div>
  );
}
