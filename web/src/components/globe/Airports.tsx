/**
 * Airports, three ways:
 * - city lights for every airport in airports.csv (brighter on the night side);
 * - beacons for every airport with enough departures to be ranked: a column whose height is its
 *   2015 departures (linear, so ATL really is that much taller) and whose colour is its delay rate
 *   against the national rate (amber above, blue below, warm ink near it);
 * - pulsing rings on the airports at either end of a drawn route.
 * Hovering a light or a beacon names it; clicking a beacon selects the airport.
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
  type ShaderMaterial,
  Vector3,
} from 'three';
import { SUN, positions } from './Earth';
import { delayTone, latLonToVec3, type ArcKind } from './geo';
import { NEUTRAL_HEX } from './palette';
import { AMBER, BLUE } from './Routes';
import { linkLive, LIVE, mulberry32 } from './shaders';
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
/** Height of the busiest airport's beacon, in globe radii; the rest scale linearly. */
const BEACON_MAX = 0.15;
const BEACON_WIDTH = 0.0048;

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

/**
 * Beacon columns. The box runs 0..1 along its local z (the surface normal); it grows in from the
 * west coast eastward on load, brightest at the base and thinning toward the top, with a bright
 * cap so the height reads. The hovered or selected airport burns brighter, the rest dim.
 */
const beaconVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aDelay;
  attribute float aIndex;
  uniform float uTime;
  uniform float uStart;
  uniform float uMotion;
  varying vec3 vColor;
  varying float vH;
  varying float vIndex;
  void main() {
    float since = uStart < 0.0 ? 0.0 : uTime - uStart - aDelay;
    float grow = uMotion > 0.5 ? smoothstep(0.0, 1.0, clamp(since / 1.4, 0.0, 1.0)) : 1.0;
    vec3 p = position;
    p.z *= grow;
    vH = position.z;
    vColor = aColor;
    vIndex = aIndex;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  }
`;
const beaconFragment = /* glsl */ `
  uniform float uBeacons;
  uniform float uFocus;
  uniform float uHasFocus;
  varying vec3 vColor;
  varying float vH;
  varying float vIndex;
  void main() {
    float focused = 1.0 - step(0.5, abs(vIndex - uFocus));
    float dim = uHasFocus * (1.0 - focused);
    float body = 0.24 + 0.62 * pow(1.0 - vH, 1.4);
    float cap = smoothstep(0.9, 1.0, vH) * 0.6;
    float alpha = (body + cap) * uBeacons * (1.0 - dim * 0.72) + focused * 0.45;
    vec3 color = mix(vColor, vec3(1.0, 0.97, 0.9), focused * 0.35 + cap * 0.3);
    gl_FragColor = vec4(color, alpha);
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
    float glow = exp(-d * d * 7.0) * 0.55;
    gl_FragColor = vec4(vColor, glow);
  }
`;

interface Beacon {
  airport: AirportPoint;
  stat: AirportStat;
  matrix: Matrix4;
  hitMatrix: Matrix4;
  color: Color;
  /** Grow-in delay, seconds: west coast first. */
  delay: number;
}

function useBeacons(
  airports: readonly AirportPoint[],
  stats: ReadonlyMap<string, AirportStat>,
  national: number | null,
): Beacon[] {
  return useMemo(() => {
    const busiest = Math.max(1, ...[...stats.values()].map((stat) => stat.flights));
    const up = new Vector3();
    const east = new Vector3();
    const north = new Vector3();
    const pole = new Vector3(0, 1, 0);
    const beacons: Beacon[] = [];
    for (const airport of airports) {
      const stat = stats.get(airport.code);
      if (!stat) continue;
      const height = Math.max(0.004, (stat.flights / busiest) * BEACON_MAX);
      up.set(...latLonToVec3(airport.latitude, airport.longitude, 1));
      east.crossVectors(pole, up).normalize();
      north.crossVectors(up, east).normalize();
      const at = up.clone().multiplyScalar(1.0015);
      const basis = new Matrix4().makeBasis(east, north, up).setPosition(at);
      const matrix = basis
        .clone()
        .multiply(new Matrix4().makeScale(BEACON_WIDTH, BEACON_WIDTH, height));
      const hitMatrix = basis
        .clone()
        .multiply(new Matrix4().makeScale(0.016, 0.016, Math.max(height, 0.02)));
      const longitude = Math.min(-65, Math.max(-160, airport.longitude));
      beacons.push({
        airport,
        stat,
        matrix,
        hitMatrix,
        color: toneColor(delayTone(stat.delayRate, national)),
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
  const columns = useRef<InstancedMesh>(null);
  const hits = useRef<InstancedMesh>(null);
  const material = useRef<ShaderMaterial>(null);
  const geometry = useMemo(() => {
    const box = new BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
    box.setAttribute(
      'aColor',
      new InstancedBufferAttribute(new Float32Array(beacons.flatMap((b) => b.color.toArray())), 3),
    );
    box.setAttribute(
      'aDelay',
      new InstancedBufferAttribute(new Float32Array(beacons.map((b) => b.delay)), 1),
    );
    box.setAttribute(
      'aIndex',
      new InstancedBufferAttribute(new Float32Array(beacons.map((_, index) => index)), 1),
    );
    return box;
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
      hitGeometry.dispose();
      baseGeometry.dispose();
    },
    [geometry, hitGeometry, baseGeometry],
  );

  useEffect(() => {
    beacons.forEach((beacon, index) => {
      columns.current?.setMatrixAt(index, beacon.matrix);
      hits.current?.setMatrixAt(index, beacon.hitMatrix);
    });
    for (const mesh of [columns.current, hits.current]) {
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
      uMotion: { value: reduced ? 0 : 1 },
      uStart: { value: -1 },
      uFocus: { value: -1 },
      uHasFocus: { value: 0 },
    }),
    [reduced],
  );
  const baseUniforms = useMemo(
    () => ({ uBeacons: LIVE.uBeacons, uPixelRatio: { value: pixelRatio } }),
    [pixelRatio],
  );

  useFrame((state) => {
    const u = material.current?.uniforms;
    if (!u) return;
    // The grow-in clock starts when the beacons first draw, which may be after the entrance.
    if ((u.uStart!.value as number) < 0) u.uStart!.value = state.clock.elapsedTime;
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
        ref={columns}
        args={[geometry, undefined, beacons.length]}
        renderOrder={2}
        frustumCulled={false}
      >
        <shaderMaterial
          ref={(shader) => {
            material.current = shader;
            linkLive(shader);
          }}
          vertexShader={beaconVertex}
          fragmentShader={beaconFragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </instancedMesh>
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
