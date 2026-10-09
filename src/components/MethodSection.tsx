import React, { useRef } from 'react';
import { motion, useScroll, useTransform, useReducedMotion, MotionValue } from 'framer-motion';

const STEPS = [
  {
    number: '01',
    title: 'Collect',
    description: 'Ingesting historical flight segments, transponder positions, and national airspace ground advisories.',
    threshold: 0.15,
  },
  {
    number: '02',
    title: 'Clean',
    description: 'Filtering turnaround anomalies, tail reassignment swaps, and reporting timestamp discrepancies.',
    threshold: 0.40,
  },
  {
    number: '03',
    title: 'Learn',
    description: 'Modeling downstream turnaround propagation and airport gate queue saturation under stress.',
    threshold: 0.65,
  },
  {
    number: '04',
    title: 'Explain',
    description: 'Isolating the primary causal drivers behind every projected departure schedule deviation.',
    threshold: 0.90,
  },
];

interface StepProps {
  step: (typeof STEPS)[0];
  progress: MotionValue<number>;
  shouldReduceMotion: boolean | null;
}

const MethodStep: React.FC<StepProps> = ({ step, progress, shouldReduceMotion }) => {
  // Lighting up as fill reaches step threshold
  const numColor = useTransform(
    progress,
    [step.threshold - 0.1, step.threshold],
    ['rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 1)']
  );

  const textOpacity = useTransform(
    progress,
    [step.threshold - 0.1, step.threshold],
    [0.3, 1]
  );

  const textY = useTransform(
    progress,
    [step.threshold - 0.1, step.threshold],
    [8, 0]
  );

  const dotGlow = useTransform(
    progress,
    [step.threshold - 0.05, step.threshold],
    ['rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 1)']
  );

  // Title letter-spaces from 0.2em to 0.3em when active
  const letterSpacing = useTransform(
    progress,
    [step.threshold - 0.1, step.threshold],
    ['0.2em', '0.3em']
  );

  // Faint white/[0.04] vertical beam sweeping down behind it
  const beamScaleY = useTransform(
    progress,
    [step.threshold - 0.12, step.threshold + 0.05],
    [0, 1]
  );
  const beamOpacity = useTransform(
    progress,
    [step.threshold - 0.12, step.threshold - 0.02, step.threshold + 0.2],
    [0, 1, 0.35]
  );

  return (
    <div className="relative flex flex-col pt-8">
      {/* Faint white/[0.04] vertical beam sweep */}
      <motion.div
        style={{
          scaleY: shouldReduceMotion ? 1 : beamScaleY,
          opacity: shouldReduceMotion ? 0.3 : beamOpacity,
        }}
        className="absolute -inset-x-3 -inset-y-3 bg-gradient-to-b from-white/[0.04] via-white/[0.015] to-transparent origin-top pointer-events-none rounded-xl will-change-transform"
      />

      {/* 6px dot lighting up on the horizontal track line */}
      <motion.div
        style={{
          backgroundColor: shouldReduceMotion ? 'white' : dotGlow,
          boxShadow: shouldReduceMotion
            ? 'none'
            : '0 0 8px rgba(255,255,255,0.8)',
        }}
        className="absolute -top-[3.5px] left-0 w-[6px] h-[6px] rounded-full [will-change:background-color]"
      />

      {/* Number transitioning from white/20 to white */}
      <motion.span
        style={{
          color: shouldReduceMotion ? 'white' : numColor,
        }}
        className="font-serif-display text-4xl sm:text-5xl font-normal mb-4 select-none [will-change:color]"
      >
        {step.number}
      </motion.span>

      {/* Title & Description rising from opacity 0.3 to 1 */}
      <motion.div
        style={{
          opacity: shouldReduceMotion ? 1 : textOpacity,
          y: shouldReduceMotion ? 0 : textY,
        }}
        className="[will-change:opacity,transform]"
      >
        <motion.h3
          style={{
            letterSpacing: shouldReduceMotion ? '0.25em' : letterSpacing,
          }}
          className="text-white/90 uppercase text-xs sm:text-sm font-normal mb-2.5 transition-all [will-change:letter-spacing]"
        >
          {step.title}
        </motion.h3>
        <p className="text-white/60 text-xs sm:text-sm font-light leading-relaxed">
          {step.description}
        </p>
      </motion.div>
    </div>
  );
};

export const MethodSection: React.FC = () => {
  const sectionRef = useRef<HTMLElement>(null);
  const shouldReduceMotion = useReducedMotion();

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start 0.8', 'end 0.5'],
  });

  const lineScaleX = useTransform(scrollYProgress, [0.05, 0.95], [0, 1]);

  return (
    <section
      id="method"
      ref={sectionRef}
      className="relative w-full py-32 sm:py-40 px-6 sm:px-8 bg-[#010101] text-white border-t border-white/5 select-none"
    >
      {/* 300px Top & bottom matching transition fades */}
      <div className="absolute top-0 inset-x-0 h-[300px] bg-gradient-to-b from-[#010101] to-transparent pointer-events-none" />
      <div className="absolute bottom-0 inset-x-0 h-[300px] bg-gradient-to-t from-[#010101] to-transparent pointer-events-none" />

      <div className="max-w-5xl mx-auto flex flex-col items-center">
        {/* Serif Heading: Centered */}
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="font-serif-display text-4xl sm:text-5xl md:text-6xl text-white font-normal tracking-tight text-center max-w-3xl mb-16 leading-tight"
        >
          From raw flight logs to a delay forecast.
        </motion.h2>

        {/* Four Column Container with Horizontal Line across top */}
        <div className="relative w-full">
          {/* 1px white/15 track line */}
          <div className="w-full h-[1px] bg-white/15 relative overflow-hidden">
            {/* White/80 fill that grows left to right with scroll progress */}
            <motion.div
              style={{
                scaleX: shouldReduceMotion ? 1 : lineScaleX,
              }}
              className="w-full h-full bg-white/80 origin-left [will-change:transform]"
            />
          </div>

          {/* Four columns */}
          <div className="w-full grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-12">
            {STEPS.map((step) => (
              <MethodStep
                key={step.number}
                step={step}
                progress={scrollYProgress}
                shouldReduceMotion={shouldReduceMotion}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
