import React, { useEffect, useState } from 'react';
import { motion, useMotionValue, useSpring, useReducedMotion } from 'framer-motion';

export const CursorGlow: React.FC = () => {
  const shouldReduceMotion = useReducedMotion();
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [isOverVideo, setIsOverVideo] = useState(true);
  const [hasMoved, setHasMoved] = useState(false);

  const rawX = useMotionValue(-500);
  const rawY = useMotionValue(-500);

  const springX = useSpring(rawX, { stiffness: 120, damping: 20 });
  const springY = useSpring(rawY, { stiffness: 120, damping: 20 });
  const springSize = useSpring(320, { stiffness: 120, damping: 20 });

  useEffect(() => {
    // Detect touch-only devices
    if (typeof window !== 'undefined') {
      const matchTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
      setIsTouchDevice(matchTouch);
    }
  }, []);

  useEffect(() => {
    if (shouldReduceMotion || isTouchDevice) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!hasMoved) setHasMoved(true);
      rawX.set(e.clientX);
      rawY.set(e.clientY);

      const target = e.target as HTMLElement | null;
      // Check if hovering over interactive elements
      const isInteractive = Boolean(
        target?.closest('a, button, [role="button"], input, select, textarea, .liquid-glass')
      );
      springSize.set(isInteractive ? 480 : 320);

      // Check if hovering over video sections vs black sections
      const overVideoSection = Boolean(
        target?.closest('#top, #predictor, #data')
      );
      setIsOverVideo(overVideoSection);
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [shouldReduceMotion, isTouchDevice, hasMoved, rawX, rawY, springSize]);

  if (shouldReduceMotion || isTouchDevice || !hasMoved) {
    return null;
  }

  // 0.08 over video sections, reduced to 0.04 over black sections
  const glowAlpha = isOverVideo ? 0.08 : 0.04;

  return (
    <motion.div
      style={{
        x: springX,
        y: springY,
        width: springSize,
        height: springSize,
        translateX: '-50%',
        translateY: '-50%',
      }}
      className="fixed top-0 left-0 pointer-events-none z-[60] rounded-full hidden md:block"
    >
      <div
        className="w-full h-full rounded-full transition-[background] duration-300 ease-out"
        style={{
          background: `radial-gradient(circle, rgba(255,255,255,${glowAlpha}), transparent 70%)`,
          mixBlendMode: 'screen',
        }}
      />
    </motion.div>
  );
};
