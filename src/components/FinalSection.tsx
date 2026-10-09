import React, { useRef } from 'react';
import {
  motion,
  useScroll,
  useTransform,
  useReducedMotion,
  MotionValue,
} from 'framer-motion';
import { Plane } from 'lucide-react';
import { useLenis } from '../context/LenisContext';
import { useVideoVisibility } from '../hooks/useVideoVisibility';

const FINAL_VIDEO_URL = '/videos/airplane-dusk.mp4';
const FINAL_VIDEO_WEBM = '/videos/airplane-dusk.webm';

const HEADING_WORDS = ['Fewer', 'surprises', 'at', 'the', 'gate.'];

interface WordSpanProps {
  word: string;
  index: number;
  progress: MotionValue<number>;
  shouldReduceMotion: boolean | null;
}

const WordSpan: React.FC<WordSpanProps> = ({
  word,
  index,
  progress,
  shouldReduceMotion,
}) => {
  const start = 0.25 + index * 0.035;
  const end = start + 0.06;
  const y = useTransform(progress, [start, end], [40, 0]);
  const opacity = useTransform(progress, [start, end], [0, 1]);

  return (
    <span className="overflow-hidden inline-block mr-[0.25em] last:mr-0 py-1">
      <motion.span
        style={{
          y: shouldReduceMotion ? 0 : y,
          opacity: shouldReduceMotion ? 1 : opacity,
        }}
        className="inline-block [will-change:transform,opacity]"
      >
        {word}
      </motion.span>
    </span>
  );
};

export const FinalSection: React.FC = () => {
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const { scrollTo } = useLenis();

  // Pause video when fully off-screen & enforce slower 0.7 playbackRate
  useVideoVisibility(videoRef, 0.7);

  // Section scroll tracking for clip-path and video scale reveal across h-[300vh]
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start end', 'end start'],
  });

  // Entry reveal: clip-path animates inset(10% 8% round 40px) to inset(0% 0% round 0px) over first 25%, then stays full-screen
  const clipPathVal = useTransform(
    scrollYProgress,
    [0, 0.25, 1],
    ['inset(10% 8% round 40px)', 'inset(0% 0% round 0px)', 'inset(0% 0% round 0px)']
  );

  // Video scales 1.2 to 1.0 over first 25%, and last 15% scales to 1.08
  const videoScale = useTransform(
    scrollYProgress,
    [0, 0.25, 0.85, 1.0],
    [1.2, 1.0, 1.0, 1.08]
  );

  // 45-60%: Button fades in with pulsing glow
  const buttonY = useTransform(scrollYProgress, [0.45, 0.58], [16, 0]);
  const buttonOpacity = useTransform(scrollYProgress, [0.45, 0.58], [0, 1]);

  // 50-90%: SVG flight path arc draws itself with pathLength tied to scroll
  const arcPathLength = useTransform(scrollYProgress, [0.5, 0.88], [0, 1]);
  const planeX = useTransform(scrollYProgress, [0.5, 0.88], ['5%', '95%']);
  const planeY = useTransform(
    scrollYProgress,
    [0.5, 0.69, 0.88],
    ['70%', '18%', '65%']
  );
  const planeOpacity = useTransform(
    scrollYProgress,
    [0.49, 0.53, 0.88, 0.95],
    [0, 1, 1, 0.4]
  );

  // City labels ("Departure", "Arrival") appear at each end (50-58%)
  const cityLabelsOpacity = useTransform(scrollYProgress, [0.5, 0.58], [0, 1]);

  // 80-95%: Footer links and credit sit inside sticky layer at bottom and fade in
  const footerOpacity = useTransform(scrollYProgress, [0.8, 0.94], [0, 1]);

  return (
    <section
      id="data"
      ref={sectionRef}
      className={`relative w-full bg-[#010101] border-t border-white/5 select-none ${
        shouldReduceMotion ? 'min-h-screen pb-16' : 'h-[300vh]'
      }`}
    >
      {/* Sticky top-0 h-screen inner wrapper with clip-path reveal */}
      <motion.div
        style={{
          clipPath: shouldReduceMotion ? 'none' : clipPathVal,
        }}
        className={`${
          shouldReduceMotion
            ? 'relative w-full min-h-screen flex flex-col justify-center items-center px-6 sm:px-8'
            : 'sticky top-0 h-screen w-full flex flex-col justify-center items-center px-6 sm:px-8 overflow-hidden'
        } [will-change:clip-path]`}
      >
        {/* Background Video fills sticky layer at 100vw x 100vh */}
        <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none">
          <motion.div
            style={{ scale: shouldReduceMotion ? 1 : videoScale }}
            className="w-full h-full origin-center [will-change:transform]"
          >
            <video
              ref={videoRef}
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              className="w-full h-full object-cover object-center"
            >
              <source src={FINAL_VIDEO_URL} type="video/mp4" />
              <source src={FINAL_VIDEO_WEBM} type="video/webm" />
            </video>
          </motion.div>

          {/* Dark overlay */}
          <div className="absolute inset-0 bg-black/60" />

          {/* 300px Top gradient fade */}
          <div className="absolute top-0 inset-x-0 h-[300px] bg-gradient-to-b from-[#010101] to-transparent pointer-events-none z-10" />
        </div>

        {/* Center Call to Action */}
        <div className="relative z-10 flex flex-col items-center text-center max-w-4xl px-4 my-auto">
          {/* Heading: Words rise one by one at 25-45% */}
          <h2 className="font-serif-display text-5xl sm:text-7xl text-white font-normal tracking-tight mb-10 leading-[1.08] flex flex-wrap justify-center">
            {HEADING_WORDS.map((word, i) => (
              <WordSpan
                key={word}
                word={word}
                index={i}
                progress={scrollYProgress}
                shouldReduceMotion={shouldReduceMotion}
              />
            ))}
          </h2>

          {/* Button with soft pulsing glow, fades in at 45-60% */}
          <motion.div
            style={{
              y: shouldReduceMotion ? 0 : buttonY,
              opacity: shouldReduceMotion ? 1 : buttonOpacity,
            }}
            className="[will-change:transform,opacity]"
          >
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="liquid-glass rounded-full px-10 py-4 text-white/90 uppercase tracking-[0.2em] text-xs font-light hover:text-white transition-all cursor-pointer inline-flex items-center justify-center !bg-white/[0.06] animate-pulse-glow"
            >
              View the Project on GitHub
            </a>
          </motion.div>
        </div>

        {/* SVG Flight Path Arc Crossing the Lower Third (50-90%) */}
        <div className="absolute bottom-28 inset-x-0 w-full max-w-5xl mx-auto h-32 pointer-events-none px-6 z-10">
          <div className="relative w-full h-full">
            {/* City labels: Departure & Arrival */}
            <motion.div
              style={{
                opacity: shouldReduceMotion ? 1 : cityLabelsOpacity,
              }}
              className="absolute inset-x-2 -top-2 flex justify-between items-center text-[10px] sm:text-xs uppercase tracking-[0.25em] text-white/50 select-none [will-change:opacity]"
            >
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-white/60 inline-block" />
                Departure
              </span>
              <span className="flex items-center gap-1.5">
                Arrival
                <span className="w-1.5 h-1.5 rounded-full bg-white/60 inline-block" />
              </span>
            </motion.div>

            <svg viewBox="0 0 1000 120" className="w-full h-full overflow-visible">
              <motion.path
                d="M 20,90 Q 500,10 980,85"
                fill="none"
                stroke="rgba(255, 255, 255, 0.3)"
                strokeWidth="1.5"
                strokeDasharray="4 4"
                style={{
                  pathLength: shouldReduceMotion ? 1 : arcPathLength,
                }}
                className="[will-change:transform]"
              />
            </svg>

            {/* Plane following the arc tip */}
            {!shouldReduceMotion && (
              <motion.div
                style={{
                  left: planeX,
                  top: planeY,
                  opacity: planeOpacity,
                }}
                className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none [will-change:transform,opacity]"
              >
                <Plane
                  size={14}
                  className="text-white transform rotate-45 drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]"
                />
              </motion.div>
            )}
          </div>
        </div>

        {/* Footer links: pinned absolute bottom-10, fades in at 80-95% */}
        <motion.footer
          style={{
            opacity: shouldReduceMotion ? 1 : footerOpacity,
          }}
          className="absolute bottom-10 inset-x-0 z-20 flex items-center justify-center gap-8 text-xs uppercase tracking-[0.2em] font-light text-white/50 text-center px-6 [will-change:opacity]"
        >
          <a
            href="#data"
            onClick={(e) => {
              e.preventDefault();
              scrollTo('#data', { offset: 0, duration: 1.6 });
            }}
            className="hover:text-white transition-colors duration-200"
          >
            Data
          </a>
          <a
            href="#method"
            onClick={(e) => {
              e.preventDefault();
              scrollTo('#method', { offset: 0, duration: 1.6 });
            }}
            className="hover:text-white transition-colors duration-200"
          >
            Method
          </a>
          <a
            href="mailto:contact@holdingpattern.aero"
            className="hover:text-white transition-colors duration-200"
          >
            Contact
          </a>
        </motion.footer>

        {/* One-line data-source credit: pinned absolute bottom-5, fades in at 80-95% */}
        <motion.p
          style={{
            opacity: shouldReduceMotion ? 1 : footerOpacity,
          }}
          className="absolute bottom-5 inset-x-0 z-20 text-white/40 text-xs font-light tracking-wide text-center px-6 max-w-3xl mx-auto truncate [will-change:opacity]"
        >
          Data sourced from U.S. Bureau of Transportation Statistics, FAA National Airspace System, and NOAA Aviation Weather Center.
        </motion.p>
      </motion.div>
    </section>
  );
};
