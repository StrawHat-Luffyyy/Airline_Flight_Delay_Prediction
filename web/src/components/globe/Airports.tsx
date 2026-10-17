/**
 * Airports as city lights (brighter on the night side), and pulsing rings on the airports at
 * either end of a drawn route, coloured by the routes they anchor. Hovering a light names it.
 */
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { AdditiveBlending, BufferAttribute, Color, type ShaderMaterial } from 'three';
import { SUN, positions } from './Earth';
import { latLonToVec3, type ArcKind } from './geo';
import { AMBER, BLUE } from './Routes';
import { LIVE, mulberry32 } from './shaders';
import { clearHover, getInteraction, setHover } from './store';

export interface AirportPoint {
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
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
    vAlpha = twinkle * uBright * (0.6 + 0.55 * night) + hovered * 0.8;
    gl_PointSize = aSize * (1.0 + hovered * 1.6) * uPixelRatio * (3.2 / -mv.z);
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
    gl_PointSize = 34.0 * uPixelRatio * (3.2 / -mv.z) * (0.7 + 0.3 * uBright);
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

export function Airports({
  airports,
  anchors,
  reduced,
  hoverable,
}: {
  airports: readonly AirportPoint[];
  /** Airport code to the kinds of drawn route it anchors. */
  anchors: ReadonlyMap<string, ReadonlySet<ArcKind>>;
  reduced: boolean;
  hoverable: boolean;
}) {
  const pixelRatio = useThree((state) => state.viewport.dpr);
  const lights = useRef<ShaderMaterial>(null);

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
      else color.copy(kinds.has('late') ? AMBER : BLUE);
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

  return (
    <>
      <points geometry={lightGeometry} onPointerMove={move} onPointerOut={out}>
        <shaderMaterial
          ref={lights}
          vertexShader={lightVertex}
          fragmentShader={lightFragment}
          uniforms={lightUniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </points>
      <points geometry={ringGeometry} renderOrder={3}>
        <shaderMaterial
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
