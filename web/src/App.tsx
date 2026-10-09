import React, { useState, useCallback } from 'react';
import { LenisProvider } from './context/LenisContext';
import { PageLoader } from './components/PageLoader';
import { Navbar } from './components/Navbar';
import { CursorGlow } from './components/CursorGlow';
import { FlightPathProgress } from './components/FlightPathProgress';
import { HeroSection } from './components/HeroSection';
import { StatementSection } from './components/StatementSection';
import { PredictorSection } from './components/PredictorSection';
import { MethodSection } from './components/MethodSection';
import { AmbientMarquee } from './components/AmbientMarquee';
import { FinalSection } from './components/FinalSection';

export default function App() {
  const [loaderComplete, setLoaderComplete] = useState(false);

  const handleLoaderComplete = useCallback(() => {
    console.log('[App] loaderComplete updated: true');
    setLoaderComplete(true);
  }, []);

  return (
    <LenisProvider>
      <div className="relative min-h-screen bg-[#010101] text-white selection:bg-white/20 selection:text-white">
        {/* Full-screen initial page loader */}
        <PageLoader onComplete={handleLoaderComplete} />

        {/* Desktop Cursor Glow */}
        <CursorGlow />

        {/* Global Navbar */}
        <Navbar />

        {/* Flight Path Scroll Progress (right edge, md+) */}
        <FlightPathProgress />

        <main>
          {/* Hero Section with rich motion */}
          <HeroSection isReady={loaderComplete} />

          {/* "Why" Section (id="causes") */}
          <StatementSection />

          {/* Flight Delay Predictor (id="predictor") */}
          <PredictorSection />

          {/* Method Section (id="method") */}
          <MethodSection />

          {/* Ambient Scrolling Marquee */}
          <AmbientMarquee />

          {/* Closing Section & Minimal Footer (id="data") */}
          <FinalSection />
        </main>
      </div>
    </LenisProvider>
  );
}
