/**
 * The landing globe (React Three Fiber). Lazy-loaded after first paint, so three.js never sits in
 * the eager bundle. Everything it draws is real: 110m Natural Earth coastlines (world-atlas),
 * airports at their airports.csv coordinates (via /api/meta) and route arcs from the delay-rate
 * ranking. Scroll, cursor, drag and zoom arrive through the render-free `globe` store; hover and
 * selection through its interaction state, which the DOM panels share.
 *
 * Layers live in Earth.tsx (planet, atmosphere, lines, stars), Airports.tsx and Routes.tsx; this
 * file owns the camera rig, the controls and the canvas.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Group } from 'three';
import { Airports, type AirportPoint } from './Airports';
import { Coastlines, Earth, Graticule, Stars } from './Earth';
import {
  frame,
  introShot,
  nearestTurn,
  poseAt,
  type ArcKind,
  type Pose,
  type RouteArc,
} from './geo';
import { Routes, useArcCurves } from './Routes';
import { damp, LIVE, resetDrawClock } from './shaders';
import { getInteraction, getSteerRoute, globe, setSelected, subscribe, zoomBy } from './store';

const RAD = Math.PI / 180;
/** Vertical field of view, degrees: long-lens and flat, like a photograph from orbit. */
const FOV = 30;
/** The establishing shot on load, seconds. */
const INTRO_AT = 0.15;
const INTRO_S = 2.8;
/** Auto-rotation resumes this long after the last drag or zoom, ms. */
const IDLE_MS = 2600;
/** Full-speed auto-rotation, degrees per second (one turn a minute). */
const SPIN_DEG_S = 6;
/** Hold-still sway around the framed longitude, degrees and radians per second. */
const SWAY_DEG = 16;
const SWAY_RATE = 0.085;
/** A selected route pulls the camera in: further for a short hop, less for a long haul. */
function selectZoom(arc: RouteArc): number {
  const [a, b] = [arc.points[0]!, arc.points[arc.points.length - 1]!];
  const angle = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  return Math.min(1.8, Math.max(1.2, 0.5 / Math.max(angle, 1e-3)));
}

/**
 * Chapter poses: hero, volume, routes, predict, model, hand-off. Size and offsets are fractions
 * of the viewport (see geo.frame), so the framing holds at any aspect ratio. `spin` (0..1) blends
 * the hold-still sway into continuous auto-rotation.
 */
type ChapterPose = Pose & { spin: number };
const DESKTOP_POSES: ChapterPose[] = [
  { lat: 34, lon: -97, size: 0.84, x: 0.5, y: -0.02, arcs: 1, airports: 1, spin: 0 },
  { lat: 41, lon: -96, size: 0.62, x: 0.46, y: 0, arcs: 0.25, airports: 1.8, spin: 0 },
  { lat: 38, lon: -96, size: 1.25, x: 0.46, y: -0.05, arcs: 1, airports: 0.9, spin: 0 },
  { lat: 30, lon: -108, size: 0.82, x: 0.5, y: 0.02, arcs: 0.6, airports: 1, spin: 0 },
  { lat: 24, lon: -86, size: 0.52, x: 0.5, y: 0, arcs: 0.45, airports: 0.8, spin: 0.6 },
  { lat: 26, lon: -97, size: 0.4, x: 0, y: 0.3, arcs: 0.55, airports: 0.8, spin: 1 },
];
/** Phones: the globe sits in the top half, behind and above the copy. */
const MOBILE_POSES: ChapterPose[] = DESKTOP_POSES.map((pose, index) => ({
  ...pose,
  size: index === 2 ? 1.1 : 0.82,
  x: 0,
  y: 0.46,
}));

function poseFor(poses: readonly ChapterPose[], chapter: number): ChapterPose {
  const pose = poseAt(poses, chapter);
  const index = Math.min(poses.length - 1, Math.max(0, chapter));
  const low = poses[Math.floor(index)]!;
  const high = poses[Math.ceil(index)]!;
  const t = index - Math.floor(index);
  return { ...pose, spin: low.spin + (high.spin - low.spin) * t * t * (3 - 2 * t) };
}

// ---------- Rig: chapter pose, intro shot, auto-rotation, drag, zoom, steering ----------

function Rig({
  children,
  arcs,
  reduced,
}: {
  children: ReactNode;
  arcs: readonly RouteArc[];
  reduced: boolean;
}) {
  const outer = useRef<Group>(null);
  const group = useRef<Group>(null);
  const mobile = useThree((state) => state.size.width < 768);
  const poses = mobile ? MOBILE_POSES : DESKTOP_POSES;
  const motion = useRef({ first: true, spin: 0, chapter: 0, roll: 0, aim: 0 });

  useFrame((state, delta) => {
    const node = group.current;
    const frameNode = outer.current;
    if (!node || !frameNode) return;
    const m = motion.current;
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    LIVE.uTime.value = t;

    // A new chapter starts from its own framing: drop the selection and any visitor zoom.
    const chapter = Math.round(globe.chapter);
    if (chapter !== m.chapter) {
      m.chapter = chapter;
      globe.zoom = 1;
      if (getInteraction().selected) setSelected(null);
    }

    const pose = poseFor(poses, globe.chapter);
    const steer = getSteerRoute();
    const facing = steer ? arcs.find((arc) => arc.id === steer)?.mid : undefined;
    const idle = !globe.dragging && performance.now() - globe.lastInteraction > IDLE_MS && !facing;

    // Auto-rotation accumulates only while idle; otherwise it settles on a whole turn, so the
    // framing returns without an unwinding spin.
    if (!reduced && idle && pose.spin > 0.02) m.spin += dt * SPIN_DEG_S * pose.spin;
    else if (pose.spin <= 0.02 || facing) m.spin = damp(m.spin, nearestTurn(m.spin), 1.2, dt);
    if (!reduced && idle) {
      globe.dragLon *= Math.exp(-dt * 0.5);
      globe.dragLat *= Math.exp(-dt * 0.5);
    }

    const intro = reduced ? introShot(1) : introShot((t - INTRO_AT) / INTRO_S);
    const sway = reduced || facing ? 0 : Math.sin(t * SWAY_RATE) * SWAY_DEG * (1 - pose.spin);
    const lon =
      (facing?.lon ?? pose.lon) + intro.lon + sway + m.spin + globe.dragLon + globe.pointerX * 5;
    const lat = (facing?.lat ?? pose.lat) + intro.lat + globe.dragLat + globe.pointerY * 3;

    const selected = getInteraction().selected;
    const selectedArc = selected ? arcs.find((arc) => arc.id === selected) : undefined;
    const size = pose.size * intro.size * globe.zoom * (selectedArc ? selectZoom(selectedArc) : 1);
    const target = frame({ ...pose, size }, state.size.width / state.size.height, FOV);

    // Snap on the first frame (no swing in from 0,0) and under reduced motion; damp otherwise.
    const rate = m.first || reduced ? Infinity : 2.4;
    m.first = false;
    node.rotation.y = damp(node.rotation.y, -lon * RAD, rate, dt);
    node.rotation.x = damp(node.rotation.x, lat * RAD, rate, dt);
    frameNode.position.x = damp(frameNode.position.x, target.x - globe.pointerX * 0.05, rate, dt);
    frameNode.position.y = damp(frameNode.position.y, target.y + globe.pointerY * 0.04, rate, dt);
    state.camera.position.z = damp(state.camera.position.z, target.distance, rate, dt);
    // The globe sits off-centre and the camera is close, so the point facing +z is not the middle
    // of the visible disc. While steering to a route, aim the faced point at the camera instead.
    m.aim = damp(m.aim, facing ? 1 : 0, rate, dt);
    const { x: gx, y: gy } = frameNode.position;
    const toCamera = Math.hypot(gx, gy, state.camera.position.z);
    frameNode.rotation.y = m.aim * Math.atan2(-gx, state.camera.position.z);
    frameNode.rotation.x = m.aim * Math.asin(gy / toCamera);
    // A faint camera roll with the cursor: the view banks a little, like a window seat.
    m.roll = damp(m.roll, reduced ? 0 : -globe.pointerX * 0.035, 3, dt);
    state.camera.rotation.z = m.roll;
    LIVE.uArcs.value = damp(LIVE.uArcs.value, pose.arcs, rate, dt);
    LIVE.uBright.value = damp(LIVE.uBright.value, pose.airports, rate, dt);
  });

  return (
    // Outer: position and camera aim (YXZ: tilt, then turn). Inner, default XYZ (Rx * Ry): a point
    // turns by longitude first, then latitude.
    <group ref={outer} rotation-order="YXZ">
      <group ref={group}>{children}</group>
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
      const scale = 0.24 / globe.zoom;
      globe.dragLon -= (event.clientX - last.x) * scale;
      globe.dragLat = Math.max(
        -35,
        Math.min(35, globe.dragLat + (event.clientY - last.y) * scale * 0.7),
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
      zoomBy(globe.zoom > 1.6 ? 1 / globe.zoom : 1.5);
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
  arcs: readonly RouteArc[];
  airports: readonly AirportPoint[];
  reduced: boolean;
  /** Fine pointer and wide enough for hover, drag and zoom. Taps select on every device. */
  interactive: boolean;
  onReady: () => void;
}

export default function GlobeScene({
  arcs,
  airports,
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

  useEffect(
    () => () => {
      resetDrawClock();
      LIVE.uArcs.value = 1;
      LIVE.uBright.value = 1;
    },
    [],
  );

  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ fov: FOV, near: 0.1, far: 200, position: [0, 0, 5] }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      raycaster={{ params: { Mesh: {}, Line: { threshold: 1 }, LOD: {}, Points: { threshold: 0.014 }, Sprite: {} } }}
      frameloop={reduced ? 'demand' : 'always'}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        requestAnimationFrame(onReady);
      }}
    >
      <Stars />
      <Rig arcs={arcs} reduced={reduced}>
        <Earth onEmptyClick />
        <Graticule />
        <Coastlines />
        <Airports airports={airports} anchors={anchors} reduced={reduced} hoverable={interactive} />
        <Routes curves={curves} reduced={reduced} hoverable={interactive} />
      </Rig>
      {interactive ? <Controls reduced={reduced} /> : null}
      <HoverCursor interactive={interactive} />
      {reduced ? <Invalidator /> : null}
    </Canvas>
  );
}
