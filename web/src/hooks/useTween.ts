import { useEffect, useRef, useState } from 'react';
import { easeOutExpo } from '../lib/motion';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * A number that eases toward `target` over `durationMs` (easeOutExpo), starting from `from` on
 * mount and from wherever it is when the target changes mid-flight. Under reduced motion it is
 * always the target.
 */
export function useTween(target: number, durationMs: number, from = 0): number {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(from);
  const current = useRef(from);

  useEffect(() => {
    if (reduced) {
      current.current = target;
      setValue(target);
      return;
    }
    const start = current.current;
    if (start === target) return;
    const began = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - began) / durationMs);
      const next = start + (target - start) * easeOutExpo(t);
      current.current = t >= 1 ? target : next;
      setValue(current.current);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, reduced]);

  return reduced ? target : value;
}
