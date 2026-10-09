import React, { useRef } from 'react';
import { motion, useMotionValue, useSpring, useReducedMotion } from 'framer-motion';

interface MagneticButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit' | 'reset';
  className?: string;
  disabled?: boolean;
}

export const MagneticButton: React.FC<MagneticButtonProps> = ({
  children,
  onClick,
  type = 'button',
  className = '',
  disabled = false,
}) => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const shouldReduceMotion = useReducedMotion();

  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const springX = useSpring(x, { stiffness: 180, damping: 15 });
  const springY = useSpring(y, { stiffness: 180, damping: 15 });

  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (shouldReduceMotion || !btnRef.current) return;

    const rect = btnRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;
    const dist = Math.hypot(dx, dy);

    const maxRadius = 80;
    const maxShift = 12;

    if (dist < maxRadius) {
      const pull = 1 - dist / maxRadius;
      x.set((dx / (dist || 1)) * maxShift * pull);
      y.set((dy / (dist || 1)) * maxShift * pull);
    } else {
      x.set(0);
      y.set(0);
    }
  };

  const handleMouseLeave = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.button
      ref={btnRef}
      type={type}
      disabled={disabled}
      style={{
        x: shouldReduceMotion ? 0 : springX,
        y: shouldReduceMotion ? 0 : springY,
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
      className={`liquid-glass relative rounded-full px-10 py-4 min-h-[52px] inline-flex items-center justify-center text-white uppercase tracking-[0.2em] text-xs sm:text-sm font-light transition-all cursor-pointer overflow-hidden focus:outline-none focus:ring-1 focus:ring-white/40 !bg-white/[0.06] ${className}`}
    >
      {/* Diagonal Shimmer Sweep: pointer-events-none and sits behind the label */}
      {!shouldReduceMotion && (
        <span
          aria-hidden="true"
          className="absolute inset-0 -z-0 w-full h-full pointer-events-none overflow-hidden rounded-full"
        >
          <span className="absolute top-0 left-0 w-3/4 h-full bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer-sweep pointer-events-none" />
        </span>
      )}
      <span className="relative z-10 pointer-events-none">{children}</span>
    </motion.button>
  );
};
