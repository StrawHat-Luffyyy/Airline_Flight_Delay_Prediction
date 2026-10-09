import React, { useRef } from 'react';
import { motion, useInView } from 'framer-motion';

interface StaggeredFadeProps {
  text: string;
  className?: string;
  delayOffset?: number;
}

export const StaggeredFade: React.FC<StaggeredFadeProps> = ({
  text,
  className = '',
  delayOffset = 0,
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });

  const characters = Array.from(text);

  return (
    <span ref={ref} className={`inline-block ${className}`}>
      {characters.map((char, i) => (
        <motion.span
          key={`${char}-${i}`}
          initial="hidden"
          animate={isInView ? 'show' : 'hidden'}
          variants={{
            hidden: { opacity: 0, y: 12 },
            show: {
              opacity: 1,
              y: 0,
              transition: {
                duration: 0.4,
                delay: delayOffset + i * 0.05,
                ease: [0.22, 1, 0.36, 1],
              },
            },
          }}
          className="inline-block"
        >
          {char === ' ' ? '\u00A0' : char}
        </motion.span>
      ))}
    </span>
  );
};
