/**
 * Route arcs: a thin core with a comet trail, a soft halo tube that makes it glow without a
 * post-processing pass, an invisible fat tube for picking, one airliner per arc riding the pulse
 * head (lit, with its ground shadow and navigation lights), and a stream of moving lights whose
 * density follows the route's real 2015 flight count.
 * Amber = most often late, blue = most punctual (DESIGN.md Paired Encoding Rule); a selected
 * airport's network has no delay figure per route, so it is drawn in warm ink.
 */
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  InstancedBufferAttribute,
  type InstancedMesh,
  Matrix4,
  type ShaderMaterial,
  TubeGeometry,
  Vector3,
} from 'three';
import { SUN } from './Earth';
import { attitude, bankAngle, presence } from './flight';
import { flowCount, type ArcKind, type RouteArc } from './geo';
import { airlinerGeometry, airlinerShadowGeometry, NAV_LIGHTS } from './models';
import { AMBER_HEX, BLUE_HEX, NETWORK_HEX } from './palette';
import {
  arcPhase,
  damp,
  drawProgress,
  forgetDraw,
  linkLive,
  LIT_GLSL,
  LIVE,
  PULSE_SPAN,
  PULSE_SPEED,
  pulseHead,
  SHADOW_GLSL,
} from './shaders';
import { clearHover, getHighlightRoute, getInteraction, setHover, setSelected } from './store';

export const AMBER = new Color(AMBER_HEX);
export const BLUE = new Color(BLUE_HEX);
/** A selected airport's destinations: no delay figure per route, so not a data colour. */
export const NETWORK = new Color(NETWORK_HEX);
const WHITE = new Color('#fff6e6');

export function arcColor(kind: ArcKind): Color {
  if (kind === 'late') return AMBER;
  if (kind === 'punctual') return BLUE;
  return NETWORK;
}

/**
 * Whether an arc steps back: another route is lit, or an airport is selected and this ranked
 * route does not touch it (its own network arcs stay lit).
 */
function isDimmed(arc: RouteArc, lit: string | null, airport: string | null): boolean {
  if (lit !== null) return lit !== arc.id;
  if (airport === null || arc.kind === 'network') return false;
  return arc.origin !== airport && arc.dest !== airport;
}

const arcVertex = /* glsl */ `
  uniform float uWidth;
  varying float vAlong;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vAlong = uv.x;
    vec3 p = position + normal * uWidth;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

/** Shared by core and halo: the trail behind the head, the head itself, focus and dimming. */
const arcCommon = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uDraw;
  uniform float uPhase;
  uniform float uFocus;
  uniform float uDim;
  uniform float uArcs;
  uniform float uMotion;
  varying float vAlong;
  varying vec3 vNormal;
  varying vec3 vView;
  float behindHead() {
    float head = fract(uTime * ${PULSE_SPEED.toFixed(4)} + uPhase) * ${PULSE_SPAN.toFixed(4)};
    return head - vAlong;
  }
`;

const coreFragment = /* glsl */ `
  ${arcCommon}
  void main() {
    if (vAlong > uDraw) discard;
    float behind = behindHead();
    float trail = behind >= 0.0 ? exp(-behind * 7.0) : 0.0;
    float head = exp(-abs(behind) * 70.0);
    trail *= uMotion;
    head *= uMotion;
    float alpha = (0.3 + trail * 0.85 + head * 1.4) * (1.0 - uDim * 0.82) + uFocus * 0.65;
    vec3 color = mix(uColor * (1.0 + uFocus * 0.35), vec3(1.0, 0.97, 0.9), head * 0.55);
    gl_FragColor = vec4(color, alpha * uArcs);
  }
`;

const haloFragment = /* glsl */ `
  ${arcCommon}
  void main() {
    if (vAlong > uDraw) discard;
    float behind = behindHead();
    float trail = behind >= 0.0 ? exp(-behind * 6.0) : 0.0;
    float head = exp(-abs(behind) * 40.0);
    // Soft across the tube: bright on the axis, fading to nothing at the silhouette.
    float soft = pow(abs(dot(normalize(vNormal), normalize(vView))), 2.0);
    float alpha = soft * ((0.05 + (trail * 0.3 + head * 0.7) * uMotion) * (1.0 - uDim * 0.9) + uFocus * 0.3);
    gl_FragColor = vec4(uColor, alpha * uArcs);
  }
`;

export interface ArcCurve {
  arc: RouteArc;
  curve: CatmullRomCurve3;
  /**
   * Position within its group (the ranking, or a selected airport's network): drives the draw-in
   * stagger and pulse phase, so a network draws in at once instead of after the ranked arcs.
   */
  order: number;
}

export function useArcCurves(arcs: readonly RouteArc[]): ArcCurve[] {
  return useMemo(() => {
    let ranked = 0;
    let network = 0;
    return arcs.map((arc) => ({
      arc,
      curve: new CatmullRomCurve3(arc.points.map(([x, y, z]) => new Vector3(x, y, z))),
      order: arc.kind === 'network' ? network++ : ranked++,
    }));
  }, [arcs]);
}

function Arc({
  entry,
  index,
  reduced,
  hoverable,
}: {
  entry: ArcCurve;
  index: number;
  reduced: boolean;
  hoverable: boolean;
}) {
  const { arc, curve } = entry;
  const core = useRef<ShaderMaterial>(null);
  const halo = useRef<ShaderMaterial>(null);
  const [coreGeometry, haloGeometry, hitGeometry] = useMemo(
    () => [
      new TubeGeometry(curve, 128, 0.003, 6, false),
      new TubeGeometry(curve, 96, 0.011, 8, false),
      new TubeGeometry(curve, 32, 0.02, 5, false),
    ],
    [curve],
  );
  useEffect(
    () => () => {
      coreGeometry.dispose();
      haloGeometry.dispose();
      hitGeometry.dispose();
    },
    [coreGeometry, haloGeometry, hitGeometry],
  );
  const uniforms = useMemo(
    () => ({
      uTime: LIVE.uTime,
      uArcs: LIVE.uArcs,
      uColor: { value: arcColor(arc.kind) },
      uDraw: { value: reduced ? 1 : 0 },
      uPhase: { value: arcPhase(index) },
      uFocus: { value: 0 },
      uDim: { value: 0 },
      uWidth: { value: 0 },
      uMotion: { value: reduced ? 0 : 1 },
    }),
    [arc.kind, index, reduced],
  );
  // The halo shares every value but widens on focus independently.
  const haloUniforms = useMemo(() => ({ ...uniforms, uWidth: { value: 0 } }), [uniforms]);
  // A network arc draws in again each time its airport is selected.
  useEffect(
    () => () => {
      if (arc.kind === 'network') forgetDraw(arc.id);
    },
    [arc.id, arc.kind],
  );

  useFrame((state, dt) => {
    const c = core.current?.uniforms;
    const h = halo.current?.uniforms;
    if (!c || !h) return;
    const lit = getHighlightRoute();
    const focused = lit === arc.id ? 1 : 0;
    const dimmed = isDimmed(arc, lit, getInteraction().selectedAirport) ? 1 : 0;
    const rate = reduced ? Infinity : 8;
    const focus = damp(c.uFocus!.value as number, focused, rate, dt);
    c.uDraw!.value = drawProgress(arc.id, index, state.clock.elapsedTime, reduced) * 1.001;
    c.uFocus!.value = focus;
    c.uDim!.value = damp(c.uDim!.value as number, dimmed, rate, dt);
    c.uWidth!.value = focus * 0.0014;
    h.uWidth!.value = focus * 0.004;
  });

  const hover = { kind: 'route', id: arc.id } as const;
  const over = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (hoverable) setHover(hover);
  };
  const out = () => clearHover(hover);
  const click = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    // Network arcs have no ranking details to open; a click on one keeps its airport selected.
    if (event.delta < 4 && arc.kind !== 'network') setSelected(arc.id);
  };

  return (
    <group>
      <mesh geometry={haloGeometry} renderOrder={1}>
        <shaderMaterial
          ref={(material) => {
            halo.current = material;
            linkLive(material);
          }}
          vertexShader={arcVertex}
          fragmentShader={haloFragment}
          uniforms={haloUniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </mesh>
      <mesh geometry={coreGeometry} renderOrder={2}>
        <shaderMaterial
          ref={(material) => {
            core.current = material;
            linkLive(material);
          }}
          vertexShader={arcVertex}
          fragmentShader={coreFragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </mesh>
      <mesh geometry={hitGeometry} onPointerOver={over} onPointerOut={out} onClick={click}>
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </mesh>
    </group>
  );
}

/** Airliner length on the globe, in radii (about 15 px across the lower 48 in the hero framing). */
const AIRCRAFT_SCALE = 0.0074;
/** How far either side of the aircraft the tangent is sampled to measure a turn, as a fraction of u. */
const TURN_STEP = 0.01;

const planeVertex = /* glsl */ `
  attribute float aPart;
  attribute vec3 aTint;
  uniform vec3 uSun;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vTint;
  varying float vPart;
  varying float vDay;
  varying float vHaze;
  void main() {
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
    vView = normalize(-mv.xyz);
    vec3 ground = normalize(mat3(modelViewMatrix) * instanceMatrix[3].xyz);
    vDay = smoothstep(-0.06, 0.16, dot(ground, uSun));
    vHaze = pow(1.0 - clamp(dot(ground, vView), 0.0, 1.0), 3.0);
    vTint = aTint;
    vPart = aPart;
    gl_Position = projectionMatrix * mv;
  }
`;
/**
 * A painted body (warm white, glossy), the fin and winglets in the route's colour (lit, with a
 * little glow so the colour still reads on the night side), and darker metal nacelles.
 */
const planeFragment = /* glsl */ `
  ${LIT_GLSL}
  uniform float uArcs;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vTint;
  varying float vPart;
  varying float vDay;
  varying float vHaze;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    float livery = 1.0 - step(0.5, abs(vPart - 1.0));
    float metal = step(1.5, vPart);
    vec3 albedo = mix(vec3(0.9, 0.89, 0.86), vTint, livery);
    albedo = mix(albedo, vec3(0.36, 0.37, 0.4), metal);
    vec3 color = litSurface(albedo, n, v, vDay, mix(60.0, 24.0, metal), mix(0.9, 0.5, metal));
    // A moonlit floor, so the aircraft never vanish into the dark land on the night side.
    color += albedo * 0.12 + vTint * livery * 0.45;
    gl_FragColor = vec4(airHaze(color, vHaze), uArcs);
  }
`;

/** The ground shadow: the silhouette, cast away from the evening sun and blurred out with height. */
const planeShadowVertex = /* glsl */ `
  ${SHADOW_GLSL}
  attribute vec3 aPos;
  attribute vec3 aFwd;
  attribute float aScale;
  varying float vAlpha;
  void main() {
    vec3 n = normalize(aPos);
    float height = max(0.0, length(aPos) - 1.0);
    vec3 sun = localSun();
    float sinE = dot(n, sun);
    vec3 away = awayFromSun(n, sun);
    float reach = min(height * sqrt(max(0.0, 1.0 - sinE * sinE)) / max(sinE, 0.08), 0.2);
    vec3 g = normalize(n + away * reach);
    vec3 f = normalize(aFwd - g * dot(aFwd, g));
    vec3 r = cross(f, g);
    float blur = 1.0 + height * 55.0;
    vec3 p = g * 1.0016 + (r * position.x + f * position.y) * aScale * blur;
    vAlpha = smoothstep(0.03, 0.2, sinE) / (blur * blur) * step(1e-6, aScale);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const planeShadowFragment = /* glsl */ `
  uniform float uArcs;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(0.0, 0.0, 0.0, vAlpha * 0.6 * uArcs);
  }
`;

/** Navigation lights: steady red and green wingtips, a white tail strobe and a red roof beacon. */
const navVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aStrobe;
  attribute float aSeed;
  attribute float aVis;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uArcs;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float f = fract(uTime * 0.85 + aSeed);
    float flash = exp(-f * 55.0) + 0.8 * exp(-abs(f - 0.13) * 55.0);
    float level = mix(0.85, flash * 1.6, aStrobe);
    vColor = aColor;
    vAlpha = level * aVis * uArcs;
    gl_PointSize = min(14.0, (3.2 + aStrobe * flash * 3.0) * uPixelRatio * (3.2 / -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const navFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float glow = exp(-d * d * 6.0);
    float core = smoothstep(0.3, 0.0, d);
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.5), (glow * 0.8 + core * 0.6) * vAlpha);
  }
`;

/**
 * One airliner per arc, at the pulse head, flying the great circle: the nose follows the track
 * tangent (climbing out, levelling off, descending in), the wings bank into any turn plus a faint
 * roll of light turbulence, and it grows in on take-off and shrinks away on landing. Each casts a
 * ground shadow away from the evening sun (crisp near the airports, blurred out at cruise) and
 * carries navigation lights. Three draw calls for every aircraft together.
 */
function Aircraft({ curves }: { curves: readonly ArcCurve[] }) {
  const pixelRatio = useThree((state) => state.viewport.dpr);
  const planes = useRef<InstancedMesh>(null);
  const count = Math.max(1, curves.length);
  const geometry = useMemo(() => {
    const geo = airlinerGeometry();
    const tints = curves.flatMap(({ arc }) =>
      new Color().copy(arcColor(arc.kind)).lerp(WHITE, 0.12).toArray(),
    );
    geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(tints), 3));
    return geo;
  }, [curves]);
  const shadowGeometry = useMemo(() => {
    const geo = airlinerShadowGeometry();
    geo.setAttribute('aPos', new InstancedBufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aFwd', new InstancedBufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aScale', new InstancedBufferAttribute(new Float32Array(count), 1));
    return geo;
  }, [count]);
  const lightGeometry = useMemo(() => {
    const slots = curves.flatMap((_, index) => NAV_LIGHTS.map((light) => ({ index, light })));
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(slots.length * 3), 3));
    geo.setAttribute('aVis', new BufferAttribute(new Float32Array(slots.length), 1));
    geo.setAttribute(
      'aColor',
      new BufferAttribute(
        new Float32Array(slots.flatMap(({ light }) => new Color(light.color).toArray())),
        3,
      ),
    );
    geo.setAttribute(
      'aStrobe',
      new BufferAttribute(new Float32Array(slots.map(({ light }) => (light.strobe ? 1 : 0))), 1),
    );
    geo.setAttribute(
      'aSeed',
      new BufferAttribute(new Float32Array(slots.map(({ index }) => arcPhase(index * 3 + 1))), 1),
    );
    return geo;
  }, [curves]);
  useEffect(
    () => () => {
      geometry.dispose();
      shadowGeometry.dispose();
      lightGeometry.dispose();
    },
    [geometry, shadowGeometry, lightGeometry],
  );
  const planeUniforms = useMemo(() => ({ uArcs: LIVE.uArcs, uSun: { value: SUN.value } }), []);
  const shadowUniforms = useMemo(() => ({ uArcs: LIVE.uArcs, uSun: { value: SUN.value } }), []);
  const lightUniforms = useMemo(
    () => ({ uTime: LIVE.uTime, uArcs: LIVE.uArcs, uPixelRatio: { value: pixelRatio } }),
    [pixelRatio],
  );
  const scratch = useMemo(
    () => ({
      point: new Vector3(),
      tangent: new Vector3(),
      before: new Vector3(),
      after: new Vector3(),
      up: new Vector3(),
      right: new Vector3(),
      light: new Vector3(),
      matrix: new Matrix4(),
      scale: new Matrix4(),
    }),
    [],
  );

  useFrame((state) => {
    const instanced = planes.current;
    if (!instanced) return;
    const t = state.clock.elapsedTime;
    const lit = getHighlightRoute();
    const airport = getInteraction().selectedAirport;
    const { point, tangent, before, after, up, right, light, matrix, scale } = scratch;
    const shadowPos = shadowGeometry.getAttribute('aPos') as InstancedBufferAttribute;
    const shadowFwd = shadowGeometry.getAttribute('aFwd') as InstancedBufferAttribute;
    const shadowScale = shadowGeometry.getAttribute('aScale') as InstancedBufferAttribute;
    const lightPos = lightGeometry.getAttribute('position') as BufferAttribute;
    const lightVis = lightGeometry.getAttribute('aVis') as BufferAttribute;
    curves.forEach(({ arc, curve, order }, index) => {
      const head = pulseHead(t, arcPhase(order));
      const drawn = drawProgress(arc.id, order, t, false);
      const shown = head <= Math.min(1, drawn) && !isDimmed(arc, lit, airport);
      const u = Math.min(1, head);
      const grow = shown ? presence(u) : 0;
      const s = AIRCRAFT_SCALE * (lit === arc.id ? 1.3 : 1) * grow;
      curve.getPointAt(u, point);
      curve.getTangentAt(u, tangent);
      curve.getTangentAt(Math.max(0, u - TURN_STEP), before);
      curve.getTangentAt(Math.min(1, u + TURN_STEP), after);
      up.copy(point).normalize();
      right.crossVectors(tangent, up).normalize();
      const turn = bankAngle(before, after, right, curve.getLength() * TURN_STEP * 2);
      // Light turbulence: two slow, out-of-step swells, never the same on two aircraft.
      const seed = order * 1.7;
      const chop = Math.sin(t * 1.3 + seed) * 0.03 + Math.sin(t * 0.47 + seed * 2.3) * 0.045;
      attitude(point, tangent, turn + chop, matrix);
      matrix.multiply(scale.makeScale(s, s, s));
      instanced.setMatrixAt(index, matrix);
      shadowPos.setXYZ(index, point.x, point.y, point.z);
      shadowFwd.setXYZ(index, tangent.x, tangent.y, tangent.z);
      shadowScale.setX(index, s);
      NAV_LIGHTS.forEach((nav, k) => {
        light.set(...nav.at).applyMatrix4(matrix);
        lightPos.setXYZ(index * NAV_LIGHTS.length + k, light.x, light.y, light.z);
        lightVis.setX(index * NAV_LIGHTS.length + k, grow);
      });
    });
    instanced.count = curves.length;
    instanced.instanceMatrix.needsUpdate = true;
    for (const attribute of [shadowPos, shadowFwd, shadowScale, lightPos, lightVis]) {
      attribute.needsUpdate = true;
    }
  });

  return (
    <>
      <instancedMesh
        args={[shadowGeometry, undefined, count]}
        count={curves.length}
        renderOrder={1}
        frustumCulled={false}
      >
        <shaderMaterial
          ref={linkLive}
          vertexShader={planeShadowVertex}
          fragmentShader={planeShadowFragment}
          uniforms={shadowUniforms}
          transparent
          depthWrite={false}
        />
      </instancedMesh>
      <instancedMesh
        ref={planes}
        args={[geometry, undefined, count]}
        renderOrder={5}
        frustumCulled={false}
      >
        <shaderMaterial
          ref={linkLive}
          vertexShader={planeVertex}
          fragmentShader={planeFragment}
          uniforms={planeUniforms}
          transparent
        />
      </instancedMesh>
      <points geometry={lightGeometry} renderOrder={6} frustumCulled={false}>
        <shaderMaterial
          ref={linkLive}
          vertexShader={navVertex}
          fragmentShader={navFragment}
          uniforms={lightUniforms}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </points>
    </>
  );
}

const flowVertex = /* glsl */ `
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  uniform float uArcs;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vAlpha = aAlpha * uArcs;
    vColor = aColor;
    gl_PointSize = min(18.0, 7.0 * uPixelRatio * (3.2 / -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const flowFragment = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float glow = exp(-d * d * 5.0);
    float core = smoothstep(0.35, 0.0, d);
    gl_FragColor = vec4(mix(vColor, vec3(1.0, 0.97, 0.92), core * 0.6), (glow * 0.7 + core * 0.5) * vAlpha);
  }
`;

/** Ground speed of the moving lights, radians of arc per second (same for every route). */
const FLOW_SPEED = 0.028;

/**
 * Moving lights along every arc, evenly spaced, at one shared ground speed. Each route carries
 * flowCount(flights) of them, so a busier route visibly carries more traffic.
 */
function Flow({ curves }: { curves: readonly ArcCurve[] }) {
  const pixelRatio = useThree((state) => state.viewport.dpr);
  const slots = useMemo(
    () =>
      curves.flatMap(({ arc, curve, order: index }) => {
        const count = flowCount(arc.flights);
        const [a, b] = [arc.points[0]!, arc.points[arc.points.length - 1]!];
        const angle = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
        const rate = FLOW_SPEED / Math.max(angle, 0.04);
        return Array.from({ length: count }, (_, k) => ({
          arc,
          curve,
          index,
          rate,
          offset: (k + arcPhase(index)) / count,
        }));
      }),
    [curves],
  );
  const geometry = useMemo(() => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(slots.length * 3), 3));
    geo.setAttribute('aAlpha', new BufferAttribute(new Float32Array(slots.length), 1));
    geo.setAttribute(
      'aColor',
      new BufferAttribute(
        new Float32Array(slots.flatMap((slot) => arcColor(slot.arc.kind).toArray())),
        3,
      ),
    );
    return geo;
  }, [slots]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const uniforms = useMemo(
    () => ({ uArcs: LIVE.uArcs, uPixelRatio: { value: pixelRatio } }),
    [pixelRatio],
  );
  const point = useMemo(() => new Vector3(), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const lit = getHighlightRoute();
    const airport = getInteraction().selectedAirport;
    const position = geometry.getAttribute('position') as BufferAttribute;
    const alpha = geometry.getAttribute('aAlpha') as BufferAttribute;
    slots.forEach((slot, i) => {
      const u = (((t * slot.rate + slot.offset) % 1) + 1) % 1;
      const drawn = drawProgress(slot.arc.id, slot.index, t, false);
      slot.curve.getPointAt(u, point);
      position.setXYZ(i, point.x, point.y, point.z);
      // Fade in and out at the airports, hide past the draw-in, and step back when dimmed.
      const ends = Math.min(1, u / 0.06, (1 - u) / 0.06);
      const dim = isDimmed(slot.arc, lit, airport) ? 0.12 : lit === slot.arc.id ? 1.4 : 1;
      alpha.setX(i, u <= drawn ? ends * dim : 0);
    });
    position.needsUpdate = true;
    alpha.needsUpdate = true;
  });

  if (slots.length === 0) return null;
  return (
    <points geometry={geometry} renderOrder={4} frustumCulled={false}>
      <shaderMaterial
        ref={linkLive}
        vertexShader={flowVertex}
        fragmentShader={flowFragment}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={AdditiveBlending}
      />
    </points>
  );
}

export function Routes({
  curves,
  reduced,
  hoverable,
}: {
  curves: readonly ArcCurve[];
  reduced: boolean;
  hoverable: boolean;
}) {
  return (
    <>
      {curves.map((entry) => (
        <Arc
          key={entry.arc.id}
          entry={entry}
          index={entry.order}
          reduced={reduced}
          hoverable={hoverable}
        />
      ))}
      {reduced || curves.length === 0 ? null : <Aircraft key={curves.length} curves={curves} />}
      {reduced ? null : <Flow curves={curves} />}
    </>
  );
}
