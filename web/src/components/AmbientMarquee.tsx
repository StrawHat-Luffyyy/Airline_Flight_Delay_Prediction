import React, { useRef } from 'react';
import {
  motion,
  useScroll,
  useVelocity,
  useSpring,
  useTransform,
  useMotionValue,
  useAnimationFrame,
  useReducedMotion,
} from 'framer-motion';

const MARQUEE_TEXT = 'HISTORICAL FLIGHTS • WEATHER • AIRCRAFT ROTATION • AIRPORT CONGESTION • ';

export const AmbientMarquee: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const baseX = useMotionValue(0);

  const { scrollY } = useScroll();
  const scrollVelocity = useVelocity(scrollY);
  const smoothVelocity = useSpring(scrollVelocity, {
    damping: 50,
    stiffness: 400,
  });

  const velocityFactor = useTransform(smoothVelocity, [0, 1000], [0, 4], {
    clamp: false,
  });

  useAnimationFrame((_, delta) => {
    if (shouldReduceMotion) return;
    // Base speed: 0.015% per ms, accelerated by scroll velocity
    const factor = Math.abs(velocityFactor.get());
    const moveBy = -0.015 * delta * (1 + factor);
    let newX = baseX.get() + moveBy;

    // Seamless loop: since the content is doubled, loop at -50%
    if (newX <= -50) {
      newX += 50;
    }
    baseX.set(newX);
  });

  const xTransform = useTransform(baseX, (val) => `${val}%`);

  return (
    <div
      ref={containerRef}
      className="relative w-full py-10 sm:py-16 overflow-hidden bg-[#010101] border-y border-white/5 select-none pointer-events-none"
    >
      {/* 300px Gradient fades at edges */}
      <div className="absolute top-0 inset-x-0 h-12 bg-gradient-to-b from-[#010101] to-transparent pointer-events-none z-10" />
      <div className="absolute bottom-0 inset-x-0 h-12 bg-gradient-to-t from-[#010101] to-transparent pointer-events-none z-10" />

      {/* Marquee track */}
      <motion.div
        style={{ x: shouldReduceMotion ? '0%' : xTransform }}
        className="flex whitespace-nowrap will-change-transform"
      >
        <span className="font-serif-display font-normal text-[10vw] sm:text-[11vw] lg:text-[12vw] leading-none tracking-tight stroke-marquee uppercase pr-6">
          {MARQUEE_TEXT.repeat(4)}
        </span>
        <span className="font-serif-display font-normal text-[10vw] sm:text-[11vw] lg:text-[12vw] leading-none tracking-tight stroke-marquee uppercase pr-6">
          {MARQUEE_TEXT.repeat(4)}
        </span>
      </motion.div>
    </div>
  );
};
