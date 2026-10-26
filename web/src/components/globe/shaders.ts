/** Shared GLSL, per-frame uniforms and small helpers for the globe's layers. */

/**
 * Uniforms every arc, aircraft and airport shares, written once per frame by the Rig (inside
 * useFrame, never during render). One globe is mounted at a time, so one set suffices.
 */
export const LIVE = {
  uTime: { value: 0 },
  uArcs: { value: 1 },
  uBright: { value: 1 },
  /** Airport beacon brightness, per chapter. */
  uBeacons: { value: 1 },
};

/**
 * Re-links the shared LIVE uniforms onto a material. R3F copies each uniform object it is given
 * (to keep a stable target), so passing LIVE.uTime in `uniforms` alone would freeze a copy at its
 * first value. Use as (or inside) the material's ref callback.
 */
export function linkLive(material: { uniforms: Record<string, { value: unknown }> } | null): void {
  if (!material) return;
  for (const [name, uniform] of Object.entries(LIVE)) {
    if (name in material.uniforms) material.uniforms[name] = uniform;
  }
}

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

/** Lets an arc draw in again the next time it appears. */
export function forgetDraw(id: string): void {
  bornAt.delete(id);
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

/**
 * Surface lighting for the solid 3D layer (aircraft, towers), matching the planet: the same sun
 * fixed in view space (`uSun`), a view-space hemisphere ambient (cool from above, faintly warm from
 * below), a Blinn glint for the low evening sun and a cool rim. `day` (0..1) is whether the ground
 * under the object faces the sun, so the night side is lit by the sky alone; `haze` (0..1) is how
 * close to the limb it sits, where the atmosphere softens it toward the limb colour.
 */
export const LIT_GLSL = /* glsl */ `
  uniform vec3 uSun;
  const vec3 SUN_TINT = vec3(1.0, 0.84, 0.66);
  const vec3 SKY_TINT = vec3(0.13, 0.15, 0.2);
  const vec3 FLOOR_TINT = vec3(0.07, 0.055, 0.045);
  const vec3 RIM_TINT = vec3(0.66, 0.72, 0.8);
  vec3 litSurface(vec3 albedo, vec3 n, vec3 v, float day, float gloss, float shine) {
    float ndl = max(dot(n, uSun), 0.0) * day;
    vec3 ambient = mix(FLOOR_TINT, SKY_TINT, n.y * 0.5 + 0.5);
    vec3 h = normalize(uSun + v);
    float glint = pow(max(dot(n, h), 0.0), gloss) * shine * ndl;
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * (0.3 + 0.7 * day);
    return albedo * (ambient + SUN_TINT * ndl * 1.3) + SUN_TINT * glint + RIM_TINT * rim * 0.16;
  }
  vec3 airHaze(vec3 color, float haze) {
    return mix(color, vec3(0.66, 0.72, 0.8) * 0.32, haze * 0.55);
  }
`;

/**
 * Shared by the ground shadows: the sun in the globe's own frame (the inverse of the model-view
 * rotation; the rig only rotates and translates), how high it stands over the surface normal `n`,
 * and the horizontal direction pointing away from it, along which a shadow falls.
 */
export const SHADOW_GLSL = /* glsl */ `
  uniform vec3 uSun;
  vec3 localSun() {
    return normalize(transpose(mat3(modelViewMatrix)) * uSun);
  }
  vec3 awayFromSun(vec3 n, vec3 sun) {
    vec3 flat_ = sun - n * dot(n, sun);
    float len = length(flat_);
    if (len < 1e-4) return normalize(cross(n, vec3(0.0, 1.0, 0.0)));
    return -flat_ / len;
  }
`;
