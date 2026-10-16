import { animate, type DOMKeyframesDefinition } from 'motion/react';
import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { EASE_OUT_EXPO, remainingDelay } from '../../lib/motion';

/**
 * Plays a one-off entrance on mount, at `at` seconds on the hero clock (or straight away if that
 * moment has passed, e.g. when data arrived late). Returns [ref, pre-entrance style].
 */
export function useEntrance<T extends HTMLElement>(
  at: number,
  keyframes: DOMKeyframesDefinition,
  duration: number,
  reduced: boolean,
  hidden: CSSProperties,
): readonly [RefObject<T | null>, CSSProperties | undefined] {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || reduced) return;
    const controls = animate(node, keyframes, {
      delay: remainingDelay(at),
      duration,
      ease: EASE_OUT_EXPO,
    });
    return () => controls.stop();
    // Keyframes are literals defined by the caller; the entrance runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, duration, reduced]);
  return [ref, reduced ? undefined : hidden] as const;
}

/**
 * A number that counts up from 0 to `value` with ease-out. The final text is laid out invisibly
 * underneath so the width never changes while counting (no layout jitter); screen readers get
 * only the final value. `format` must be a stable (module-level) function.
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
    const controls = animate(0, value, {
      delay: remainingDelay(at),
      duration,
      ease: EASE_OUT_EXPO,
      onUpdate: (current) => {
        node.textContent = format(current);
      },
    });
    return () => controls.stop();
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
