/**
 * The landing globe (React Three Fiber). Lazy-loaded after first paint, so three.js never sits in
 * the eager bundle. Everything it draws is real: Natural Earth and Census outlines (world-atlas,
 * us-atlas), airports at their airports.csv coordinates (via /api/meta), airport beacons from the
 * origin delay-rate ranking, route arcs from the route ranking, and a selected airport's busiest
 * destinations from /api/routes. Scroll, cursor, drag and zoom arrive through the render-free
 * `globe` store; hover and selection through its interaction state, which the DOM panels share.
 *
 * The dataset is US domestic only, so the camera lives over the lower 48. It pulls back only to
 * take in Alaska and Hawaii (volume chapter), the continent (model) and the planet (hand-off).
 *
 * Layers live in Earth.tsx (planet, atmosphere, lines, stars), Airports.tsx and Routes.tsx; this
 * file owns the camera rig, the controls and the canvas.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Group } from 'three';
import { Airports, type AirportPoint, type AirportStat } from './Airports';
import { Coastlines, Earth, Graticule, Stars, UsLines } from './Earth';
import {
  angleBetween,
  fitSize,
  frame,
  introShot,
  latLonToVec3,
  nearestTurn,
  poseAt,
  vec3ToLatLon,
  type ArcKind,
  type Pose,
  type RouteArc,
} from './geo';
import { Routes, useArcCurves } from './Routes';
import { damp, LIVE, resetDrawClock } from './shaders';
import { clearSelection, getInteraction, getSteerRoute, globe, subscribe, zoomBy } from './store';

const RAD = Math.PI / 180;
/**
 * Vertical field of view, degrees: a long lens, so the camera stands well back and the country
 * reads flat and true to shape even when it fills the frame.
 */
const FOV = 16;
/** Never closer than this globe size, so points stay points and the camera stays above the arcs. */
const SIZE_MAX = 2.9;
/** The establishing shot on load, seconds: from the whole planet down onto the US. */
const INTRO_AT = 0.15;
const INTRO_S = 3.4;
/** Auto-rotation resumes this long after the last drag or zoom, ms. */
const IDLE_MS = 2600;
/** Full-speed auto-rotation, degrees per second (one turn a minute). */
const SPIN_DEG_S = 6;
/**
 * Hold-still sway around the framed point, degrees and radians per second. Small: over the US a
 * wide sway would carry a coast out of frame.
 */
const SWAY_DEG = 3.5;
const SWAY_RATE = 0.11;
/** Camera easing, per second: slow enough to read as a camera move, never a cut. */
const EASE = 1.9;
/** Where a selection is framed on desktop: left of the details panel, right of the copy. */
const SELECT_X = 0.16;

/**
 * Chapter poses: hero, volume, routes, predict, model, hand-off. Size and offsets are fractions
 * of the viewport (see geo.frame); the faced point (lat, lon) lands at (x, y). The camera is close,
 * so the near surface reads about a third larger than `size` alone. `tilt` (degrees) leans the
 * globe back about the faced point so the departure columns stand up; `spin` (0..1) blends the
 * hold-still sway into continuous auto-rotation; `beacons` is the columns' brightness. On desktop
 * the copy holds the left third, so the lower 48 fill the right two thirds.
 */
type ChapterPose = Pose & { spin: number; beacons: number; tilt: number };
const DESKTOP_POSES: ChapterPose[] = [
  // Hero: the lower 48, coast to coast on the right, leaning back like a view from the south.
  { lat: 38, lon: -96.5, size: 2.1, x: 0.37, y: -0.06, arcs: 1, airports: 1, spin: 0, beacons: 0.8, tilt: 34 },
  // Volume: back far enough to take in Alaska and Hawaii, the columns at full strength.
  { lat: 40, lon: -121, size: 1.0, x: 0.4, y: -0.04, arcs: 0.25, airports: 1.4, spin: 0, beacons: 1, tilt: 30 },
  // Routes: the lower 48 again, flatter so the arcs read, the columns stepped back.
  { lat: 37.5, lon: -96, size: 2.05, x: 0.37, y: -0.04, arcs: 1, airports: 0.9, spin: 0, beacons: 0.35, tilt: 18 },
  // Predict: closer and steeper, the delay colours up.
  { lat: 36, lon: -95, size: 2.35, x: 0.36, y: -0.12, arcs: 0.55, airports: 1, spin: 0, beacons: 1, tilt: 44 },
  // Model: the continent, turning slowly.
  { lat: 32, lon: -95, size: 0.85, x: 0.32, y: 0, arcs: 0.45, airports: 0.8, spin: 0.35, beacons: 0.6, tilt: 8 },
  // Hand-off: the whole planet, low behind the links.
  { lat: 26, lon: -97, size: 0.46, x: 0, y: 0.3, arcs: 0.55, airports: 0.8, spin: 1, beacons: 0.4, tilt: 0 },
];
/**
 * Phones: the globe sits in the top half, above the copy. Size is measured against the half-width
 * on a portrait screen, so the lower 48 span it edge to edge.
 */
const MOBILE_SIZES = [1.9, 1.0, 1.85, 2.0, 0.85, 0.66];
const MOBILE_POSES: ChapterPose[] = DESKTOP_POSES.map((pose, index) => ({
  ...pose,
  size: MOBILE_SIZES[index]!,
  x: 0,
  y: index === 5 ? 0.42 : 0.5,
}));

function poseFor(poses: readonly ChapterPose[], chapter: number): ChapterPose {
  const pose = poseAt(poses, chapter);
  const index = Math.min(poses.length - 1, Math.max(0, chapter));
  const low = poses[Math.floor(index)]!;
  const high = poses[Math.ceil(index)]!;
  const t = index - Math.floor(index);
  const ease = t * t * (3 - 2 * t);
  return {
    ...pose,
    spin: low.spin + (high.spin - low.spin) * ease,
    beacons: low.beacons + (high.beacons - low.beacons) * ease,
    tilt: low.tilt + (high.tilt - low.tilt) * ease,
  };
}

/** What the camera frames for a selection: the faced point and the globe size that fits it. */
interface Focus {
  lat: number;
  lon: number;
  size: number;
}

/** A route: its great-circle midpoint, close for a short hop and further back for a long haul. */
function routeFocus(arc: RouteArc): Focus {
  const [a, b] = [arc.points[0]!, arc.points[arc.points.length - 1]!];
  const angle = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  return { ...arc.mid, size: fitSize(angle * 1.5, 1.1, SIZE_MAX) };
}

/**
 * A selected airport: the middle of it and its destinations, sized so the farthest one fits. Until
 * the destinations arrive, the airport itself, at a regional framing.
 */
function airportFocus(airport: AirportPoint, network: readonly RouteArc[]): Focus {
  const home = { lat: airport.latitude, lon: airport.longitude };
  if (network.length === 0) return { ...home, size: 2.2 };
  let [sx, sy, sz] = [0, 0, 0];
  const ends = [home, ...network.map((arc) => vec3ToLatLon(arc.points[arc.points.length - 1]!))];
  for (const end of ends) {
    const [x, y, z] = latLonToVec3(end.lat, end.lon, 1);
    sx += x;
    sy += y;
    sz += z;
  }
  const centre = vec3ToLatLon([sx, sy, sz]);
  const reach = Math.max(...ends.map((end) => angleBetween(centre, end)));
  return { ...centre, size: fitSize(reach * 1.3, 1.85, 2.8) };
}

// ---------- Rig: chapter pose, intro shot, auto-rotation, drag, zoom, steering ----------

function Rig({
  children,
  arcs,
  airports,
  reduced,
}: {
  children: ReactNode;
  arcs: readonly RouteArc[];
  airports: ReadonlyMap<string, AirportPoint>;
  reduced: boolean;
}) {
  const outer = useRef<Group>(null);
  const tilt = useRef<Group>(null);
  const group = useRef<Group>(null);
  const mobile = useThree((state) => state.size.width < 768);
  const poses = mobile ? MOBILE_POSES : DESKTOP_POSES;
  const motion = useRef({ first: true, spin: 0, chapter: 0, roll: 0, tilt: 0 });
  const network = useMemo(() => arcs.filter((arc) => arc.kind === 'network'), [arcs]);

  useFrame((state, delta) => {
    const node = group.current;
    const frameNode = outer.current;
    const tiltNode = tilt.current;
    if (!node || !frameNode || !tiltNode) return;
    const m = motion.current;
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    LIVE.uTime.value = t;

    // A new chapter starts from its own framing: drop any selection and any visitor zoom.
    const chapter = Math.round(globe.chapter);
    if (chapter !== m.chapter) {
      m.chapter = chapter;
      globe.zoom = 1;
      const { selected, selectedAirport } = getInteraction();
      if (selected || selectedAirport) clearSelection();
    }

    const pose = poseFor(poses, globe.chapter);
    const steer = getSteerRoute();
    const steerArc = steer ? arcs.find((arc) => arc.id === steer) : undefined;
    const airportCode = getInteraction().selectedAirport;
    const airport = airportCode ? airports.get(airportCode) : undefined;
    const focus: Focus | undefined = steerArc
      ? routeFocus(steerArc)
      : airport
        ? airportFocus(airport, network)
        : undefined;
    const idle = !globe.dragging && performance.now() - globe.lastInteraction > IDLE_MS && !focus;

    // Auto-rotation accumulates only while idle; otherwise it settles on a whole turn, so the
    // framing returns without an unwinding spin.
    if (!reduced && idle && pose.spin > 0.02) m.spin += dt * SPIN_DEG_S * pose.spin;
    else if (pose.spin <= 0.02 || focus) m.spin = damp(m.spin, nearestTurn(m.spin), 1.2, dt);
    if (!reduced && idle) {
      globe.dragLon *= Math.exp(-dt * 0.5);
      globe.dragLat *= Math.exp(-dt * 0.5);
    }

    const intro = reduced ? introShot(1) : introShot((t - INTRO_AT) / INTRO_S);
    const sway = reduced || focus ? 0 : Math.sin(t * SWAY_RATE) * SWAY_DEG * (1 - pose.spin);
    const lon =
      (focus?.lon ?? pose.lon) + intro.lon + sway + m.spin + globe.dragLon + globe.pointerX * 1.6;
    const lat = (focus?.lat ?? pose.lat) + intro.lat + globe.dragLat + globe.pointerY * 1.2;

    // A board-hovered route only turns the globe; a selection also frames it.
    const selecting = focus !== undefined && (airport !== undefined || getInteraction().selected);
    const baseSize = selecting ? focus.size : pose.size;
    const size = Math.min(SIZE_MAX, baseSize * intro.size * globe.zoom);
    globe.size = size;
    const x = selecting && !mobile ? SELECT_X : pose.x;
    const target = frame({ ...pose, x, size }, state.size.width / state.size.height, FOV);

    // Snap on the first frame (no swing in from 0,0) and under reduced motion; ease otherwise.
    const rate = m.first || reduced ? Infinity : EASE;
    m.first = false;
    node.rotation.y = damp(node.rotation.y, -lon * RAD, rate * 1.3, dt);
    node.rotation.x = damp(node.rotation.x, lat * RAD, rate * 1.3, dt);
    frameNode.position.x = damp(frameNode.position.x, target.x - globe.pointerX * 0.03, rate, dt);
    frameNode.position.y = damp(frameNode.position.y, target.y + globe.pointerY * 0.02, rate, dt);
    state.camera.position.z = damp(state.camera.position.z, target.distance, rate, dt);
    // The globe sits off-centre, so the point facing +z is not the one in the middle of the visible
    // disc. Aim the faced point at the camera, so it lands exactly where the pose puts it.
    const { x: gx, y: gy } = frameNode.position;
    const toCamera = Math.hypot(gx, gy, state.camera.position.z);
    frameNode.rotation.y = Math.atan2(-gx, state.camera.position.z);
    frameNode.rotation.x = Math.asin(gy / toCamera);
    // A faint camera roll with the cursor: the view banks a little, like a window seat.
    m.roll = damp(m.roll, reduced ? 0 : -globe.pointerX * 0.03, 3, dt);
    // Lean back about the faced point; the establishing shot starts flat and tips over as it lands.
    const lean = pose.tilt * Math.min(1, Math.max(0, (intro.size - 0.2) / 0.8)) * (selecting ? 0.85 : 1);
    m.tilt = damp(m.tilt, lean, rate, dt);
    tiltNode.rotation.x = -m.tilt * RAD;
    state.camera.rotation.z = m.roll;
    LIVE.uArcs.value = damp(LIVE.uArcs.value, pose.arcs, rate, dt);
    LIVE.uBright.value = damp(LIVE.uBright.value, pose.airports, rate, dt);
    LIVE.uBeacons.value = damp(LIVE.uBeacons.value, pose.beacons, rate, dt);
  });

  return (
    // Outer: position and camera aim (YXZ: tilt, then turn). Inner, default XYZ (Rx * Ry): a point
    // turns by longitude first, then latitude.
    // Tilt: pivots about the faced surface point (0, 0, 1), so the framing holds while it leans.
    <group ref={outer} rotation-order="YXZ">
      <group ref={tilt} position={[0, 0, 1]}>
        <group ref={group} position={[0, 0, -1]}>
          {children}
        </group>
      </group>
    </group>
  );
}

/** The canvas cursor: grab over open globe, grabbing mid-drag, pointer over anything pickable. */
function setCursor(element: HTMLElement, cursor: string): void {
  element.style.cursor = cursor;
}

/** Mouse drag rotates; Ctrl/Cmd + wheel and double-click zoom (plain wheel keeps scrolling the page). */
function Controls({ reduced }: { reduced: boolean }) {
  const element = useThree((state) => state.gl.domElement);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    let last: { x: number; y: number } | null = null;
    setCursor(element, 'grab');
    const touch = () => {
      globe.lastInteraction = performance.now();
      if (reduced) invalidate();
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      last = { x: event.clientX, y: event.clientY };
      globe.dragging = true;
      setCursor(element, 'grabbing');
      element.setPointerCapture(event.pointerId);
      touch();
    };
    const move = (event: PointerEvent) => {
      if (!last) return;
      // Degrees per pixel shrink as the camera closes in, so the ground tracks the cursor.
      const scale = 0.3 / Math.max(0.5, globe.size);
      globe.dragLon -= (event.clientX - last.x) * scale;
      globe.dragLat = Math.max(
        -35,
        Math.min(35, globe.dragLat + (event.clientY - last.y) * scale * 0.8),
      );
      last = { x: event.clientX, y: event.clientY };
      touch();
    };
    const up = () => {
      if (!last) return;
      last = null;
      globe.dragging = false;
      setCursor(element, 'grab');
      touch();
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(Math.exp(-event.deltaY * 0.0018));
      touch();
    };
    const doubleClick = () => {
      zoomBy(globe.zoom > 1.5 ? 1 / globe.zoom : 1.4);
      touch();
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('dblclick', doubleClick);
    return () => {
      setCursor(element, '');
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('dblclick', doubleClick);
    };
  }, [element, invalidate, reduced]);
  return null;
}

/** Shows a pointer over anything pickable, and the grab hand elsewhere. */
function HoverCursor({ interactive }: { interactive: boolean }) {
  const element = useThree((state) => state.gl.domElement);
  useEffect(
    () =>
      subscribe(() => {
        if (globe.dragging) return;
        const hovering = getInteraction().hover !== null;
        setCursor(element, hovering ? 'pointer' : interactive ? 'grab' : '');
      }),
    [element, interactive],
  );
  return null;
}

/**
 * Under reduced motion the canvas renders on demand; any hover, selection or zoom change asks for
 * a frame so the result still shows, instantly.
 */
function Invalidator() {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => subscribe(() => invalidate()), [invalidate]);
  return null;
}

export interface GlobeSceneProps {
  /** Ranked routes plus, while an airport is selected, its network. */
  arcs: readonly RouteArc[];
  airports: readonly AirportPoint[];
  /** Departures and delay rate per airport, for the beacons (may be empty while loading). */
  stats: ReadonlyMap<string, AirportStat>;
  /** The national delay rate the beacon colours are measured against. */
  national: number | null;
  reduced: boolean;
  /** Fine pointer and wide enough for hover, drag and zoom. Taps select on every device. */
  interactive: boolean;
  onReady: () => void;
}

export default function GlobeScene({
  arcs,
  airports,
  stats,
  national,
  reduced,
  interactive,
  onReady,
}: GlobeSceneProps) {
  const curves = useArcCurves(arcs);
  const anchors = useMemo(() => {
    const map = new Map<string, Set<ArcKind>>();
    for (const arc of arcs) {
      for (const code of [arc.origin, arc.dest]) {
        const kinds = map.get(code) ?? new Set<ArcKind>();
        kinds.add(arc.kind);
        map.set(code, kinds);
      }
    }
    return map;
  }, [arcs]);
  const airportsByCode = useMemo(
    () => new Map(airports.map((airport) => [airport.code, airport])),
    [airports],
  );

  useEffect(
    () => () => {
      resetDrawClock();
      LIVE.uArcs.value = 1;
      LIVE.uBright.value = 1;
      LIVE.uBeacons.value = 1;
    },
    [],
  );

  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ fov: FOV, near: 0.05, far: 200, position: [0, 0, 12] }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      raycaster={{
        params: {
          Mesh: {},
          Line: { threshold: 1 },
          LOD: {},
          Points: { threshold: 0.012 },
          Sprite: {},
        },
      }}
      frameloop={reduced ? 'demand' : 'always'}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        requestAnimationFrame(onReady);
      }}
    >
      <Stars />
      <Rig arcs={arcs} airports={airportsByCode} reduced={reduced}>
        <Earth onEmptyClick />
        <Graticule />
        <Coastlines />
        <UsLines />
        <Airports
          airports={airports}
          anchors={anchors}
          stats={stats}
          national={national}
          reduced={reduced}
          hoverable={interactive}
        />
        <Routes curves={curves} reduced={reduced} hoverable={interactive} />
      </Rig>
      {interactive ? <Controls reduced={reduced} /> : null}
      <HoverCursor interactive={interactive} />
      {reduced ? <Invalidator /> : null}
    </Canvas>
  );
}
