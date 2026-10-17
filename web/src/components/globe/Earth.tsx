/**
 * The planet: a night-side earth lit by a sun fixed in view space (so a terminator stays put while
 * the globe turns under it), a two-layer atmosphere, coastlines, a graticule and a star field.
 * Atmosphere tones are landing-only (DESIGN.md "Landing"), never data colours.
 */
import { useMemo } from 'react';
import { AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, Vector3 } from 'three';
import { mesh } from 'topojson-client';
import type { GeometryObject, Topology } from 'topojson-specification';
import land from 'world-atlas/land-110m.json';
import { latLonToVec3 } from './geo';
import { mulberry32, pointFragment, pointVertex } from './shaders';
import { setSelected } from './store';

const RAD = Math.PI / 180;
export const INK = new Color('#f2f1ec');
const LIMB = new Color('#a9b8cc');
const DAWN = new Color('#ffd2a1');
/** Sun direction in view space: high and to the right, slightly toward the camera. */
export const SUN = { value: new Vector3(0.62, 0.52, 0.42).normalize() };

export function positions(points: readonly (readonly number[])[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points.flat()), 3));
  return geometry;
}

const sphereVertex = /* glsl */ `
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
  uniform vec3 uSun;
  uniform vec3 uLimb;
  uniform vec3 uDawn;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    float ndl = dot(n, uSun);
    float day = smoothstep(-0.2, 0.45, ndl);
    float facing = clamp(dot(n, v), 0.0, 1.0);
    vec3 night = vec3(0.008, 0.011, 0.017);
    vec3 lit = vec3(0.032, 0.042, 0.058);
    vec3 color = mix(night, lit, day);
    // A soft sun glint, strongest where the light reflects toward the camera.
    vec3 h = normalize(uSun + v);
    color += vec3(0.75, 0.82, 0.95) * pow(max(dot(n, h), 0.0), 42.0) * 0.12 * day;
    // Rim light: cool at the limb, warming where the sun rises over it.
    float rim = pow(1.0 - facing, 2.6);
    vec3 rimColor = mix(uLimb, uDawn, smoothstep(0.1, 0.8, ndl) * 0.25);
    color += rimColor * rim * (0.08 + 0.32 * day);
    gl_FragColor = vec4(color, 1.0);
  }
`;

/** Outer shell, drawn from inside: the glow that spills past the limb. */
const haloFragment = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uLimb;
  uniform vec3 uDawn;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    float glow = pow(clamp(0.74 - dot(n, normalize(vView)), 0.0, 1.0), 3.2);
    float sunSide = smoothstep(-0.35, 0.7, dot(n, uSun));
    vec3 color = mix(uLimb, uDawn, sunSide * 0.18);
    gl_FragColor = vec4(color, glow * (0.16 + 0.34 * sunSide));
  }
`;

/** Inner haze just above the surface, thickest at grazing angles. */
const hazeFragment = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uLimb;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    float graze = pow(1.0 - clamp(dot(n, normalize(vView)), 0.0, 1.0), 4.0);
    float day = smoothstep(-0.25, 0.5, dot(n, uSun));
    gl_FragColor = vec4(uLimb, graze * (0.06 + 0.22 * day));
  }
`;

const lineVertex = /* glsl */ `
  uniform vec3 uSun;
  varying float vDay;
  void main() {
    vec3 n = normalize(normalMatrix * position);
    vDay = smoothstep(-0.25, 0.5, dot(n, uSun));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const lineFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying float vDay;
  void main() {
    gl_FragColor = vec4(uColor, uAlpha * (0.55 + 0.45 * vDay));
  }
`;

function useSphereUniforms() {
  return useMemo(
    () => ({ uSun: { value: SUN.value }, uLimb: { value: LIMB }, uDawn: { value: DAWN } }),
    [],
  );
}

export function Earth({ onEmptyClick }: { onEmptyClick: boolean }) {
  const uniforms = useSphereUniforms();
  // The earth swallows pointer events so arcs and airports behind it never react, and a click on
  // open ground clears the selection (unless the press was really a drag).
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <>
      <mesh
        renderOrder={0}
        onPointerOver={stop}
        onPointerMove={stop}
        onClick={(event) => {
          event.stopPropagation();
          if (onEmptyClick && event.delta < 4) setSelected(null);
        }}
      >
        <sphereGeometry args={[0.998, 128, 96]} />
        <shaderMaterial
          vertexShader={sphereVertex}
          fragmentShader={earthFragment}
          uniforms={uniforms}
        />
      </mesh>
      <mesh scale={1.012} renderOrder={3}>
        <sphereGeometry args={[1, 96, 64]} />
        <shaderMaterial
          vertexShader={sphereVertex}
          fragmentShader={hazeFragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </mesh>
      <mesh scale={1.08}>
        <sphereGeometry args={[1, 96, 64]} />
        <shaderMaterial
          vertexShader={sphereVertex}
          fragmentShader={haloFragment}
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

function LitLines({ geometry, alpha }: { geometry: BufferGeometry; alpha: number }) {
  const uniforms = useMemo(
    () => ({ uSun: { value: SUN.value }, uColor: { value: INK }, uAlpha: { value: alpha } }),
    [alpha],
  );
  return (
    <lineSegments geometry={geometry}>
      <shaderMaterial
        vertexShader={lineVertex}
        fragmentShader={lineFragment}
        uniforms={uniforms}
        transparent
        depthWrite={false}
      />
    </lineSegments>
  );
}

/** 110m Natural Earth coastlines, just above the surface. */
export function Coastlines() {
  const geometry = useMemo(() => {
    const topology = land as unknown as Topology;
    const lines = mesh(topology, topology.objects.land as GeometryObject).coordinates;
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
  return <LitLines geometry={geometry} alpha={0.34} />;
}

/** A 15-degree latitude/longitude net, barely there. */
export function Graticule() {
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
  return <LitLines geometry={geometry} alpha={0.06} />;
}

/** A fixed, seeded star field far behind the globe. */
export function Stars() {
  const geometry = useMemo(() => {
    const random = mulberry32(2015);
    const points: number[][] = [];
    const sizes: number[] = [];
    const seeds: number[] = [];
    for (let i = 0; i < 1400; i += 1) {
      const lat = Math.asin(random() * 2 - 1) / RAD;
      const lon = random() * 360 - 180;
      points.push([...latLonToVec3(lat, lon, 40 + random() * 20)]);
      sizes.push(random() < 0.05 ? 30 : 9 + random() * 9);
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
      uBright: { value: 0.3 },
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
