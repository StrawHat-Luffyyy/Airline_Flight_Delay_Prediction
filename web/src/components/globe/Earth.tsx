/**
 * The planet: a night-side earth lit by a sun fixed in view space (so a terminator stays put while
 * the globe turns under it), a two-layer atmosphere, coastlines, a graticule and a star field.
 * Atmosphere tones are landing-only (DESIGN.md "Landing"), never data colours.
 *
 * The dataset is US domestic only, so the US carries the detail: its land is lifted out of the
 * night by a fill texture, its coast and state lines come from the 10m us-atlas (Census, public
 * domain), and everything else (other coasts, the graticule) fades with distance from it.
 */
import { useEffect, useMemo } from 'react';
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  LinearFilter,
  Vector3,
} from 'three';
import { feature, mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import usAtlas from 'us-atlas/states-10m.json';
import countries from 'world-atlas/countries-110m.json';
import { latLonToVec3 } from './geo';
import { mulberry32, pointFragment, pointVertex } from './shaders';
import { clearSelection } from './store';

const RAD = Math.PI / 180;
export const INK = new Color('#f2f1ec');
const LIMB = new Color('#a9b8cc');
const DAWN = new Color('#ffd2a1');
/**
 * Sun direction in view space: low from the right and a little behind, so a soft terminator falls
 * past the east coast and the country sits in early evening, lit at the right limb.
 */
export const SUN = { value: new Vector3(0.78, 0.42, 0.3).normalize() };
/** The middle of the lower 48: line work and other land fade with angular distance from it. */
export const US_FOCUS = new Vector3(...latLonToVec3(39, -98, 1));

/** ISO 3166-1 numeric id of the United States in world-atlas. */
const USA_ID = '840';

export function positions(points: readonly (readonly number[])[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points.flat()), 3));
  return geometry;
}

/** Line segments (pairs of points) just above the surface, from [lon, lat] polylines. */
function lineGeometry(lines: readonly (readonly (readonly number[])[])[], radius: number) {
  const segments: number[][] = [];
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const [lonA, latA] = line[i]!;
      const [lonB, latB] = line[i + 1]!;
      segments.push(
        [...latLonToVec3(latA!, lonA!, radius)],
        [...latLonToVec3(latB!, lonB!, radius)],
      );
    }
  }
  return positions(segments);
}

type Ring = readonly (readonly number[])[];

/**
 * Fills polygons onto an equirectangular canvas. Rings that cross the antimeridian (the Aleutians,
 * Chukotka) are unwrapped to stay continuous and drawn again one world-width over, so they never
 * smear a band across the map.
 */
function drawRings(
  context: CanvasRenderingContext2D,
  polygons: readonly (readonly Ring[])[],
  width: number,
  height: number,
  mode: 'fill' | 'stroke',
): void {
  const x = (lon: number) => ((lon + 180) / 360) * width;
  const y = (lat: number) => ((90 - lat) / 180) * height;
  // Edges where Natural Earth cuts a polygon (along the antimeridian, or Antarctica's closing run
  // at the pole) are not coastline: a stroke skips them so they never glow.
  const cut = (a: readonly number[], b: readonly number[]) =>
    (Math.abs(a[0]!) > 179.9 && Math.abs(b[0]!) > 179.9) || (a[1]! < -84 && b[1]! < -84);
  for (const offset of [-width, 0, width]) {
    context.beginPath();
    for (const polygon of polygons) {
      for (const ring of polygon) {
        let previous = ring[0]![0]!;
        let shift = 0;
        ring.forEach((point, index) => {
          const [lon, lat] = point;
          if (lon! - previous > 180) shift -= 360;
          else if (previous - lon! > 180) shift += 360;
          previous = lon!;
          const px = x(lon! + shift) + offset;
          const skip = mode === 'stroke' && index > 0 && cut(ring[index - 1]!, point);
          if (index === 0 || skip) context.moveTo(px, y(lat!));
          else context.lineTo(px, y(lat!));
        });
        if (mode === 'fill') context.closePath();
      }
    }
    if (mode === 'fill') context.fill('evenodd');
    else context.stroke();
  }
}

function polygonsOf(geometry: GeoJSON.Geometry | null): Ring[][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/**
 * Red: land outside the US (110m). Green: the US (10m), which also covers Alaska and Hawaii.
 * Blue: a soft glow along every coast, the emissive edge that keeps continents readable on the
 * night side. Sampled by the earth shader from each fragment's latitude and longitude.
 */
function landTexture(): CanvasTexture {
  const small = window.innerWidth < 768;
  const width = small ? 2048 : 4096;
  const height = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = 'lighter';
    const world = countries as unknown as Topology;
    const others = feature(world, world.objects.countries as GeometryCollection).features.filter(
      (country) => String(country.id) !== USA_ID,
    );
    const otherPolygons = others.flatMap((country) => polygonsOf(country.geometry));
    context.fillStyle = '#f00';
    drawRings(context, otherPolygons, width, height, 'fill');
    const us = usAtlas as unknown as Topology;
    const nation = feature(us, us.objects.nation as GeometryCollection);
    const usPolygons = nation.features.flatMap((part) => polygonsOf(part.geometry));
    context.fillStyle = '#0f0';
    drawRings(context, usPolygons, width, height, 'fill');
    // The coast glow: a wide soft stroke under a narrow bright one, scaled to the texture size.
    const px = width / 4096;
    context.strokeStyle = 'rgba(0, 0, 255, 0.35)';
    context.lineJoin = 'round';
    context.lineWidth = 7 * px;
    context.filter = `blur(${4 * px}px)`;
    drawRings(context, [...otherPolygons, ...usPolygons], width, height, 'stroke');
    context.filter = 'none';
    context.strokeStyle = 'rgba(0, 0, 255, 0.55)';
    context.lineWidth = 1.6 * px;
    drawRings(context, [...otherPolygons, ...usPolygons], width, height, 'stroke');
  }
  const texture = new CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

const sphereVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vObject;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    vObject = normalize(position);
    gl_Position = projectionMatrix * mv;
  }
`;

const earthFragment = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uLimb;
  uniform vec3 uDawn;
  uniform vec3 uFocus;
  uniform sampler2D uLand;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vObject;
  const float PI = 3.14159265;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    vec3 o = normalize(vObject);
    vec2 uv = vec2(atan(o.x, o.z) / (2.0 * PI) + 0.5, asin(clamp(o.y, -1.0, 1.0)) / PI + 0.5);
    vec4 land = texture2D(uLand, uv);
    float focus = smoothstep(0.5, 0.92, dot(o, uFocus));
    float ndl = dot(n, uSun);
    float day = smoothstep(-0.35, 0.6, ndl);
    float facing = clamp(dot(n, v), 0.0, 1.0);

    // Hemisphere ambient, in view space: cool sky light from above, a faint warm bounce from below.
    // It is the floor the night side never drops under, whichever way the globe has turned.
    vec3 hemi = mix(vec3(0.011, 0.009, 0.007), vec3(0.018, 0.025, 0.038), n.y * 0.5 + 0.5);
    vec3 ocean = hemi + mix(vec3(0.004, 0.007, 0.012), vec3(0.018, 0.027, 0.042), day);
    // Other land is a step above the sea, a little fainter away from the US; the US sits above both.
    vec3 elsewhere = hemi + mix(vec3(0.02, 0.022, 0.026), vec3(0.046, 0.05, 0.058), day);
    vec3 home = hemi + mix(vec3(0.036, 0.038, 0.044), vec3(0.082, 0.085, 0.092), day);
    vec3 color = mix(ocean, elsewhere, land.r * mix(0.7, 1.0, focus));
    color = mix(color, home, land.g);
    // Emissive coasts: a faint glow along every shoreline, lit or not.
    color += uLimb * land.b * (0.075 + 0.05 * day) * mix(0.7, 1.0, focus);
    // A whisper of grain on land, so large fills read as surface rather than flat paint.
    float grain = fract(sin(dot(floor(uv * 2048.0), vec2(12.9898, 78.233))) * 43758.5453);
    color += (grain - 0.5) * 0.006 * (land.r + land.g);

    // A soft sun glint on the water, strongest where the light reflects toward the camera.
    vec3 h = normalize(uSun + v);
    color += vec3(0.75, 0.82, 0.95) * pow(max(dot(n, h), 0.0), 60.0) * 0.1 * day * (1.0 - land.r - land.g);
    // Rim light: cool at the limb, warming where the sun rises over it.
    float rim = pow(1.0 - facing, 2.6);
    vec3 rimColor = mix(uLimb, uDawn, smoothstep(0.1, 0.8, ndl) * 0.3);
    color += rimColor * rim * (0.16 + 0.26 * day);
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
    vec3 color = mix(uLimb, uDawn, sunSide * 0.22);
    gl_FragColor = vec4(color, glow * (0.22 + 0.3 * sunSide));
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
    gl_FragColor = vec4(uLimb, graze * (0.12 + 0.18 * day));
  }
`;

const lineVertex = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uFocus;
  varying float vDay;
  varying float vFocus;
  void main() {
    vec3 n = normalize(normalMatrix * position);
    vDay = smoothstep(-0.25, 0.5, dot(n, uSun));
    vFocus = smoothstep(0.62, 0.92, dot(normalize(position), uFocus));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const lineFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uFar;
  varying float vDay;
  varying float vFocus;
  void main() {
    gl_FragColor = vec4(uColor, uAlpha * (0.72 + 0.28 * vDay) * mix(uFar, 1.0, vFocus));
  }
`;

function useSphereUniforms() {
  return useMemo(
    () => ({
      uSun: { value: SUN.value },
      uLimb: { value: LIMB },
      uDawn: { value: DAWN },
      uFocus: { value: US_FOCUS },
    }),
    [],
  );
}

export function Earth({ onEmptyClick }: { onEmptyClick: boolean }) {
  const uniforms = useSphereUniforms();
  const land = useMemo(() => landTexture(), []);
  useEffect(() => () => land.dispose(), [land]);
  const earthUniforms = useMemo(() => ({ ...uniforms, uLand: { value: land } }), [uniforms, land]);
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
          if (onEmptyClick && event.delta < 4) clearSelection();
        }}
      >
        <sphereGeometry args={[0.998, 160, 120]} />
        <shaderMaterial
          vertexShader={sphereVertex}
          fragmentShader={earthFragment}
          uniforms={earthUniforms}
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

/**
 * Lines lit by the sun. `far` is the alpha multiplier away from the US (1 = no fade), so the rest
 * of the world recedes while the US keeps its full line work.
 */
function LitLines({
  geometry,
  alpha,
  far,
}: {
  geometry: BufferGeometry;
  alpha: number;
  far: number;
}) {
  const uniforms = useMemo(
    () => ({
      uSun: { value: SUN.value },
      uFocus: { value: US_FOCUS },
      uColor: { value: INK },
      uAlpha: { value: alpha },
      uFar: { value: far },
    }),
    [alpha, far],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
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

/**
 * Every other country's coast (110m Natural Earth), faint and fading with distance from the US.
 * US coasts and its land borders come from the finer us-atlas outline instead (UsLines).
 */
export function Coastlines() {
  const geometry = useMemo(() => {
    const world = countries as unknown as Topology;
    const coasts = mesh(
      world,
      world.objects.countries as GeometryCollection,
      (a, b) => a === b && String(a.id) !== USA_ID,
    );
    return lineGeometry(coasts.coordinates, 1.0015);
  }, []);
  return <LitLines geometry={geometry} alpha={0.28} far={0.62} />;
}

/** The US at 1:10M: its outline (coasts and land borders) and, fainter, the state lines. */
export function UsLines() {
  const [outline, states] = useMemo(() => {
    const us = usAtlas as unknown as Topology;
    const nation = mesh(us, us.objects.nation as GeometryCollection);
    const inner = mesh(us, us.objects.states as GeometryCollection, (a, b) => a !== b);
    return [lineGeometry(nation.coordinates, 1.0016), lineGeometry(inner.coordinates, 1.0016)];
  }, []);
  return (
    <>
      <LitLines geometry={outline} alpha={0.46} far={1} />
      <LitLines geometry={states} alpha={0.12} far={1} />
    </>
  );
}

/** A 15-degree latitude/longitude net, barely there and gone away from the US. */
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
  return <LitLines geometry={geometry} alpha={0.05} far={0.6} />;
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
