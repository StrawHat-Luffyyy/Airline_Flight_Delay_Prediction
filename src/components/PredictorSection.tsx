import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useScroll, useTransform, useReducedMotion } from 'framer-motion';
import { Plane } from 'lucide-react';
import { MagneticButton } from './MagneticButton';
import { useVideoVisibility } from '../hooks/useVideoVisibility';

// Video URL: YOUR_VIDEO_URL_2
const PREDICTOR_VIDEO_URL = '/videos/airplane-dusk.mp4';
const PREDICTOR_VIDEO_WEBM = '/videos/airplane-dusk.webm';

interface PredictionResult {
  probability: number;
  expectedDelayMinutes: number;
  topCauses: {
    label: string;
    percentage: number;
  }[];
}

// replace with real model API call
function predictFlightDelay(params: {
  airline: string;
  from: string;
  to: string;
  date: string;
  departureTime: string;
}): PredictionResult {
  const seedString = `${params.airline.trim().toLowerCase()}-${params.from.trim().toLowerCase()}-${params.to.trim().toLowerCase()}-${params.departureTime}`;
  let hash = 0;
  for (let i = 0; i < seedString.length; i++) {
    hash = (hash << 5) - hash + seedString.charCodeAt(i);
    hash |= 0;
  }
  const absHash = Math.abs(hash);

  const probability = 20 + (absHash % 65);
  const expectedDelayMinutes = Math.max(15, Math.round(probability * 0.65 + (absHash % 12)));

  const causeCatalog = [
    { label: 'Late-arriving aircraft turnaround ripple', weight: 44 },
    { label: 'Runway & terminal gate congestion', weight: 32 },
    { label: 'En-route air traffic control flow holds', weight: 24 },
    { label: 'Convective weather system corridor holds', weight: 18 },
    { label: 'Airline ground service turnaround crew', weight: 14 },
  ];

  const startIndex = absHash % 3;
  const selectedCauses = [
    causeCatalog[startIndex],
    causeCatalog[(startIndex + 1) % causeCatalog.length],
    causeCatalog[(startIndex + 2) % causeCatalog.length],
  ];

  const totalWeight = selectedCauses.reduce((acc, item) => acc + item.weight, 0);
  const topCauses = selectedCauses.map((c) => ({
    label: c.label,
    percentage: Math.round((c.weight / totalWeight) * 100),
  }));

  const sum = topCauses.reduce((acc, c) => acc + c.percentage, 0);
  if (sum !== 100 && topCauses.length > 0) {
    topCauses[0].percentage += 100 - sum;
  }

  return {
    probability,
    expectedDelayMinutes,
    topCauses,
  };
}

// Reusable Minimal Input with Center-Out Scale Border & Floating Label
interface MinimalInputProps {
  label: string;
  type?: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  required?: boolean;
}

const MinimalInput: React.FC<MinimalInputProps> = ({
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
  required = false,
}) => {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <div className="relative flex flex-col">
      <motion.label
        animate={{
          y: isFocused ? -2 : 0,
          color: isFocused ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.6)',
        }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="uppercase tracking-[0.2em] text-xs font-light block mb-2 [will-change:transform]"
      >
        {label}
      </motion.label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        placeholder={placeholder}
        required={required}
        className="w-full bg-transparent text-white text-base py-3 transition-colors placeholder:text-white/25 rounded-none focus:outline-none"
      />
      {/* Base border */}
      <div className="relative w-full h-[1px] bg-white/20 overflow-hidden">
        {/* Animated center-out active line */}
        <motion.span
          animate={{ scaleX: isFocused ? 1 : 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="absolute inset-0 bg-white origin-center [will-change:transform]"
        />
      </div>
    </div>
  );
};

const ANALYSIS_MESSAGES = [
  'Reading historical flights',
  'Checking weather patterns',
  'Tracing aircraft rotations',
];

export const PredictorSection: React.FC = () => {
  const [airline, setAirline] = useState('Delta Air Lines');
  const [from, setFrom] = useState('JFK (New York)');
  const [to, setTo] = useState('LHR (London Heathrow)');
  const [date, setDate] = useState(() => {
    const today = new Date();
    return today.toISOString().split('T')[0];
  });
  const [departureTime, setDepartureTime] = useState('18:45');

  // State machine: 'idle' | 'analyzing' | 'result'
  const [status, setStatus] = useState<'idle' | 'analyzing' | 'result'>('idle');
  const [analysisTextIndex, setAnalysisTextIndex] = useState(0);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const [displayPercentage, setDisplayPercentage] = useState(0);

  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const shouldReduceMotion = useReducedMotion();

  // Pause video when fully off-screen & enforce slower 0.7 playbackRate
  useVideoVisibility(videoRef, 0.7);

  // Clear timer only on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Cycling analysis text with its own setInterval inside analyzing view
  useEffect(() => {
    if (status !== 'analyzing') return;
    setAnalysisTextIndex(0);
    const interval = setInterval(() => {
      setAnalysisTextIndex((prev) => (prev + 1) % ANALYSIS_MESSAGES.length);
    }, 600);
    return () => clearInterval(interval);
  }, [status]);

  // Section scroll tracking for clip-path, video scale reveal and pinning across h-[300vh]
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start end', 'end start'],
  });

  // Entry reveal: clip-path animates inset(10% 8% round 40px) to inset(0% 0% round 0px) over first 25%, then stays full
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

  // Video parallaxes slowly (y: 0 to -6%) behind the panel
  const videoY = useTransform(scrollYProgress, [0, 1], ['0%', '-6%']);

  // Glass panel enters late at 20-35% (y:60, opacity: 0 to 1, scale: 0.96 to 1)
  const panelY = useTransform(
    scrollYProgress,
    [0.2, 0.35, 0.85, 1.0],
    [60, 0, 0, -20]
  );
  const panelOpacity = useTransform(
    scrollYProgress,
    [0.2, 0.35, 0.85, 0.98],
    [0, 1, 1, 0]
  );
  const panelScale = useTransform(
    scrollYProgress,
    [0.2, 0.35, 0.85, 1.0],
    [0.96, 1, 1, 0.98]
  );

  // Last 15% (85-100%): Black overlay fades in to opacity 1 for smooth cut to black
  const blackOverlayOpacity = useTransform(scrollYProgress, [0.85, 1.0], [0, 1]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    console.log('handleSubmit: Reveal the Forecast triggered', {
      airline,
      from,
      to,
      date,
      departureTime,
    });

    const forecast = predictFlightDelay({
      airline,
      from,
      to,
      date,
      departureTime,
    });
    setResult(forecast);

    // Start analyzing state
    setStatus('analyzing');

    // Start 1.8s timer INSIDE handleSubmit
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setStatus('result');
    }, 1800);
  };

  const handleReset = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setStatus('idle');
    setResult(null);
    setDisplayPercentage(0);
  };

  // Percentage count-up over 1.4s (easeOut)
  useEffect(() => {
    if (status !== 'result' || !result) return;
    const target = result.probability;
    const startTime = performance.now();
    const duration = 1400;

    let frameId: number;
    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayPercentage(Math.round(eased * target));
      if (progress < 1) {
        frameId = requestAnimationFrame(step);
      }
    };

    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [status, result]);

  // Radius 70 circle circumference
  const circumference = 2 * Math.PI * 70;

  // Format date to uppercase string (e.g. OCTOBER 6, 2026)
  const formattedDate = new Date(date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).toUpperCase();

  return (
    <section
      id="predictor"
      ref={sectionRef}
      className={`relative w-full bg-[#010101] select-none ${
        shouldReduceMotion ? 'min-h-screen py-28' : 'h-[300vh]'
      }`}
    >
      {/* Sticky top-0 h-screen inner layer with clip-path reveal */}
      <motion.div
        style={{
          clipPath: shouldReduceMotion ? 'none' : clipPathVal,
        }}
        className={`${
          shouldReduceMotion
            ? 'relative w-full min-h-screen flex items-center justify-center px-5 sm:px-8'
            : 'sticky top-0 h-screen w-full overflow-hidden flex items-center justify-center px-5 sm:px-8'
        } [will-change:clip-path]`}
      >
        {/* Video fills sticky layer at 100vw x 100vh, object-cover */}
        <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none">
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
              preload="metadata"
              className="w-full h-full object-cover object-center"
            >
              <source src={PREDICTOR_VIDEO_URL} type="video/mp4" />
              <source src={PREDICTOR_VIDEO_WEBM} type="video/webm" />
            </video>
          </motion.div>

          {/* Overlay: bg-black/50 */}
          <div className="absolute inset-0 bg-black/50" />

          {/* 3 tiny floating airplane silhouettes drifting across video */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute animate-plane-drift-1 opacity-20">
              <Plane size={16} className="text-white transform rotate-45" />
            </div>
            <div className="absolute animate-plane-drift-2 opacity-15">
              <Plane size={13} className="text-white transform rotate-35" />
            </div>
            <div className="absolute animate-plane-drift-3 opacity-10">
              <Plane size={15} className="text-white transform rotate-40" />
            </div>
          </div>

          {/* Exit Black Overlay fading in at last 15% (85-100%) */}
          <motion.div
            style={{ opacity: shouldReduceMotion ? 0 : blackOverlayOpacity }}
            className="absolute inset-0 bg-[#010101] pointer-events-none [will-change:opacity]"
          />

          {/* 300px Top and Bottom gradient fades for seamless transitions */}
          <div className="absolute top-0 inset-x-0 h-[300px] bg-gradient-to-b from-[#010101] to-transparent pointer-events-none z-10" />
          <div className="absolute bottom-0 inset-x-0 h-[300px] bg-gradient-to-t from-[#010101] to-transparent pointer-events-none z-10" />
        </div>

        {/* Center Large Liquid Glass Panel: enters late at 20-35% (y:60, opacity:0-1, scale:0.96-1) */}
        <motion.div
          style={{
            y: shouldReduceMotion ? 0 : panelY,
            opacity: shouldReduceMotion ? 1 : panelOpacity,
            scale: shouldReduceMotion ? 1 : panelScale,
          }}
          className="liquid-glass rounded-3xl w-full max-w-2xl mx-auto p-8 sm:p-12 relative z-20 [will-change:transform,opacity]"
        >
        <AnimatePresence mode="wait">
          {status === 'idle' && (
            <motion.div
              key="form"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <h2 className="font-serif-display text-4xl sm:text-5xl text-white font-normal mb-10 text-center sm:text-left leading-tight">
                Will your flight be late?
              </h2>

              <form onSubmit={handleSubmit}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-8">
                  {/* Airline Input */}
                  <div className="sm:col-span-2">
                    <MinimalInput
                      label="Airline"
                      value={airline}
                      onChange={setAirline}
                      placeholder="e.g. Delta Air Lines"
                      required
                    />
                  </div>

                  {/* From Input */}
                  <div>
                    <MinimalInput
                      label="From"
                      value={from}
                      onChange={setFrom}
                      placeholder="e.g. JFK New York"
                      required
                    />
                  </div>

                  {/* To Input */}
                  <div>
                    <MinimalInput
                      label="To"
                      value={to}
                      onChange={setTo}
                      placeholder="e.g. LHR London"
                      required
                    />
                  </div>

                  {/* Date Input */}
                  <div>
                    <MinimalInput
                      label="Date"
                      type="date"
                      value={date}
                      onChange={setDate}
                      required
                    />
                  </div>

                  {/* Departure Time Input */}
                  <div>
                    <MinimalInput
                      label="Departure Time"
                      type="time"
                      value={departureTime}
                      onChange={setDepartureTime}
                      required
                    />
                  </div>
                </div>

                {/* Submit button with type="submit" and magnetic/shimmer styling */}
                <div className="mt-10">
                  <MagneticButton type="submit" className="w-full !h-14">
                    Reveal the Forecast
                  </MagneticButton>
                </div>
              </form>
            </motion.div>
          )}

          {status === 'analyzing' && (
            /* 1.8s Analysis State */
            <motion.div
              key="analyzing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="py-16 flex flex-col items-center justify-center text-center"
            >
              {/* Rotating White Arc on Thin Circle */}
              <div className="relative w-28 h-28 mb-8 flex items-center justify-center pointer-events-none">
                <svg viewBox="0 0 100 100" className="w-full h-full transform -rotate-90">
                  <circle
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke="rgba(255,255,255,0.2)"
                    strokeWidth="1.5"
                  />
                  <motion.circle
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke="rgba(255,255,255,0.85)"
                    strokeWidth="1.8"
                    strokeDasharray="251.3"
                    strokeDashoffset="180"
                    strokeLinecap="round"
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 1.1, ease: 'linear' }}
                    className="origin-center"
                  />
                </svg>
              </div>

              {/* Crossfade Text every 0.6s */}
              <div className="h-8 flex items-center justify-center overflow-hidden pointer-events-none">
                <AnimatePresence mode="wait">
                  <motion.p
                    key={analysisTextIndex}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    className="font-serif-display text-2xl text-white font-normal tracking-wide"
                  >
                    {ANALYSIS_MESSAGES[analysisTextIndex]}...
                  </motion.p>
                </AnimatePresence>
              </div>
            </motion.div>
          )}

          {status === 'result' && result && (
            /* Result View */
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col items-center sm:items-start w-full"
            >
              {/* Header: {FROM} to {TO} in serif plus uppercase date line */}
              <div className="mb-8 w-full text-center sm:text-left">
                <h2 className="font-serif-display text-3xl sm:text-4xl text-white font-normal mb-1.5 leading-tight">
                  {from} to {to}
                </h2>
                <p className="text-xs uppercase tracking-[0.2em] text-white/50 font-light">
                  {formattedDate} · {airline}
                </p>
              </div>

              {/* Percentage with SVG Ring (r=70) */}
              <div className="relative w-44 h-44 my-2 mx-auto sm:mx-0 flex items-center justify-center">
                <svg viewBox="0 0 160 160" className="w-full h-full transform -rotate-90">
                  {/* Background ring */}
                  <circle
                    cx="80"
                    cy="80"
                    r="70"
                    fill="none"
                    stroke="rgba(255,255,255,0.1)"
                    strokeWidth="2.5"
                  />
                  {/* Animated probability ring */}
                  <motion.circle
                    cx="80"
                    cy="80"
                    r="70"
                    fill="none"
                    stroke="rgba(255,255,255,0.85)"
                    strokeWidth="3"
                    strokeDasharray={circumference}
                    initial={{ strokeDashoffset: circumference }}
                    animate={{
                      strokeDashoffset:
                        circumference * (1 - result.probability / 100),
                    }}
                    transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1] }}
                    strokeLinecap="round"
                  />
                </svg>

                {/* Inner Percentage Numeral */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="font-serif-display text-5xl sm:text-6xl text-white font-normal tabular-nums leading-none">
                    {displayPercentage}%
                  </span>
                </div>
              </div>

              {/* Expected delay in minutes */}
              <p className="text-white/80 font-light text-base sm:text-lg mt-4 mb-8 text-center sm:text-left w-full">
                +{result.expectedDelayMinutes} minutes expected delay
              </p>

              {/* Growing Cause Bars (scaleX 0 with 0.2s stagger) */}
              <div className="w-full space-y-6 my-2">
                <span className="text-white/50 uppercase tracking-[0.2em] text-xs font-light block mb-2">
                  Primary Delay Drivers
                </span>
                {result.topCauses.map((cause, i) => (
                  <div key={cause.label} className="w-full">
                    {/* Label fades in after bar starts growing */}
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.5, delay: 0.4 + i * 0.15 }}
                      className="flex items-center justify-between text-xs sm:text-sm font-light text-white/70 mb-2"
                    >
                      <span>{cause.label}</span>
                      <span className="text-white/40 text-xs">
                        {cause.percentage}% (illustrative)
                      </span>
                    </motion.div>

                    {/* Horizontal Bar: grows from scaleX 0 */}
                    <div className="w-full h-[2px] bg-white/10 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        transition={{
                          duration: 1,
                          delay: 0.2 + i * 0.2,
                          ease: [0.16, 1, 0.3, 1],
                        }}
                        style={{
                          width: `${cause.percentage}%`,
                          transformOrigin: 'left',
                        }}
                        className="h-full bg-white/80 rounded-full [will-change:transform]"
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* Try another flight text button to reverse */}
              <button
                type="button"
                onClick={handleReset}
                className="text-white/50 hover:text-white uppercase tracking-[0.2em] text-xs font-light transition-colors duration-200 mt-10 pt-6 border-t border-white/10 w-full text-center cursor-pointer"
              >
                Try another flight
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      </motion.div>
    </section>
  );
};
