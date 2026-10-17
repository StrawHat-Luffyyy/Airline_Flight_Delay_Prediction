/**
 * Route arcs: a thin core with a comet trail, a soft halo tube that makes it glow without a
 * post-processing pass, an invisible fat tube for picking, and one aircraft per arc riding the
 * pulse head. Amber = most often late, blue = most punctual (DESIGN.md Paired Encoding Rule).
 */
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
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
import type { RouteArc } from './geo';
import { arcPhase, damp, drawProgress, LIVE, PULSE_SPAN, PULSE_SPEED, pulseHead } from './shaders';
import { clearHover, getHighlightRoute, setHover, setSelected } from './store';

export const AMBER = new Color('#e8a54b');
export const BLUE = new Color('#7c9bd1');

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
}

export function useArcCurves(arcs: readonly RouteArc[]): ArcCurve[] {
  return useMemo(
    () =>
      arcs.map((arc) => ({
        arc,
        curve: new CatmullRomCurve3(arc.points.map(([x, y, z]) => new Vector3(x, y, z))),
      })),
    [arcs],
  );
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
      new TubeGeometry(curve, 128, 0.0038, 6, false),
      new TubeGeometry(curve, 96, 0.016, 8, false),
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
      uColor: { value: arc.kind === 'late' ? AMBER : BLUE },
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

  useFrame((state, dt) => {
    const c = core.current?.uniforms;
    const h = halo.current?.uniforms;
    if (!c || !h) return;
    const lit = getHighlightRoute();
    const focused = lit === arc.id ? 1 : 0;
    const dimmed = lit !== null && !focused ? 1 : 0;
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
    if (event.delta < 4) setSelected(arc.id);
  };

  return (
    <group>
      <mesh geometry={haloGeometry} renderOrder={1}>
        <shaderMaterial
          ref={halo}
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
          ref={core}
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

const AIRCRAFT_SCALE = 0.012;
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
    const { point, tangent, up, right, matrix, scale, color } = scratch;
    curves.forEach(({ arc, curve }, index) => {
      const head = pulseHead(t, arcPhase(index));
      const drawn = drawProgress(arc.id, index, t, false);
      const visible = head <= Math.min(1, drawn) && (lit === null || lit === arc.id);
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
      color.copy(arc.kind === 'late' ? AMBER : BLUE).lerp(WHITE, 0.3);
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
      {curves.map((entry, index) => (
        <Arc
          key={entry.arc.id}
          entry={entry}
          index={index}
          reduced={reduced}
          hoverable={hoverable}
        />
      ))}
      {reduced || curves.length === 0 ? null : <Aircraft key={curves.length} curves={curves} />}
    </>
  );
}
