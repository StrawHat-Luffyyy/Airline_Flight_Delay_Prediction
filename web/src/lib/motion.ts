/**
 * Motion tokens for the intro hero: durations (seconds), easings and the entrance timeline.
 * The whole entrance finishes by 1.7 s (buttons at 1.2 s + 0.5 s). This file must not import the
 * `motion` package: the entrance is CSS + requestAnimationFrame so the eager bundle stays small,
 * and only the lazy enhancer (hero/enhance.ts) loads Motion.
 */

/** Confident deceleration; the same curve as --ease-out-expo in index.css. */
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

/** easeOutExpo for JS-driven tweens (count-ups); matches EASE_OUT_EXPO closely. */
export function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/** Immediate feedback (hover, press). */
export const FEEDBACK_S = 0.18;

export const HERO = {
  /** Headline lines slide up from a mask, one after another. */
  lineDuration: 0.7,
  lineStagger: 0.12,
  /** Subline and the flight-count count-up. */
  sublineAt: 0.45,
  sublineDuration: 0.6,
  countDuration: 0.9,
  /** Stat row: hairlines draw, then cells rise and count in stagger. */
  hairlinesAt: 0.75,
  hairlineDuration: 0.5,
  statsAt: 0.9,
  statStagger: 0.1,
  statDuration: 0.5,
  statCountDuration: 0.6,
  /** Primary and secondary actions arrive last. */
  buttonsAt: 1.2,
  buttonsDuration: 0.5,
  /** Flight-path arc on the right: draws once, then a plane loops along it. */
  pathAt: 0.6,
  pathDuration: 1.6,
  planeLoopS: 16,
  /** Scroll cue appears after the entrance has settled. */
  cueAt: 1.8,
} as const;

/** Background parallax: slow, heavily damped (layers trail the cursor). */
export const PARALLAX_SPRING = { stiffness: 50, damping: 20, mass: 0.6 } as const;

/** Magnetic CTA: quick to follow, quick to settle. */
export const MAGNET_SPRING = { stiffness: 220, damping: 18, mass: 0.2 } as const;

/** Parallax travel per layer in px, opposite the cursor (far layers move least). */
export const PARALLAX_PX = { video: 8, cloudsFar: 12, cloudsNear: 20, path: 14 } as const;

/** 0 before `from`, 1 after `to`, linear between: a clamped ramp for scroll-linked values. */
export function ramp(value: number, from: number, to: number): number {
  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}

// ---------- Entrance clock ----------
// Blocks that wait on data (stats, flight count) mount late. They ask how much of their scheduled
// delay is left so a slow response never replays the whole sequence. Read only inside effects.

let heroStart: number | null = null;

/** Seconds since the hero's first entrance effect ran. */
function heroElapsed(): number {
  const now = performance.now();
  heroStart ??= now;
  return (now - heroStart) / 1000;
}

/** The part of a scheduled delay (seconds from hero start) that has not elapsed yet. */
export function remainingDelay(at: number): number {
  return Math.max(0, at - heroElapsed());
}

/** Restart the clock when the hero unmounts, so a revisit plays the entrance again. */
export function resetHeroClock(): void {
  heroStart = null;
}
