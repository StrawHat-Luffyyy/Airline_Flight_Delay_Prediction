/**
 * The landing globe (React Three Fiber). Lazy-loaded after first paint, so three.js never sits in
 * the eager bundle. Everything it draws is real: 110m Natural Earth coastlines (world-atlas),
 * airports at their airports.csv coordinates (via /api/meta), and route arcs from the delay-rate
 * ranking. Scroll, cursor and focus arrive through the render-free `globe` store, read in useFrame.
 */
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  type Group,
  type ShaderMaterial,
  TubeGeometry,
  Vector3,
} from 'three';
import { mesh } from 'topojson-client';
import type { GeometryObject, Topology } from 'topojson-specification';
import land from 'world-atlas/land-110m.json';
import { frame, latLonToVec3, poseAt, type Pose, type RouteArc } from './geo';
import { getFocusRoute, getSteerRoute, globe, setFocusRoute, subscribeFocus } from './store';

const RAD = Math.PI / 180;
/** Vertical field of view, degrees: long-lens and flat, like a photograph from orbit. */
const FOV = 30;

// Data colours from DESIGN.md (amber = delayed, blue = on time). Atmosphere tones are hero-only.
const AMBER = new Color('#e8a54b');
const BLUE = new Color('#7c9bd1');
const INK = new Color('#f2f1ec');
const LIMB = new Color('#a9b8cc');

/**
 * Chapter poses: hero, volume, routes, predict, model, hand-off. Size and offsets are fractions
 * of the viewport (see geo.frame), so the framing holds at any aspect ratio.
 */
const DESKTOP_POSES: Pose[] = [
  { lat: 34, lon: -97, size: 0.84, x: 0.5, y: -0.02, arcs: 1, airports: 1 },
  { lat: 41, lon: -96, size: 0.62, x: 0.46, y: 0, arcs: 0.2, airports: 1.8 },
  { lat: 38, lon: -96, size: 1.25, x: 0.46, y: -0.05, arcs: 1, airports: 0.9 },
  { lat: 30, lon: -108, size: 0.82, x: 0.5, y: 0.02, arcs: 0.55, airports: 1 },
  { lat: 24, lon: -86, size: 0.52, x: 0.5, y: 0, arcs: 0.35, airports: 0.8 },
  { lat: 34, lon: -97, size: 0.4, x: 0, y: 0.3, arcs: 0.5, airports: 0.8 },
];
/** Phones: the globe sits in the top half, behind and above the copy. */
const MOBILE_POSES: Pose[] = DESKTOP_POSES.map((pose, index) => ({
  ...pose,
  size: index === 2 ? 1.1 : 0.82,
  x: 0,
  y: 0.46,
}));

/**
 * Uniforms every arc and airport shares, written once per frame by the Rig (inside useFrame,
 * never during render). One globe is mounted at a time, so one set suffices.
 */
const LIVE = {
  uTime: { value: 0 },
  uArcs: { value: 1 },
  uBright: { value: 1 },
};

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/** Deterministic PRNG for the star field (the same sky on every visit). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function positions(points: readonly (readonly number[])[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points.flat()), 3));
  return geometry;
}

// ---------- Earth, limb and lines ----------

const earthVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const earthFragment = /* glsl */ `
  uniform vec3 uLimb;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float facing = clamp(dot(vNormal, vView), 0.0, 1.0);
    float rim = pow(1.0 - facing, 3.0);
    float key = max(dot(vNormal, normalize(vec3(-0.6, 0.5, 0.6))), 0.0);
    vec3 color = vec3(0.012, 0.016, 0.022) + uLimb * (rim * 0.2 + key * 0.025);
    gl_FragColor = vec4(color, 1.0);
  }
`;
const limbFragment = /* glsl */ `
  uniform vec3 uLimb;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float glow = pow(clamp(0.72 - dot(vNormal, vView), 0.0, 1.0), 3.5);
    gl_FragColor = vec4(uLimb, glow * 0.34);
  }
`;

function Earth() {
  const uniforms = useMemo(() => ({ uLimb: { value: LIMB } }), []);
  return (
    <>
      <mesh renderOrder={0}>
        <sphereGeometry args={[0.998, 96, 64]} />
        <shaderMaterial
          vertexShader={earthVertex}
          fragmentShader={earthFragment}
          uniforms={uniforms}
        />
      </mesh>
      <mesh scale={1.07}>
        <sphereGeometry args={[1, 64, 48]} />
        <shaderMaterial
          vertexShader={earthVertex}
          fragmentShader={limbFragment}
          uniforms={uniforms}
          side={BackSide}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </mesh>
    </>
  );
}

/** Coastlines as line segments just above the surface. */
function Coastlines() {
  const geometry = useMemo(() => {
    const topology = land as unknown as Topology;
    const object = topology.objects.land as GeometryObject;
    const lines = mesh(topology, object).coordinates;
    const segments: number[][] = [];
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i += 1) {
        const [lonA, latA] = line[i]!;
        const [lonB, latB] = line[i + 1]!;
        segments.push(
          [...latLonToVec3(latA!, lonA!, 1.0015)],
          [...latLonToVec3(latB!, lonB!, 1.0015)],
        );
      }
    }
    return positions(segments);
  }, []);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={INK} transparent opacity={0.26} depthWrite={false} />
    </lineSegments>
  );
}

/** A 15-degree latitude/longitude net, barely there. */
function Graticule() {
  const geometry = useMemo(() => {
    const segments: number[][] = [];
    const push = (a: readonly number[], b: readonly number[]) => segments.push([...a], [...b]);
    for (let lat = -75; lat <= 75; lat += 15) {
      for (let lon = -180; lon < 180; lon += 3) {
        push(latLonToVec3(lat, lon, 1.001), latLonToVec3(lat, lon + 3, 1.001));
      }
    }
    for (let lon = -180; lon < 180; lon += 15) {
      for (let lat = -84; lat < 84; lat += 3) {
        push(latLonToVec3(lat, lon, 1.001), latLonToVec3(lat + 3, lon, 1.001));
      }
    }
    return positions(segments);
  }, []);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={INK} transparent opacity={0.045} depthWrite={false} />
    </lineSegments>
  );
}

// ---------- Airports ----------

const pointVertex = /* glsl */ `
  attribute float aSize;
  attribute float aSeed;
  uniform float uTime;
  uniform float uBright;
  uniform float uPixelRatio;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float twinkle = 0.78 + 0.22 * sin(uTime * 1.1 + aSeed * 6.2831);
    vAlpha = twinkle * uBright;
    gl_PointSize = aSize * uPixelRatio * (3.2 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const pointFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float core = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor, core * core * vAlpha);
  }
`;

interface AirportPoint {
  code: string;
  latitude: number;
  longitude: number;
}

function Airports({
  airports,
  endpoints,
}: {
  airports: readonly AirportPoint[];
  endpoints: ReadonlySet<string>;
}) {
  const pixelRatio = useThree((state) => state.viewport.dpr);
  const material = useRef<ShaderMaterial>(null);
  const geometry = useMemo(() => {
    const geo = positions(airports.map((a) => [...latLonToVec3(a.latitude, a.longitude, 1.003)]));
    geo.setAttribute(
      'aSize',
      new BufferAttribute(
        new Float32Array(airports.map((a) => (endpoints.has(a.code) ? 7 : 3.4))),
        1,
      ),
    );
    const random = mulberry32(7);
    geo.setAttribute(
      'aSeed',
      new BufferAttribute(new Float32Array(airports.map(() => random())), 1),
    );
    return geo;
  }, [airports, endpoints]);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uBright: LIVE.uBright,
      uPixelRatio: { value: pixelRatio },
      uColor: { value: new Color('#ffe9c4') },
    }),
    [pixelRatio],
  );
  useFrame((state) => {
    if (material.current) material.current.uniforms.uTime!.value = state.clock.elapsedTime;
  });
  return (
    <points geometry={geometry}>
      <shaderMaterial
        ref={material}
        vertexShader={pointVertex}
        fragmentShader={pointFragment}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={AdditiveBlending}
      />
    </points>
  );
}

function Stars() {
  const geometry = useMemo(() => {
    const random = mulberry32(2015);
    const points: number[][] = [];
    const sizes: number[] = [];
    const seeds: number[] = [];
    for (let i = 0; i < 900; i += 1) {
      const lat = Math.asin(random() * 2 - 1) / RAD;
      const lon = random() * 360 - 180;
      points.push([...latLonToVec3(lat, lon, 40 + random() * 20)]);
      sizes.push(random() < 0.06 ? 26 : 10 + random() * 8);
      seeds.push(random());
    }
    const geo = positions(points);
    geo.setAttribute('aSize', new BufferAttribute(new Float32Array(sizes), 1));
    geo.setAttribute('aSeed', new BufferAttribute(new Float32Array(seeds), 1));
    return geo;
  }, []);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uBright: { value: 0.32 },
      uPixelRatio: { value: 1 },
      uColor: { value: INK },
    }),
    [],
  );
  return (
    <points geometry={geometry}>
      <shaderMaterial
        vertexShader={pointVertex}
        fragmentShader={pointFragment}
        uniforms={uniforms}
        transparent
        depthWrite={false}
      />
    </points>
  );
}

// ---------- Route arcs ----------

const arcVertex = /* glsl */ `
  uniform float uWidth;
  varying float vAlong;
  void main() {
    vAlong = uv.x;
    vec3 p = position + normal * uWidth;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const arcFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uDraw;
  uniform float uPhase;
  uniform float uFocus;
  uniform float uDim;
  uniform float uArcs;
  varying float vAlong;
  void main() {
    if (vAlong > uDraw) discard;
    // A pulse runs origin to destination, then leaves the arc before it restarts.
    float head = fract(uTime * 0.11 + uPhase) * 1.35;
    float behind = head - vAlong;
    float pulse = behind >= 0.0 ? exp(-behind * 12.0) : 0.0;
    float alpha = (0.42 + pulse * 1.0) * (1.0 - uDim * 0.8) + uFocus * 0.75;
    gl_FragColor = vec4(uColor * (1.0 + uFocus * 0.35), alpha * uArcs);
  }
`;

/** Arcs draw in on load, staggered; seconds from mount. */
const DRAW_AT = 0.9;
const DRAW_S = 1.5;
const DRAW_STAGGER = 0.07;

function Arc({
  arc,
  index,
  reduced,
  interactive,
}: {
  arc: RouteArc;
  index: number;
  reduced: boolean;
  interactive: boolean;
}) {
  const material = useRef<ShaderMaterial>(null);
  const [tube, hit] = useMemo(() => {
    const curve = new CatmullRomCurve3(arc.points.map(([x, y, z]) => new Vector3(x, y, z)));
    return [new TubeGeometry(curve, 96, 0.004, 6, false), new TubeGeometry(curve, 32, 0.03, 5)];
  }, [arc.points]);
  const uniforms = useMemo(
    () => ({
      uTime: LIVE.uTime,
      uArcs: LIVE.uArcs,
      uColor: { value: arc.kind === 'late' ? AMBER : BLUE },
      uDraw: { value: reduced ? 1 : 0 },
      uPhase: { value: (index * 0.137) % 1 },
      uFocus: { value: 0 },
      uDim: { value: 0 },
      uWidth: { value: 0 },
    }),
    [arc.kind, index, reduced],
  );
  useEffect(
    () => () => {
      tube.dispose();
      hit.dispose();
    },
    [tube, hit],
  );

  useFrame((state, dt) => {
    const u = material.current?.uniforms;
    if (!u) return;
    const t = state.clock.elapsedTime;
    if (!reduced) {
      const start = DRAW_AT + index * DRAW_STAGGER;
      u.uDraw!.value = Math.min(1.001, Math.max(0, (t - start) / DRAW_S));
    }
    const focus = getFocusRoute();
    const focused = focus === arc.id ? 1 : 0;
    const dimmed = focus !== null && !focused ? 1 : 0;
    u.uFocus!.value = damp(u.uFocus!.value as number, focused, 8, dt);
    u.uDim!.value = damp(u.uDim!.value as number, dimmed, 8, dt);
    u.uWidth!.value = (u.uFocus!.value as number) * 0.0032;
  });

  const over = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setFocusRoute(arc.id);
    document.body.style.cursor = 'pointer';
  };
  const out = () => {
    if (getFocusRoute() === arc.id) setFocusRoute(null);
    document.body.style.cursor = '';
  };

  return (
    <group>
      <mesh geometry={tube} renderOrder={2}>
        <shaderMaterial
          ref={material}
          vertexShader={arcVertex}
          fragmentShader={arcFragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </mesh>
      {interactive ? (
        <mesh geometry={hit} onPointerOver={over} onPointerOut={out}>
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      ) : null}
    </group>
  );
}

// ---------- Rig: scroll pose, drift, parallax, drag ----------

function Rig({
  children,
  arcs,
  reduced,
}: {
  children: React.ReactNode;
  arcs: readonly RouteArc[];
  reduced: boolean;
}) {
  const group = useRef<Group>(null);
  const mobile = useThree((state) => state.size.width < 768);
  const poses = mobile ? MOBILE_POSES : DESKTOP_POSES;
  const first = useRef(true);

  useFrame((state, delta) => {
    const node = group.current;
    if (!node) return;
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    LIVE.uTime.value = t;
    const pose = poseAt(poses, globe.chapter);
    const target = frame(pose, state.size.width / state.size.height, FOV);
    // A route picked on a board turns to face the camera; otherwise the chapter frames the view.
    const steer = getSteerRoute();
    const facing = steer ? arcs.find((arc) => arc.id === steer)?.mid : undefined;
    const drift = reduced || facing ? 0 : Math.sin(t * 0.07) * 6;
    const lon = (facing?.lon ?? pose.lon) + drift + globe.dragLon + globe.pointerX * 5;
    const lat = (facing?.lat ?? pose.lat) + globe.dragLat + globe.pointerY * 3;
    if (!reduced) {
      globe.dragLon *= Math.exp(-dt * 0.6);
      globe.dragLat *= Math.exp(-dt * 0.6);
    }
    // Snap on the first frame (no swing in from 0,0), damp afterwards.
    const rate = first.current || reduced ? Infinity : 2.6;
    first.current = false;
    node.rotation.y = damp(node.rotation.y, -lon * RAD, rate, dt);
    node.rotation.x = damp(node.rotation.x, lat * RAD, rate, dt);
    node.position.x = damp(node.position.x, target.x - globe.pointerX * 0.05, rate, dt);
    node.position.y = damp(node.position.y, target.y + globe.pointerY * 0.04, rate, dt);
    state.camera.position.z = damp(state.camera.position.z, target.distance, rate, dt);
    LIVE.uArcs.value = damp(LIVE.uArcs.value, pose.arcs, rate, dt);
    LIVE.uBright.value = damp(LIVE.uBright.value, pose.airports, rate, dt);
  });

  return (
    // Default XYZ order: the matrix is Rx * Ry, so a point turns by longitude first, then latitude.
    <group ref={group}>
      {children}
    </group>
  );
}

/** Mouse drag spins the globe; it eases back to the chapter's framing. */
function DragControls() {
  const element = useThree((state) => state.gl.domElement);
  useEffect(() => {
    let last: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      last = { x: event.clientX, y: event.clientY };
      element.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!last) return;
      globe.dragLon -= (event.clientX - last.x) * 0.22;
      globe.dragLat = Math.max(-30, Math.min(30, globe.dragLat + (event.clientY - last.y) * 0.15));
      last = { x: event.clientX, y: event.clientY };
    };
    const up = () => {
      last = null;
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
    };
  }, [element]);
  return null;
}

/**
 * Under reduced motion the canvas renders on demand; a focus change (a board row or an arc) asks
 * for a frame so the highlight still shows, instantly.
 */
function FocusInvalidator() {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => subscribeFocus(() => invalidate()), [invalidate]);
  return null;
}

export interface GlobeSceneProps {
  arcs: readonly RouteArc[];
  airports: readonly AirportPoint[];
  reduced: boolean;
  /** Fine pointer and wide enough for hover and drag. */
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
  const endpoints = useMemo(() => new Set(arcs.flatMap((arc) => [arc.origin, arc.dest])), [arcs]);

  useEffect(
    () => () => {
      document.body.style.cursor = '';
    },
    [],
  );

  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ fov: FOV, near: 0.1, far: 200, position: [0, 0, 5] }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      frameloop={reduced ? 'demand' : 'always'}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        requestAnimationFrame(onReady);
      }}
    >
      <Stars />
      <Rig arcs={arcs} reduced={reduced}>
        <Earth />
        <Graticule />
        <Coastlines />
        <Airports airports={airports} endpoints={endpoints} />
        {arcs.map((arc, index) => (
          <Arc
            key={arc.id}
            arc={arc}
            index={index}
            reduced={reduced}
            interactive={interactive}
          />
        ))}
      </Rig>
      {interactive && !reduced ? <DragControls /> : null}
      {reduced ? <FocusInvalidator /> : null}
    </Canvas>
  );
}
