import React, { createContext, useContext, useEffect, useRef, useCallback, useMemo } from 'react';
import Lenis from 'lenis';

interface LenisContextValue {
  lenis: Lenis | null;
  scrollTo: (target: number | string | HTMLElement, options?: { offset?: number; duration?: number }) => void;
  lockScroll: (locked: boolean) => void;
}

const LenisContext = createContext<LenisContextValue>({
  lenis: null,
  scrollTo: () => {},
  lockScroll: () => {},
});

export const useLenis = () => useContext(LenisContext);

export const LenisProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    // Initialize Lenis once with specific easing and duration
    const lenis = new Lenis({
      duration: 1.2,
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      orientation: 'vertical',
      gestureOrientation: 'vertical',
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 2,
    });

    lenisRef.current = lenis;

    let rafId: number;
    function raf(time: number) {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }
    rafId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, []);

  const scrollTo = useCallback((target: number | string | HTMLElement, options?: { offset?: number; duration?: number }) => {
    if (!lenisRef.current) {
      if (typeof target === 'number') {
        window.scrollTo({ top: target, behavior: 'smooth' });
      } else if (typeof target === 'string') {
        const id = target.startsWith('#') ? target.slice(1) : target;
        const el = document.getElementById(id);
        el?.scrollIntoView({ behavior: 'smooth' });
      }
      return;
    }
    lenisRef.current.scrollTo(target, {
      offset: options?.offset ?? 0,
      duration: options?.duration ?? 1.6,
    });
  }, []);

  const lockScroll = useCallback((locked: boolean) => {
    if (!lenisRef.current) return;
    if (locked) {
      lenisRef.current.stop();
    } else {
      lenisRef.current.start();
    }
  }, []);

  const contextValue = useMemo(() => ({
    lenis: lenisRef.current,
    scrollTo,
    lockScroll,
  }), [scrollTo, lockScroll]);

  return (
    <LenisContext.Provider value={contextValue}>
      {children}
    </LenisContext.Provider>
  );
};

