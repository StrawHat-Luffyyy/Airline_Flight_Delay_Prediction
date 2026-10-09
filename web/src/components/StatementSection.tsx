import React, { useRef, useState } from 'react';
import { motion, useScroll, useTransform, useReducedMotion, MotionValue } from 'framer-motion';

const STATEMENT_TEXT = "Every delay has a cause. We read millions of past flights to find it.";
const WORDS = STATEMENT_TEXT.split(' ');

interface WordProps {
  word: string;
  range: [number, number];
  progress: MotionValue<number>;
  shouldReduceMotion: boolean | null;
}

const Word: React.FC<WordProps> = ({ word, range, progress, shouldReduceMotion }) => {
  // Opacity 0.2 to 1 and blur 2px to 0 over word range
  const opacity = useTransform(progress, range, [0.2, 1]);
  const blurVal = useTransform(progress, range, [2, 0]);
  const filter = useTransform(blurVal, (b) =>
    shouldReduceMotion ? 'none' : `blur(${Math.max(0, b)}px)`
  );

  return (
    <motion.span
      style={{
        opacity: shouldReduceMotion ? 1 : opacity,
        filter: shouldReduceMotion ? 'none' : filter,
      }}
      className="inline-block mr-[0.25em] select-none [will-change:opacity,filter]"
    >
      {word}
    </motion.span>
  );
};

const CAUSES = [
  {
    number: '01',
    title: 'Weather',
    description: 'Convective storm lines, low ceilings, and ground stops rippling through flight corridors.',
  },
  {
    number: '02',
    title: 'Late-arriving aircraft',
    description: 'Upstream turnaround delays compounding from previous legs across the network.',
  },
  {
    number: '03',
    title: 'Airline operations',
    description: 'Crew rest duty thresholds, gate turn bottlenecks, and scheduled apron logistics.',
  },
];

export const StatementSection: React.FC = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);

  // Scroll tracking across the h-[300vh] section
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end end'],
  });

  const totalWords = WORDS.length;
  const wordStep = 0.45 / totalWords;

  // From 45% to 80%: statement moves up 60px and dims to 0.5 opacity (holds 80% to 100%)
  const statementY = useTransform(scrollYProgress, [0.45, 0.80], [0, -60]);
  const statementOpacity = useTransform(scrollYProgress, [0.45, 0.80], [1, 0.5]);

  // Three cause columns rise in beneath it from 45% to 80% (holds 80% to 100%)
  const col0Opacity = useTransform(scrollYProgress, [0.45, 0.68], [0, 1]);
  const col0Y = useTransform(scrollYProgress, [0.45, 0.68], [40, 0]);

  const col1Opacity = useTransform(scrollYProgress, [0.50, 0.73], [0, 1]);
  const col1Y = useTransform(scrollYProgress, [0.50, 0.73], [40, 0]);

  const col2Opacity = useTransform(scrollYProgress, [0.55, 0.78], [0, 1]);
  const col2Y = useTransform(scrollYProgress, [0.55, 0.78], [40, 0]);

  // Dividers draw top to bottom
  const dividerScaleY = useTransform(scrollYProgress, [0.48, 0.78], [0, 1]);

  const columnMotions = [
    { opacity: col0Opacity, y: col0Y },
    { opacity: col1Opacity, y: col1Y },
    { opacity: col2Opacity, y: col2Y },
  ];

  return (
    <section
      id="causes"
      ref={sectionRef}
      className={`relative h-[300vh] bg-[#010101] text-white select-none ${
        shouldReduceMotion ? '!h-auto py-32' : ''
      }`}
    >
      {/* Sticky top-0 h-screen inner wrapper */}
      <div
        className={`${
          shouldReduceMotion
            ? 'relative w-full flex flex-col items-center justify-center'
            : 'sticky top-0 h-screen w-full flex flex-col items-center justify-center'
        } px-6 overflow-hidden`}
      >
        {/* Background Visual Fill: Faint Radial Vignette + 5 Drifting Curved Flight Route Lines */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
          {/* Faint radial vignette */}
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,_rgba(255,255,255,0.025)_0%,_transparent_65%)]" />

          {/* 5 very faint (white/[0.06]) curved SVG flight-route lines slowly drifting horizontally (40s loop) */}
          {!shouldReduceMotion && (
            <motion.div
              animate={{ x: ['-15%', '5%', '-15%'] }}
              transition={{ duration: 40, repeat: Infinity, ease: 'linear' }}
              className="absolute -inset-x-20 inset-y-0 w-[140%] h-full flex items-center justify-center opacity-80"
            >
              <svg
                viewBox="0 0 1600 800"
                className="w-full h-full stroke-white/[0.06] fill-none"
                strokeWidth="1.2"
              >
                <path d="M -100,140 Q 450,300 1150,110 T 1800,180" strokeDasharray="6 6" />
                <path d="M -60,280 Q 550,120 1250,340 T 1760,240" strokeDasharray="4 8" />
                <path d="M -90,460 Q 380,620 1080,430 T 1860,540" strokeDasharray="8 6" />
                <path d="M -40,590 Q 720,440 1380,650 T 1840,610" strokeDasharray="5 7" />
                <path d="M -110,730 Q 420,570 1220,760 T 1790,700" strokeDasharray="7 5" />
              </svg>
            </motion.div>
          )}
        </div>

        {/* Content Container */}
        <div className="relative z-10 w-full max-w-5xl mx-auto flex flex-col items-center justify-center">
          {/* Statement: Words light up over first 45%, then moves up 60px and dims to 0.5 opacity */}
          <motion.h2
            style={{
              y: shouldReduceMotion ? 0 : statementY,
              opacity: shouldReduceMotion ? 1 : statementOpacity,
            }}
            className="font-serif-display text-3xl sm:text-5xl md:text-6xl text-white max-w-4xl text-center leading-tight [will-change:transform,opacity]"
          >
            {WORDS.map((word, i) => {
              const start = i * wordStep;
              const end = Math.min(0.45, (i + 1) * wordStep);
              return (
                <Word
                  key={`${word}-${i}`}
                  word={word}
                  range={[start, end]}
                  progress={scrollYProgress}
                  shouldReduceMotion={shouldReduceMotion}
                />
              );
            })}
          </motion.h2>

          {/* Three Cause Columns: Rise in beneath it from 45% to 80%, hold 80% to 100% */}
          <div className="w-full mt-14 sm:mt-18 grid grid-cols-1 md:grid-cols-3 gap-y-10">
            {CAUSES.map((cause, index) => {
              const hasDivider = index > 0;
              const isHovered = hoveredColumn === index;
              const isAnyHovered = hoveredColumn !== null;
              const motionProps = columnMotions[index];

              return (
                <motion.div
                  key={cause.number}
                  style={{
                    opacity: shouldReduceMotion ? 1 : motionProps.opacity,
                    y: shouldReduceMotion ? 0 : motionProps.y,
                  }}
                  onMouseEnter={() => setHoveredColumn(index)}
                  onMouseLeave={() => setHoveredColumn(null)}
                  className={`relative px-6 md:px-10 py-4 flex flex-col transition-opacity duration-300 cursor-default [will-change:transform,opacity] ${
                    isAnyHovered
                      ? isHovered
                        ? '!opacity-100'
                        : '!opacity-40'
                      : ''
                  }`}
                >
                  {/* Divider draws top-to-bottom (scaleY 0 to 1) */}
                  {hasDivider && (
                    <motion.div
                      style={{
                        scaleY: shouldReduceMotion ? 1 : dividerScaleY,
                      }}
                      className="hidden md:block absolute left-0 top-0 bottom-0 w-[1px] bg-white/10 origin-top [will-change:transform]"
                    />
                  )}

                  {/* Big Serif Number: shifts to white and slides up 6px on hover */}
                  <span
                    className={`font-serif-display text-5xl font-normal mb-6 select-none transition-all duration-300 transform ${
                      isHovered
                        ? 'text-white -translate-y-[6px]'
                        : 'text-white/30 translate-y-0'
                    }`}
                  >
                    {cause.number}
                  </span>

                  {/* Title in uppercase tracking 0.2em */}
                  <h3 className="text-white/90 uppercase tracking-[0.2em] text-xs sm:text-sm font-normal mb-3">
                    {cause.title}
                  </h3>

                  {/* One line of white/60 font-light text */}
                  <p className="text-white/60 text-xs sm:text-sm font-light leading-relaxed">
                    {cause.description}
                  </p>
                </motion.div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};
