import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLenis } from '../context/LenisContext';

interface PageLoaderProps {
  onComplete: () => void;
}

export const PageLoader: React.FC<PageLoaderProps> = ({ onComplete }) => {
  const [isVisible, setIsVisible] = useState(true);
  const [isExiting, setIsExiting] = useState(false);
  const { lockScroll } = useLenis();

  // Guard against StrictMode double-invocation and re-render cycles
  const hasStartedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const lockScrollRef = useRef(lockScroll);
  lockScrollRef.current = lockScroll;

  useEffect(() => {
    if (hasStartedRef.current) {
      console.log('[PageLoader] Skipped duplicate execution');
      return;
    }
    hasStartedRef.current = true;

    console.log('[PageLoader] State: active (lock scroll)');
    lockScrollRef.current(true);

    // At 2.2s start exit animation
    const exitTimer = setTimeout(() => {
      console.log('[PageLoader] State: exiting (unlock scroll)');
      setIsExiting(true);
      lockScrollRef.current(false);
    }, 2200);

    // After 2.2s + 0.9s = 3.1s, unmount loader and trigger hero entrance exactly once
    const completeTimer = setTimeout(() => {
      console.log('[PageLoader] State: complete (unmount)');
      setIsVisible(false);
      onCompleteRef.current();
    }, 3100);

    return () => {
      clearTimeout(exitTimer);
      clearTimeout(completeTimer);
      lockScrollRef.current(false);
    };
  }, []);

  const brandLetters = Array.from('HOLDING PATTERN');

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ y: 0 }}
          animate={{ y: isExiting ? '-100%' : 0 }}
          transition={{ duration: 0.9, ease: [0.76, 0, 0.24, 1] }}
          className={`fixed inset-0 z-[100] bg-[#010101] flex flex-col items-center justify-center select-none ${
            isExiting ? 'pointer-events-none' : 'pointer-events-auto'
          }`}
        >
          {/* Brand Name with 0.04s stagger */}
          <div className="flex items-center justify-center text-white uppercase tracking-[0.3em] font-light text-sm sm:text-base">
            {brandLetters.map((char, i) => (
              <motion.span
                key={i}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.15 + i * 0.04, ease: 'easeOut' }}
                className="inline-block"
              >
                {char === ' ' ? '\u00A0' : char}
              </motion.span>
            ))}
          </div>

          {/* 1px x 160px line with white/80 fill scaling 0 to 100% over 1.6s */}
          <div className="w-[160px] h-[1px] bg-white/20 mt-6 relative overflow-hidden">
            <motion.div
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 1.6, delay: 0.35, ease: [0.25, 1, 0.5, 1] }}
              className="w-full h-full bg-white/80 origin-left"
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
