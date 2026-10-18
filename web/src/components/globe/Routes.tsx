/**
 * Route arcs: a thin core with a comet trail, a soft halo tube that makes it glow without a
 * post-processing pass, an invisible fat tube for picking, one aircraft per arc riding the pulse
 * head, and a stream of moving lights whose density follows the route's real 2015 flight count.
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
  DoubleSide,
  type InstancedMesh,
  Matrix4,
  type ShaderMaterial,
  Shape,
  ShapeGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { flowCount, type ArcKind, type RouteArc } from './geo';
import { AMBER_HEX, BLUE_HEX, NETWORK_HEX } from './palette';
import {
  arcPhase,
  damp,
  drawProgress,
  forgetDraw,
  linkLive,
  LIVE,
  PULSE_SPAN,
  PULSE_SPEED,
  pulseHead,
} from './shaders';
import { clearHover, getHighlightRoute, getInteraction, setHover, setSelected } from './store';

export const AMBER = new Color(AMBER_HEX);
export const BLUE = new Color(BLUE_HEX);
/** A selected airport's destinations: no delay figure per route, so not a data colour. */
export const NETWORK = new Color(NETWORK_HEX);

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

/** A small swept-wing silhouette, nose along +y, flat in the xy plane. */
function aircraftGeometry(): ShapeGeometry {
  const shape = new Shape();
  shape.moveTo(0, 1);
  shape.lineTo(0.16, 0.25);
  shape.lineTo(1, -0.15);
  shape.lineTo(1, -0.32);
  shape.lineTo(0.14, -0.12);
  shape.lineTo(0.1, -0.7);
  shape.lineTo(0.38, -0.92);
  shape.lineTo(0.38, -1);
  shape.lineTo(0, -0.88);
  shape.lineTo(-0.38, -1);
  shape.lineTo(-0.38, -0.92);
  shape.lineTo(-0.1, -0.7);
  shape.lineTo(-0.14, -0.12);
  shape.lineTo(-1, -0.32);
  shape.lineTo(-1, -0.15);
  shape.lineTo(-0.16, 0.25);
  shape.closePath();
  return new ShapeGeometry(shape);
}

const AIRCRAFT_SCALE = 0.0085;
const WHITE = new Color('#fff6e6');

/** One aircraft per arc, at the pulse head, flying along the great circle. */
function Aircraft({ curves }: { curves: readonly ArcCurve[] }) {
  const meshRef = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => aircraftGeometry(), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const scratch = useMemo(
    () => ({
      point: new Vector3(),
      tangent: new Vector3(),
      up: new Vector3(),
      right: new Vector3(),
      matrix: new Matrix4(),
      scale: new Matrix4(),
      color: new Color(),
    }),
    [],
  );

  useFrame((state) => {
    const instanced = meshRef.current;
    if (!instanced) return;
    const t = state.clock.elapsedTime;
    const lit = getHighlightRoute();
    const airport = getInteraction().selectedAirport;
    const { point, tangent, up, right, matrix, scale, color } = scratch;
    curves.forEach(({ arc, curve, order }, index) => {
      const head = pulseHead(t, arcPhase(order));
      const drawn = drawProgress(arc.id, order, t, false);
      const visible = head <= Math.min(1, drawn) && !isDimmed(arc, lit, airport);
      const s = visible ? AIRCRAFT_SCALE * (lit === arc.id ? 1.35 : 1) : 0;
      const u = Math.min(1, head);
      curve.getPointAt(u, point);
      curve.getTangentAt(u, tangent).normalize();
      up.copy(point).normalize();
      right.crossVectors(tangent, up).normalize();
      matrix.makeBasis(right, tangent, up).setPosition(point);
      scale.makeScale(s, s, s);
      matrix.multiply(scale);
      instanced.setMatrixAt(index, matrix);
      color.copy(arcColor(arc.kind)).lerp(WHITE, 0.3);
      instanced.setColorAt(index, color);
    });
    instanced.count = curves.length;
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, undefined, Math.max(1, curves.length)]}
      renderOrder={4}
      frustumCulled={false}
    >
      <meshBasicMaterial
        side={DoubleSide}
        transparent
        depthWrite={false}
        toneMapped={false}
        blending={AdditiveBlending}
      />
    </instancedMesh>
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
