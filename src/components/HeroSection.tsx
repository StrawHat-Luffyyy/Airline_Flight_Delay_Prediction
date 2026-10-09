import React, { useRef, useEffect } from 'react';
import { motion, useScroll, useTransform, useReducedMotion } from 'framer-motion';
import { MagneticButton } from './MagneticButton';
import { useLenis } from '../context/LenisContext';
import { useVideoVisibility } from '../hooks/useVideoVisibility';

const VIDEO_URL = '/videos/airplane-dusk.mp4';
const VIDEO_FALLBACK_WEBM = '/videos/airplane-dusk.webm';
const POSTER_URL = '/videos/airplane-dusk-poster.jpg';

interface HeroSectionProps {
  isReady?: boolean;
}

export const HeroSection: React.FC<HeroSectionProps> = ({ isReady = true }) => {
  const heroRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const { scrollTo } = useLenis();

  useEffect(() => {
    console.log('[HeroSection] isReady state changed:', isReady);
  }, [isReady]);

  // Pause video when fully off-screen & enforce slower 0.7 playbackRate
  useVideoVisibility(videoRef, 0.7);

  // Scroll tracking across the pinned h-[250vh] range
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ['start start', 'end end'],
  });

  // 0-30%: video zooms 1.0 to 1.15. Last 15% (85-100%): scales to 1.08 exit
  const videoScale = useTransform(
    scrollYProgress,
    [0, 0.3, 0.85, 1.0],
    [1.0, 1.15, 1.15, 1.08]
  );

  // Parallax subtle drift
  const videoY = useTransform(scrollYProgress, [0, 1], ['0%', '6%']);

  // CTA, subtitle, eyebrow, and scroll hint: visible only during 0-30%
  const initialElementsOpacity = useTransform(scrollYProgress, [0, 0.22, 0.3], [1, 1, 0]);
  const initialPointerEvents = useTransform(scrollYProgress, (v) => (v > 0.25 ? 'none' : 'auto'));

  // 30-60%: Headline lines slide apart
  // Line 1 moves up -12vh, Line 2 moves down +12vh
  const line1Y = useTransform(scrollYProgress, [0.3, 0.58], ['0vh', '-12vh']);
  const line2Y = useTransform(scrollYProgress, [0.3, 0.58], ['0vh', '12vh']);

  // Headline fades to 0 and blurs to 6px
  const headlineOpacity = useTransform(scrollYProgress, [0.3, 0.52], [1, 0]);
  const headlineBlurVal = useTransform(scrollYProgress, [0.3, 0.52], [0, 6]);
  const headlineFilter = useTransform(
    headlineBlurVal,
    (b) => `blur(${Math.max(0, b)}px)`
  );

  // 35-65%: Centered serif line "Millions of flights. One forecast." masked line reveal
  const serifLineY = useTransform(scrollYProgress, [0.35, 0.48], ['100%', '0%']);
  const serifLineOpacity = useTransform(
    scrollYProgress,
    [0.35, 0.46, 0.58, 0.68],
    [0, 1, 1, 0]
  );

  // 65-100%: Black overlay fades in to opacity 1 for smooth cut to black (strictly 0 at scroll 0)
  const blackOverlayOpacity = useTransform(scrollYProgress, [0.65, 0.95], [0, 1]);

  const line1Chars = Array.from('SEE THE DELAY');
  const line2Chars = Array.from('BEFORE IT HAPPENS');

  return (
    <section
      ref={heroRef}
      id="top"
      className={`relative w-full bg-[#0a0d14] select-none ${
        shouldReduceMotion ? 'min-h-screen' : 'h-[250vh]'
      }`}
    >
      {/* Sticky top-0 h-screen pinned viewport */}
      <div
        className={`${
          shouldReduceMotion
            ? 'relative w-full min-h-screen flex flex-col justify-center items-center'
            : 'sticky top-0 h-screen w-full overflow-hidden flex flex-col justify-center items-center'
        }`}
      >
        {/* Full-screen Background Video (100vw x 100vh) */}
        <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none bg-[#0a0d14]">
          <motion.div
            style={{
              scale: shouldReduceMotion ? 1 : videoScale,
              y: shouldReduceMotion ? '0%' : videoY,
            }}
            className="w-full h-full origin-center [will-change:transform]"
          >
            <video
              ref={videoRef}
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              poster={POSTER_URL}
              className="w-full h-full object-cover object-center"
            >
              <source src={VIDEO_URL} type="video/mp4" />
              <source src={VIDEO_FALLBACK_WEBM} type="video/webm" />
            </video>
          </motion.div>

          {/* Base cinematic dark scrim */}
          <div className="absolute inset-0 bg-black/35" />

          {/* Radial depth vignette */}
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,_rgba(0,0,0,0.2)_0%,_rgba(0,0,0,0.75)_100%)]" />

          {/* Exit Black Overlay (strictly 0 at scroll 0, fades to 1 at 65-95%) */}
          <motion.div
            style={{ opacity: shouldReduceMotion ? 0 : blackOverlayOpacity }}
            className="absolute inset-0 bg-[#010101] pointer-events-none [will-change:opacity]"
          />

          {/* 300px Bottom gradient to smoothly transition to next section */}
          <div className="absolute bottom-0 inset-x-0 h-[300px] bg-gradient-to-b from-transparent to-[#010101] pointer-events-none" />
        </div>

        {/* Hero Content Wrapper: Vertically and Horizontally Centered */}
        <div className="relative z-10 w-full h-full flex flex-col items-center justify-center text-center px-5 sm:px-8 max-w-5xl mx-auto">
          {/* Eyebrow: visible 0-30% */}
          <motion.p
            style={{
              opacity: shouldReduceMotion ? 1 : initialElementsOpacity,
            }}
            initial={{ opacity: 0, y: 16 }}
            animate={isReady ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
            transition={{ duration: 0.8, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="text-white/60 text-xs uppercase tracking-[0.3em] font-light mb-6 [will-change:opacity]"
          >
            AIRLINE FLIGHT DELAY PREDICTION
          </motion.p>

          {/* Split Sliding Headline */}
          <motion.h1
            style={{
              opacity: shouldReduceMotion ? 1 : headlineOpacity,
              filter: shouldReduceMotion ? 'none' : headlineFilter,
            }}
            className="font-serif-display font-normal text-white text-4xl sm:text-6xl md:text-8xl lg:text-9xl leading-[1.08] tracking-tight mb-8 relative [will-change:transform,opacity,filter]"
          >
            {/* Line 1: SEE THE DELAY (moves up -12vh during 30-60%) */}
            <motion.span
              style={{
                y: shouldReduceMotion ? '0vh' : line1Y,
              }}
              className="block overflow-hidden py-1 [will-change:transform]"
            >
              <motion.span
                initial={{ y: '110%' }}
                animate={isReady ? { y: 0 } : { y: '110%' }}
                transition={{
                  duration: 1.1,
                  delay: 0.1,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className="inline-block"
              >
                {line1Chars.map((char, i) => (
                  <motion.span
                    key={i}
                    initial={{ filter: 'blur(8px)' }}
                    animate={isReady ? { filter: 'blur(0px)' } : { filter: 'blur(8px)' }}
                    transition={{
                      duration: 0.6,
                      delay: 0.15 + i * 0.02,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                    className="inline-block"
                  >
                    {char === ' ' ? '\u00A0' : char}
                  </motion.span>
                ))}
              </motion.span>
            </motion.span>

            {/* Line 2: BEFORE IT HAPPENS (moves down +12vh during 30-60%) */}
            <motion.span
              style={{
                y: shouldReduceMotion ? '0vh' : line2Y,
              }}
              className="block overflow-hidden py-1 [will-change:transform]"
            >
              <motion.span
                initial={{ y: '110%' }}
                animate={isReady ? { y: 0 } : { y: '110%' }}
                transition={{
                  duration: 1.1,
                  delay: 0.22,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className="inline-block"
              >
                {line2Chars.map((char, i) => (
                  <motion.span
                    key={i}
                    initial={{ filter: 'blur(8px)' }}
                    animate={isReady ? { filter: 'blur(0px)' } : { filter: 'blur(8px)' }}
                    transition={{
                      duration: 0.6,
                      delay: 0.25 + i * 0.02,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                    className="inline-block"
                  >
                    {char === ' ' ? '\u00A0' : char}
                  </motion.span>
                ))}
              </motion.span>
            </motion.span>
          </motion.h1>

          {/* Subtitle: visible 0-30% */}
          <motion.p
            style={{
              opacity: shouldReduceMotion ? 1 : initialElementsOpacity,
            }}
            initial={{ opacity: 0, y: 20 }}
            animate={isReady ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            transition={{ duration: 0.9, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="text-white/70 font-light leading-relaxed max-w-xs sm:max-w-md text-sm sm:text-base md:text-lg mb-10 mx-auto [will-change:opacity]"
          >
            Millions of historical flights, decoded to predict delays{' '}
            <br className="hidden sm:inline" />
            and reveal what truly causes them.
          </motion.p>

          {/* CTA Button: visible 0-30% */}
          <motion.div
            style={{
              opacity: shouldReduceMotion ? 1 : initialElementsOpacity,
              pointerEvents: shouldReduceMotion ? 'auto' : initialPointerEvents,
            }}
            initial={{ opacity: 0, y: 20 }}
            animate={isReady ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            transition={{ duration: 0.8, delay: 0.65, ease: [0.16, 1, 0.3, 1] }}
            className="[will-change:opacity]"
          >
            <MagneticButton
              onClick={() => scrollTo('#predictor', { offset: 0, duration: 1.6 })}
            >
              Predict a Flight
            </MagneticButton>
          </motion.div>

          {/* New Centered Serif Line revealed during 30-60%: "Millions of flights. One forecast." */}
          {!shouldReduceMotion && (
            <motion.div
              style={{
                opacity: serifLineOpacity,
              }}
              className="absolute inset-0 flex items-center justify-center pointer-events-none px-6 z-20 [will-change:opacity]"
            >
              <div className="overflow-hidden py-3">
                <motion.p
                  style={{
                    y: serifLineY,
                  }}
                  className="font-serif-display italic text-3xl sm:text-5xl md:text-6xl lg:text-7xl text-white font-normal text-center tracking-tight leading-tight [will-change:transform]"
                >
                  Millions of flights. One forecast.
                </motion.p>
              </div>
            </motion.div>
          )}
        </div>

        {/* Scroll Hint: absolute bottom-8, visible 0-30% */}
        <motion.div
          style={{
            opacity: shouldReduceMotion ? 1 : initialElementsOpacity,
          }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 pointer-events-none flex flex-col items-center [will-change:opacity]"
        >
          <div className="w-[1px] h-[48px] bg-white/40 relative overflow-hidden">
            <motion.div
              animate={{ y: [-4, 48], opacity: [0, 1, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute top-0 left-[-1.5px] w-[4px] h-[8px] bg-white rounded-full shadow-[0_0_8px_rgba(255,255,255,0.9)]"
            />
          </div>
        </motion.div>
      </div>
    </section>
  );
};
