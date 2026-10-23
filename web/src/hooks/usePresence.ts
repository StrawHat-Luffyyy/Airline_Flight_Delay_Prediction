import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * Keeps a closing surface mounted for `exitMs` so it can play its exit animation. `closing` is true
 * during that window; reopening cancels it. Under reduced motion the surface unmounts at once.
 */
export function usePresence(open: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
  const reduced = usePrefersReducedMotion();
  const [lingering, setLingering] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  // Adjust state during render when `open` flips (React's "storing previous props" pattern).
  if (open !== wasOpen) {
    setWasOpen(open);
    setLingering(!open && !reduced);
  }

  useEffect(() => {
    if (!lingering) return;
    const timer = setTimeout(() => setLingering(false), exitMs);
    return () => clearTimeout(timer);
  }, [lingering, exitMs]);

  return { mounted: open || lingering, closing: !open && lingering };
}
