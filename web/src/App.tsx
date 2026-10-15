import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { HeroSection } from './components/HeroSection';
import { Skeleton } from './components/QueryState';
import { Shell } from './components/Shell';

const Overview = lazy(() => import('./pages/Overview'));
const Causes = lazy(() => import('./pages/Causes'));
const Explorer = lazy(() => import('./pages/Explorer'));
const Predict = lazy(() => import('./pages/Predict'));
const Model = lazy(() => import('./pages/Model'));

function PageFallback() {
  return (
    <div role="status">
      <span className="sr-only">Loading page</span>
      <Skeleton className="h-96" />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/" element={<HeroSection />} />
        <Route element={<Shell />}>
          <Route path="/overview" element={<Overview />} />
          <Route path="/causes" element={<Causes />} />
          <Route path="/explorer" element={<Explorer />} />
          <Route path="/predict" element={<Predict />} />
          <Route path="/model" element={<Model />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
