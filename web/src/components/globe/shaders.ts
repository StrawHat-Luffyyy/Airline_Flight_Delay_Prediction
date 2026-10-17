/** Shared GLSL, per-frame uniforms and small helpers for the globe's layers. */

/**
 * Uniforms every arc, aircraft and airport shares, written once per frame by the Rig (inside
 * useFrame, never during render). One globe is mounted at a time, so one set suffices.
 */
export const LIVE = {
  uTime: { value: 0 },
  uArcs: { value: 1 },
  uBright: { value: 1 },
};

/** Pulse speed along an arc (fraction of the arc per second, before the 1.35 overshoot). */
export const PULSE_SPEED = 0.11;
/** The pulse runs past the end (to 1.35) so it leaves the arc before restarting. */
export const PULSE_SPAN = 1.35;

/** Where an arc's pulse head is at time `t`; the same formula drives the shader and the aircraft. */
export function pulseHead(t: number, phase: number): number {
  return ((((t * PULSE_SPEED + phase) % 1) + 1) % 1) * PULSE_SPAN;
}

export function arcPhase(index: number): number {
  return (index * 0.137) % 1;
}

/** Arcs draw in when they first appear, staggered; seconds. */
const DRAW_DELAY = 0.9;
const DRAW_S = 1.5;
const DRAW_STAGGER = 0.07;
const bornAt = new Map<string, number>();

/** 0..1 of an arc's draw-in. The first call for an id starts its clock. */
export function drawProgress(id: string, index: number, t: number, reduced: boolean): number {
  if (reduced) return 1;
  let born = bornAt.get(id);
  if (born === undefined) {
    // Arcs present when the scene starts wait for the entrance; later ones draw at once.
    born = Math.max(t, DRAW_DELAY);
    bornAt.set(id, born);
  }
  return Math.min(1, Math.max(0, (t - born - index * DRAW_STAGGER) / DRAW_S));
}

export function resetDrawClock(): void {
  bornAt.clear();
}

export const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/** Deterministic PRNG (the same sky and twinkle on every visit). */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Soft round points that twinkle; used for stars. */
export const pointVertex = /* glsl */ `
  attribute float aSize;
  attribute float aSeed;
  uniform float uTime;
  uniform float uBright;
  uniform float uPixelRatio;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vAlpha = (0.78 + 0.22 * sin(uTime * 1.1 + aSeed * 6.2831)) * uBright;
    gl_PointSize = aSize * uPixelRatio * (3.2 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
export const pointFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float core = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor, core * core * vAlpha);
  }
`;
