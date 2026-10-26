/**
 * Airports, three ways:
 * - city lights for every airport in airports.csv (brighter on the night side);
 * - beacons for every airport with enough departures to be ranked: a lit 3D control tower whose
 *   total height is its 2015 departures (linear, so ATL really is that much taller) and whose shaft
 *   colour is its delay rate against the national rate (amber above, blue below, warm ink near
 *   it), standing on a small generic airfield and casting a shadow away from the evening sun;
 * - pulsing rings on the airports at either end of a drawn route.
 * Hovering a light or a tower names it; clicking a tower selects the airport.
 */
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  Color,
  InstancedBufferAttribute,
  type InstancedMesh,
  Matrix4,
  PlaneGeometry,
  type ShaderMaterial,
  Vector3,
} from 'three';
import { SUN, positions } from './Earth';
import { towerShaft } from './flight';
import { delayTone, latLonToVec3, type ArcKind } from './geo';
import { airportGeometry, CAB_HEIGHT } from './models';
import { NEUTRAL_HEX } from './palette';
import { AMBER, BLUE } from './Routes';
import { linkLive, LIT_GLSL, LIVE, mulberry32, SHADOW_GLSL } from './shaders';
import { clearHover, getInteraction, setHover, setSelectedAirport } from './store';

export interface AirportPoint {
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
}

/** One airport's 2015 departures and delay rate, from /api/analytics/delay-rate?by=origin. */
export interface AirportStat {
  code: string;
  flights: number;
  completed: number;
  delayRate: number | null;
  avgArrDelay: number | null;
}

/** Near the national rate a beacon is warm ink, not a data colour. */
export const NEUTRAL = new Color(NEUTRAL_HEX);
/** One tower unit (the airport model's unit), in globe radii. */
const TOWER_UNIT = 0.001;
/** Height of the busiest airport's tower, in tower units (0.15 radii); the rest scale linearly. */
const TOWER_MAX = 150;
/** The shortest tower, in tower units, so a small airport still stands up as a tower. */
const TOWER_MIN = 4;

/** Colour for a delay rate against the national rate (DESIGN.md Paired Encoding Rule). */
export function toneColor(tone: number | null, target = new Color()): Color {
  if (tone === null) return target.copy(NEUTRAL);
  return target.copy(NEUTRAL).lerp(tone > 0 ? AMBER : BLUE, Math.min(1, Math.abs(tone)));
}

const lightVertex = /* glsl */ `
  attribute float aSize;
  attribute float aSeed;
  attribute float aIndex;
  uniform float uTime;
  uniform float uBright;
  uniform float uPixelRatio;
  uniform float uHover;
  uniform vec3 uSun;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * position);
    float night = 1.0 - smoothstep(-0.2, 0.45, dot(n, uSun));
    float twinkle = 0.78 + 0.22 * sin(uTime * 1.1 + aSeed * 6.2831);
    float hovered = 1.0 - step(0.5, abs(aIndex - uHover));
    vAlpha = twinkle * uBright * (0.55 + 0.6 * night) + hovered * 0.8;
    gl_PointSize = min(28.0, aSize * (1.0 + hovered * 1.6) * uPixelRatio * (3.2 / -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const lightFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float core = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor, core * core * vAlpha);
  }
`;

const ringVertex = /* glsl */ `
  attribute float aSeed;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  uniform float uBright;
  varying float vSeed;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vSeed = aSeed;
    vColor = aColor;
    gl_PointSize = min(72.0, 34.0 * uPixelRatio * (3.2 / -mv.z) * (0.7 + 0.3 * uBright));
    gl_Position = projectionMatrix * mv;
  }
`;
/** Two rings expand out of each anchor and fade, out of step with their neighbours. */
const ringFragment = /* glsl */ `
  uniform float uTime;
  uniform float uMotion;
  uniform float uArcs;
  varying float vSeed;
  varying vec3 vColor;
  float ring(float d, float r) {
    return smoothstep(0.07, 0.0, abs(d - r)) * (1.0 - r);
  }
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float t = uTime * 0.42 + vSeed;
    float pulse = uMotion > 0.5 ? ring(d, fract(t)) + ring(d, fract(t + 0.5)) : ring(d, 0.55) * 0.6;
    float dot_ = smoothstep(0.16, 0.0, d);
    gl_FragColor = vec4(vColor, (pulse * 0.75 + dot_) * uArcs);
  }
`;

/** Grow-in shared by every tower layer: west coast first, 1.4 s each, none under reduced motion. */
const GROW_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uStart;
  uniform float uMotion;
  float growIn(float delay) {
    float since = uStart < 0.0 ? 0.0 : uTime - uStart - delay;
    return uMotion > 0.5 ? smoothstep(0.0, 1.0, clamp(since / 1.4, 0.0, 1.0)) : 1.0;
  }
`;

/**
 * Control towers. The shaft (local z 0..1) stretches to the data height, less the cab; the cab
 * rides on its top, sized with the airport; the airfield stays on the ground. The tower rises in
 * from the west coast eastward, the cab arriving with it and the airfield fading up underneath.
 */
const towerVertex = /* glsl */ `
  ${GROW_GLSL}
  attribute float aPart;
  attribute float aRide;
  attribute vec3 aColor;
  attribute float aDelay;
  attribute float aIndex;
  attribute float aShaft;
  attribute float aCab;
  uniform vec3 uSun;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vColor;
  varying float vPart;
  varying float vH;
  varying float vIndex;
  varying float vDay;
  varying float vHaze;
  void main() {
    float grow = growIn(aDelay);
    vec3 p = position;
    vH = 0.0;
    if (aRide < 0.5) {
      vH = p.z;
      p.z *= aShaft * grow;
    } else if (aRide < 1.5) {
      vH = 1.0;
      p *= aCab * smoothstep(0.0, 0.3, grow);
      p.z += aShaft * grow;
    } else {
      // Hubs get a full airfield; a regional airport a small one, so the map stays readable.
      p.xy *= aCab * aCab;
      p *= smoothstep(0.0, 0.5, grow);
    }
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    vNormal = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
    vView = normalize(-mv.xyz);
    vec3 ground = normalize(mat3(modelViewMatrix) * instanceMatrix[3].xyz);
    vDay = smoothstep(-0.06, 0.16, dot(ground, uSun));
    vHaze = pow(1.0 - clamp(dot(ground, vView), 0.0, 1.0), 3.0);
    vColor = aColor;
    vPart = aPart;
    vIndex = aIndex;
    gl_Position = projectionMatrix * mv;
  }
`;
/**
 * The shaft carries the data colour, lit by the sun and glowing brightest at its foot so the colour
 * reads on the night side too; the cab glazing is lit from inside, tinted with the same colour; the
 * rest is concrete, steel and asphalt. The hovered or selected airport burns brighter, the rest dim.
 */
const towerFragment = /* glsl */ `
  ${LIT_GLSL}
  uniform float uBeacons;
  uniform float uFocus;
  uniform float uHasFocus;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vColor;
  varying float vPart;
  varying float vH;
  varying float vIndex;
  varying float vDay;
  varying float vHaze;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    float focused = 1.0 - step(0.5, abs(vIndex - uFocus));
    float dim = uHasFocus * (1.0 - focused);
    float part = floor(vPart + 0.5);
    vec3 color;
    if (part < 0.5) {
      color = litSurface(vColor * 0.62, n, v, vDay, 28.0, 0.35);
      color += vColor * (0.3 + 0.5 * pow(1.0 - vH, 1.4));
    } else if (part < 1.5) {
      // The glazing carries the delay colour too, so a short regional tower still reads.
      vec3 inside = mix(vec3(1.0, 0.92, 0.78), vColor, 0.78);
      color = inside * (0.85 + 0.4 * focused) + litSurface(vec3(0.04), n, v, vDay, 90.0, 1.6);
    } else if (part < 2.5) {
      color = litSurface(vec3(0.3, 0.3, 0.31), n, v, vDay, 20.0, 0.3) + 0.025;
    } else if (part < 3.5) {
      // The airfield stays close to the night ground: texture under the tower, never a glyph.
      color = litSurface(vec3(0.045, 0.045, 0.05), n, v, vDay, 12.0, 0.05) + vec3(0.02, 0.018, 0.015);
    } else if (part < 4.5) {
      color = litSurface(vec3(0.12, 0.115, 0.11), n, v, vDay, 16.0, 0.08) + vec3(0.05, 0.04, 0.025);
    } else {
      color = litSurface(vec3(0.06, 0.058, 0.055), n, v, vDay, 10.0, 0.04);
    }
    color = mix(color, vec3(1.0, 0.97, 0.9), focused * 0.22);
    float level = uBeacons * (1.0 - dim * 0.72);
    gl_FragColor = vec4(airHaze(color, vHaze) * (0.35 + 0.65 * level), clamp(level * 1.25, 0.0, 1.0));
  }
`;

/**
 * Each tower's shadow: a tapering strip on the ground, cast away from the low evening sun (long, but
 * capped), fading with distance from the foot and gone where the sun has set.
 */
const towerShadowVertex = /* glsl */ `
  ${GROW_GLSL}
  ${SHADOW_GLSL}
  attribute vec3 aUp;
  attribute float aLen;
  attribute float aWidth;
  attribute float aDelay;
  varying float vAlpha;
  varying vec2 vUv;
  void main() {
    float grow = growIn(aDelay);
    vec3 sun = localSun();
    float sinE = dot(aUp, sun);
    vec3 away = awayFromSun(aUp, sun);
    vec3 side = normalize(cross(aUp, away));
    float cosE = sqrt(max(0.0, 1.0 - sinE * sinE));
    float len = min(aLen * grow * cosE / max(sinE, 0.05), aLen * 1.8);
    vec3 p = aUp * 1.0013 + away * position.y * len
      + side * position.x * aWidth * (1.0 - 0.3 * position.y);
    vAlpha = smoothstep(0.02, 0.22, sinE) * step(1e-6, grow);
    vUv = vec2(position.x * 2.0, position.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const towerShadowFragment = /* glsl */ `
  uniform float uBeacons;
  varying float vAlpha;
  varying vec2 vUv;
  void main() {
    float fade = pow(1.0 - vUv.y, 1.3) * (1.0 - vUv.x * vUv.x);
    gl_FragColor = vec4(0.0, 0.0, 0.0, vAlpha * fade * 0.5 * min(1.0, uBeacons * 1.4));
  }
`;

/** A red obstruction light on every mast, blinking slowly, out of step with its neighbours. */
const obstructionVertex = /* glsl */ `
  ${GROW_GLSL}
  attribute vec3 aUp;
  attribute float aTop;
  attribute float aDelay;
  attribute float aSeed;
  uniform float uPixelRatio;
  uniform float uBeacons;
  varying float vAlpha;
  void main() {
    float grow = growIn(aDelay);
    vec4 mv = modelViewMatrix * vec4(position + aUp * aTop * grow, 1.0);
    float blink = uMotion > 0.5 ? 0.25 + 0.75 * smoothstep(0.55, 1.0, sin(uTime * 2.4 + aSeed * 6.2831)) : 0.7;
    vAlpha = blink * uBeacons * step(0.98, grow);
    gl_PointSize = min(10.0, 3.0 * uPixelRatio * (3.2 / -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const obstructionFragment = /* glsl */ `
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float glow = exp(-d * d * 5.0);
    gl_FragColor = vec4(1.0, 0.3, 0.22, glow * vAlpha);
  }
`;

const beaconBaseVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uPixelRatio;
  uniform float uBeacons;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vColor = aColor * uBeacons;
    gl_PointSize = min(46.0, aSize * uPixelRatio * (3.2 / -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const beaconBaseFragment = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float glow = exp(-d * d * 7.0) * 0.4;
    gl_FragColor = vec4(vColor, glow);
  }
`;

/**
 * One grow-in clock for every tower layer (towers, shadows, mast lights), started when the towers
 * first draw and reset when the globe unmounts. One globe is mounted at a time, like LIVE.
 */
const TOWER_CLOCK = { value: -1 };

interface Beacon {
  airport: AirportPoint;
  stat: AirportStat;
  /** Ground frame turned to the airfield's heading, scaled to tower units. */
  matrix: Matrix4;
  hitMatrix: Matrix4;
  up: Vector3;
  color: Color;
  /** Total tower height (shaft and cab), in tower units: the data height. */
  height: number;
  shaft: number;
  /** Cab and airfield size, 0.55..1 with the square root of departures. */
  cab: number;
  /** Grow-in delay, seconds: west coast first. */
  delay: number;
}

/** A stable airfield heading per airport code: generic layout, not the real runway headings. */
function heading(code: string): number {
  let hash = 0;
  for (const char of code) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return ((hash >>> 0) % 180) * (Math.PI / 180);
}

function useBeacons(
  airports: readonly AirportPoint[],
  stats: ReadonlyMap<string, AirportStat>,
  national: number | null,
): Beacon[] {
  return useMemo(() => {
    const busiest = Math.max(1, ...[...stats.values()].map((stat) => stat.flights));
    const east = new Vector3();
    const north = new Vector3();
    const pole = new Vector3(0, 1, 0);
    const beacons: Beacon[] = [];
    for (const airport of airports) {
      const stat = stats.get(airport.code);
      if (!stat) continue;
      const share = stat.flights / busiest;
      const cab = 0.55 + 0.45 * Math.sqrt(share);
      const height = Math.max(TOWER_MIN, share * TOWER_MAX);
      const shaft = towerShaft(height, CAB_HEIGHT * cab);
      const up = new Vector3(...latLonToVec3(airport.latitude, airport.longitude, 1));
      east.crossVectors(pole, up).normalize();
      north.crossVectors(up, east).normalize();
      const at = up.clone().multiplyScalar(1.0012);
      const basis = new Matrix4().makeBasis(east, north, up).setPosition(at);
      const matrix = basis
        .clone()
        .multiply(new Matrix4().makeRotationZ(heading(airport.code)))
        .multiply(new Matrix4().makeScale(TOWER_UNIT, TOWER_UNIT, TOWER_UNIT));
      const top = (shaft + CAB_HEIGHT * cab) * TOWER_UNIT;
      const hitMatrix = basis
        .clone()
        .multiply(new Matrix4().makeScale(0.016, 0.016, Math.max(top, 0.02)));
      const longitude = Math.min(-65, Math.max(-160, airport.longitude));
      beacons.push({
        airport,
        stat,
        matrix,
        hitMatrix,
        up,
        color: toneColor(delayTone(stat.delayRate, national)),
        height,
        shaft,
        cab,
        delay: 0.6 + ((longitude + 160) / 95) * 1.3,
      });
    }
    return beacons;
  }, [airports, stats, national]);
}

function Beacons({
  beacons,
  reduced,
  hoverable,
}: {
  beacons: readonly Beacon[];
  reduced: boolean;
  hoverable: boolean;
}) {
  const pixelRatio = useThree((state) => state.viewport.dpr);
  const towers = useRef<InstancedMesh>(null);
  const hits = useRef<InstancedMesh>(null);
  const material = useRef<ShaderMaterial>(null);
  const geometry = useMemo(() => {
    const geo = airportGeometry();
    const instanced = (values: number[], size: number) =>
      new InstancedBufferAttribute(new Float32Array(values), size);
    geo.setAttribute(
      'aColor',
      instanced(
        beacons.flatMap((b) => b.color.toArray()),
        3,
      ),
    );
    geo.setAttribute(
      'aDelay',
      instanced(
        beacons.map((b) => b.delay),
        1,
      ),
    );
    geo.setAttribute(
      'aIndex',
      instanced(
        beacons.map((_, index) => index),
        1,
      ),
    );
    geo.setAttribute(
      'aShaft',
      instanced(
        beacons.map((b) => b.shaft),
        1,
      ),
    );
    geo.setAttribute(
      'aCab',
      instanced(
        beacons.map((b) => b.cab),
        1,
      ),
    );
    return geo;
  }, [beacons]);
  const shadowGeometry = useMemo(() => {
    const geo = new PlaneGeometry(1, 1).translate(0, 0.5, 0);
    geo.setAttribute(
      'aUp',
      new InstancedBufferAttribute(new Float32Array(beacons.flatMap((b) => b.up.toArray())), 3),
    );
    geo.setAttribute(
      'aLen',
      new InstancedBufferAttribute(
        new Float32Array(beacons.map((b) => (b.shaft + CAB_HEIGHT * b.cab) * TOWER_UNIT)),
        1,
      ),
    );
    geo.setAttribute(
      'aWidth',
      new InstancedBufferAttribute(new Float32Array(beacons.map((b) => 6 * b.cab * TOWER_UNIT)), 1),
    );
    geo.setAttribute(
      'aDelay',
      new InstancedBufferAttribute(new Float32Array(beacons.map((b) => b.delay)), 1),
    );
    return geo;
  }, [beacons]);
  const lightGeometry = useMemo(() => {
    const geo = positions(beacons.map((b) => b.up.clone().multiplyScalar(1.0012).toArray()));
    geo.setAttribute(
      'aUp',
      new BufferAttribute(new Float32Array(beacons.flatMap((b) => b.up.toArray())), 3),
    );
    geo.setAttribute(
      'aTop',
      new BufferAttribute(
        new Float32Array(beacons.map((b) => (b.shaft + CAB_HEIGHT * b.cab) * TOWER_UNIT)),
        1,
      ),
    );
    geo.setAttribute(
      'aDelay',
      new BufferAttribute(new Float32Array(beacons.map((b) => b.delay)), 1),
    );
    const random = mulberry32(23);
    geo.setAttribute(
      'aSeed',
      new BufferAttribute(new Float32Array(beacons.map(() => random())), 1),
    );
    return geo;
  }, [beacons]);
  const hitGeometry = useMemo(() => new BoxGeometry(1, 1, 1).translate(0, 0, 0.5), []);
  const baseGeometry = useMemo(() => {
    const geo = positions(
      beacons.map((b) => [...latLonToVec3(b.airport.latitude, b.airport.longitude, 1.002)]),
    );
    const busiest = Math.max(1, ...beacons.map((b) => b.stat.flights));
    geo.setAttribute(
      'aColor',
      new BufferAttribute(new Float32Array(beacons.flatMap((b) => b.color.toArray())), 3),
    );
    geo.setAttribute(
      'aSize',
      new BufferAttribute(
        new Float32Array(beacons.map((b) => 10 + 30 * Math.sqrt(b.stat.flights / busiest))),
        1,
      ),
    );
    return geo;
  }, [beacons]);
  useEffect(
    () => () => {
      geometry.dispose();
      shadowGeometry.dispose();
      lightGeometry.dispose();
      hitGeometry.dispose();
      baseGeometry.dispose();
    },
    [geometry, shadowGeometry, lightGeometry, hitGeometry, baseGeometry],
  );

  useEffect(
    () => () => {
      TOWER_CLOCK.value = -1;
    },
    [],
  );

  useEffect(() => {
    beacons.forEach((beacon, index) => {
      towers.current?.setMatrixAt(index, beacon.matrix);
      hits.current?.setMatrixAt(index, beacon.hitMatrix);
    });
    for (const mesh of [towers.current, hits.current]) {
      if (!mesh) continue;
      mesh.count = beacons.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }, [beacons]);

  const uniforms = useMemo(
    () => ({
      uTime: LIVE.uTime,
      uBeacons: LIVE.uBeacons,
      uSun: { value: SUN.value },
      uMotion: { value: reduced ? 0 : 1 },
      uStart: TOWER_CLOCK,
      uFocus: { value: -1 },
      uHasFocus: { value: 0 },
    }),
    [reduced],
  );
  const shadowUniforms = useMemo(
    () => ({
      uTime: LIVE.uTime,
      uBeacons: LIVE.uBeacons,
      uSun: { value: SUN.value },
      uMotion: { value: reduced ? 0 : 1 },
      uStart: TOWER_CLOCK,
    }),
    [reduced],
  );
  const lightUniforms = useMemo(
    () => ({
      uTime: LIVE.uTime,
      uBeacons: LIVE.uBeacons,
      uMotion: { value: reduced ? 0 : 1 },
      uStart: TOWER_CLOCK,
      uPixelRatio: { value: pixelRatio },
    }),
    [reduced, pixelRatio],
  );
  const baseUniforms = useMemo(
    () => ({ uBeacons: LIVE.uBeacons, uPixelRatio: { value: pixelRatio } }),
    [pixelRatio],
  );
  // R3F copies each uniform object, so the shared clock is re-linked like the LIVE ones.
  const linkStart = (shader: ShaderMaterial | null) => {
    linkLive(shader);
    if (shader) shader.uniforms.uStart = TOWER_CLOCK;
  };

  useFrame((state) => {
    const u = material.current?.uniforms;
    if (!u) return;
    if (TOWER_CLOCK.value < 0) TOWER_CLOCK.value = state.clock.elapsedTime;
    const { hover, selectedAirport } = getInteraction();
    const code = hover?.kind === 'airport' ? hover.code : selectedAirport;
    const index = code === null ? -1 : beacons.findIndex((b) => b.airport.code === code);
    u.uFocus!.value = index;
    u.uHasFocus!.value = selectedAirport !== null && index >= 0 ? 1 : 0;
  });

  const over = (event: ThreeEvent<PointerEvent>) => {
    if (event.instanceId === undefined) return;
    event.stopPropagation();
    const beacon = beacons[event.instanceId];
    if (hoverable && beacon) setHover({ kind: 'airport', code: beacon.airport.code });
  };
  const out = () => {
    const hover = getInteraction().hover;
    if (hover?.kind === 'airport') clearHover(hover);
  };
  const click = (event: ThreeEvent<MouseEvent>) => {
    if (event.instanceId === undefined) return;
    event.stopPropagation();
    const beacon = beacons[event.instanceId];
    if (beacon && event.delta < 4) setSelectedAirport(beacon.airport.code);
  };

  if (beacons.length === 0) return null;
  return (
    <>
      <instancedMesh
        args={[shadowGeometry, undefined, beacons.length]}
        renderOrder={1}
        frustumCulled={false}
      >
        <shaderMaterial
          ref={linkStart}
          vertexShader={towerShadowVertex}
          fragmentShader={towerShadowFragment}
          uniforms={shadowUniforms}
          transparent
          depthWrite={false}
        />
      </instancedMesh>
      <points geometry={baseGeometry} renderOrder={2}>
        <shaderMaterial
          ref={linkLive}
          vertexShader={beaconBaseVertex}
          fragmentShader={beaconBaseFragment}
          uniforms={baseUniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </points>
      <instancedMesh
        ref={towers}
        args={[geometry, undefined, beacons.length]}
        renderOrder={2}
        frustumCulled={false}
      >
        <shaderMaterial
          ref={(shader) => {
            material.current = shader;
            linkStart(shader);
          }}
          vertexShader={towerVertex}
          fragmentShader={towerFragment}
          uniforms={uniforms}
          transparent
        />
      </instancedMesh>
      <points geometry={lightGeometry} renderOrder={3} frustumCulled={false}>
        <shaderMaterial
          ref={linkStart}
          vertexShader={obstructionVertex}
          fragmentShader={obstructionFragment}
          uniforms={lightUniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </points>
      <instancedMesh
        ref={hits}
        args={[hitGeometry, undefined, beacons.length]}
        onPointerMove={over}
        onPointerOut={out}
        onClick={click}
      >
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </instancedMesh>
    </>
  );
}

export function Airports({
  airports,
  anchors,
  stats,
  national,
  reduced,
  hoverable,
}: {
  airports: readonly AirportPoint[];
  /** Airport code to the kinds of drawn route it anchors. */
  anchors: ReadonlyMap<string, ReadonlySet<ArcKind>>;
  stats: ReadonlyMap<string, AirportStat>;
  /** The national delay rate the beacon colours are measured against. */
  national: number | null;
  reduced: boolean;
  hoverable: boolean;
}) {
  const pixelRatio = useThree((state) => state.viewport.dpr);
  const lights = useRef<ShaderMaterial>(null);
  const beacons = useBeacons(airports, stats, national);

  const lightGeometry = useMemo(() => {
    const geo = positions(airports.map((a) => [...latLonToVec3(a.latitude, a.longitude, 1.003)]));
    const random = mulberry32(7);
    geo.setAttribute(
      'aSize',
      new BufferAttribute(
        new Float32Array(airports.map((a) => (anchors.has(a.code) ? 5 : 3.4))),
        1,
      ),
    );
    geo.setAttribute(
      'aSeed',
      new BufferAttribute(new Float32Array(airports.map(() => random())), 1),
    );
    geo.setAttribute('aIndex', new BufferAttribute(new Float32Array(airports.map((_, i) => i)), 1));
    return geo;
  }, [airports, anchors]);

  const anchored = useMemo(() => airports.filter((a) => anchors.has(a.code)), [airports, anchors]);
  const ringGeometry = useMemo(() => {
    const geo = positions(anchored.map((a) => [...latLonToVec3(a.latitude, a.longitude, 1.004)]));
    const random = mulberry32(11);
    geo.setAttribute(
      'aSeed',
      new BufferAttribute(new Float32Array(anchored.map(() => random())), 1),
    );
    const colors = anchored.flatMap((a) => {
      const kinds = anchors.get(a.code)!;
      const color = new Color();
      if (kinds.has('late') && kinds.has('punctual')) color.copy(AMBER).lerp(BLUE, 0.5);
      else if (kinds.has('late')) color.copy(AMBER);
      else if (kinds.has('punctual')) color.copy(BLUE);
      else color.copy(NEUTRAL);
      return [color.r, color.g, color.b];
    });
    geo.setAttribute('aColor', new BufferAttribute(new Float32Array(colors), 3));
    return geo;
  }, [anchored, anchors]);

  const lightUniforms = useMemo(
    () => ({
      uTime: LIVE.uTime,
      uBright: LIVE.uBright,
      uPixelRatio: { value: pixelRatio },
      uHover: { value: -1 },
      uSun: SUN,
      uColor: { value: new Color('#ffe9c4') },
    }),
    [pixelRatio],
  );
  const ringUniforms = useMemo(
    () => ({
      uTime: LIVE.uTime,
      uArcs: LIVE.uArcs,
      uBright: LIVE.uBright,
      uPixelRatio: { value: pixelRatio },
      uMotion: { value: reduced ? 0 : 1 },
    }),
    [pixelRatio, reduced],
  );

  useFrame(() => {
    const u = lights.current?.uniforms;
    if (!u) return;
    const hover = getInteraction().hover;
    u.uHover!.value =
      hover?.kind === 'airport' ? airports.findIndex((a) => a.code === hover.code) : -1;
  });

  const move = (event: ThreeEvent<PointerEvent>) => {
    if (!hoverable || event.index === undefined) return;
    event.stopPropagation();
    const airport = airports[event.index];
    if (airport) setHover({ kind: 'airport', code: airport.code });
  };
  const out = () => {
    const hover = getInteraction().hover;
    if (hover?.kind === 'airport') clearHover(hover);
  };
  const click = (event: ThreeEvent<MouseEvent>) => {
    if (event.index === undefined || event.delta >= 4) return;
    const airport = airports[event.index];
    if (!airport || !stats.has(airport.code)) return;
    event.stopPropagation();
    setSelectedAirport(airport.code);
  };

  return (
    <>
      <points geometry={lightGeometry} onPointerMove={move} onPointerOut={out} onClick={click}>
        <shaderMaterial
          ref={(material) => {
            lights.current = material;
            linkLive(material);
          }}
          vertexShader={lightVertex}
          fragmentShader={lightFragment}
          uniforms={lightUniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </points>
      <Beacons beacons={beacons} reduced={reduced} hoverable={hoverable} />
      <points geometry={ringGeometry} renderOrder={3}>
        <shaderMaterial
          ref={linkLive}
          vertexShader={ringVertex}
          fragmentShader={ringFragment}
          uniforms={ringUniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </points>
    </>
  );
}
