import React, { useEffect, useState } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
import { Plane } from 'lucide-react';
import { useLenis } from '../context/LenisContext';

const STAGES = [
  { name: 'Start', target: 'top', progressThreshold: 0.15 },
  { name: 'Causes', target: 'causes', progressThreshold: 0.4 },
  { name: 'Predict', target: 'predictor', progressThreshold: 0.7 },
  { name: 'Method', target: 'method', progressThreshold: 0.95 },
];

export const FlightPathProgress: React.FC = () => {
  const { scrollYProgress } = useScroll();
  const { scrollTo } = useLenis();
  const [activeStage, setActiveStage] = useState('Start');

  // Height of fill from 0 to 100%
  const fillHeight = useTransform(scrollYProgress, [0, 1], ['0%', '100%']);
  const planeTop = useTransform(scrollYProgress, [0, 1], ['0%', '100%']);

  useEffect(() => {
    return scrollYProgress.on('change', (val) => {
      if (val < 0.22) {
        setActiveStage('Start');
      } else if (val < 0.5) {
        setActiveStage('Causes');
      } else if (val < 0.78) {
        setActiveStage('Predict');
      } else {
        setActiveStage('Method');
      }
    });
  }, [scrollYProgress]);

  const handleStageClick = (target: string) => {
    if (target === 'top') {
      scrollTo(0, { offset: 0, duration: 1.6 });
    } else {
      scrollTo(`#${target}`, { offset: 0, duration: 1.6 });
    }
  };

  return (
    <div
      aria-hidden="true"
      className="hidden md:flex fixed right-6 top-1/2 -translate-y-1/2 z-40 items-center gap-4 select-none pointer-events-none"
    >
      {/* Tiny uppercase labels beside the flight path */}
      <div className="flex flex-col justify-between h-[40vh] py-1 text-right pointer-events-none">
        {STAGES.map((stage) => {
          const isActive = activeStage === stage.name;
          return (
            <button
              key={stage.name}
              type="button"
              onClick={() => handleStageClick(stage.target)}
              className={`text-[10px] uppercase tracking-[0.2em] font-light transition-colors duration-300 cursor-pointer pointer-events-auto ${
                isActive ? 'text-white font-normal' : 'text-white/40 hover:text-white/70'
              }`}
            >
              {stage.name}
            </button>
          );
        })}
      </div>

      {/* 40vh 1px Vertical Track Line */}
      <div className="relative w-[1px] h-[40vh] bg-white/15 pointer-events-none">
        {/* Growing white/80 fill */}
        <motion.div
          style={{ height: fillHeight }}
          className="w-full bg-white/80 origin-top"
        />

        {/* Tiny plane icon riding the end of the fill */}
        <motion.div
          style={{ top: planeTop }}
          className="absolute -left-[6.5px] -translate-y-1/2 pointer-events-none"
        >
          <Plane
            size={14}
            className="text-white transform rotate-180 drop-shadow-[0_0_6px_rgba(255,255,255,0.7)]"
          />
        </motion.div>
      </div>
    </div>
  );
};
