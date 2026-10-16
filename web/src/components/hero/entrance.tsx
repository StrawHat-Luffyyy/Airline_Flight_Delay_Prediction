import { useEffect, useRef, type RefObject } from 'react';
import { easeOutExpo, remainingDelay } from '../../lib/motion';

const EASE_OUT_EXPO_CSS = 'cubic-bezier(0.16, 1, 0.3, 1)';

const KEYFRAMES: Record<'hero-rise' | 'hero-draw', Keyframe[]> = {
  'hero-rise': [
    { opacity: 0, transform: 'translateY(12px)' },
    { opacity: 1, transform: 'none' },
  ],
  'hero-draw': [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
};

/**
 * One element's entrance, played with the native Web Animations API (no library). `kind` picks the
 * pre-entrance class (`hero-rise` hides it, `hero-draw` collapses a hairline) and the keyframes.
 * The delay is what remains of `at` on the hero clock, so a block whose data arrived late joins the
 * sequence where it is instead of replaying it. WAAPI rather than a CSS animation on purpose:
 * Chrome then keeps the headline as the LCP element instead of the later-revealed subline.
 * Returns [ref, className].
 */
export function useEntrance<T extends HTMLElement>(
  kind: 'hero-rise' | 'hero-draw',
  at: number,
  duration: number,
  reduced: boolean,
): readonly [RefObject<T | null>, string] {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || reduced) return;
    const animation = node.animate(KEYFRAMES[kind], {
      delay: remainingDelay(at) * 1000,
      duration: duration * 1000,
      easing: EASE_OUT_EXPO_CSS,
      fill: 'both',
    });
    return () => animation.cancel();
  }, [kind, at, duration, reduced]);
  return [ref, reduced ? '' : kind] as const;
}

/**
 * A number that counts up from 0 to `value` with ease-out (requestAnimationFrame, no library).
 * The final text is laid out invisibly underneath so the width never changes while counting;
 * screen readers get only the final value. `format` must be a stable (module-level) function.
 */
export function CountUp({
  value,
  format,
  at,
  duration,
  reduced,
  className = '',
}: {
  value: number;
  format: (value: number) => string;
  at: number;
  duration: number;
  reduced: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const final = format(value);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (reduced) {
      node.textContent = format(value);
      return;
    }
    node.textContent = format(0);
    const startAt = performance.now() + remainingDelay(at) * 1000;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.max(0, (now - startAt) / (duration * 1000));
      node.textContent = format(value * easeOutExpo(Math.min(1, t)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, format, at, duration, reduced]);

  return (
    <span className={`inline-grid ${className}`}>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {final}
      </span>
      {/* Text is written imperatively (no React children), so React never fights the counter. */}
      <span ref={ref} aria-hidden="true" className="col-start-1 row-start-1" />
      <span className="sr-only">{final}</span>
    </span>
  );
}
