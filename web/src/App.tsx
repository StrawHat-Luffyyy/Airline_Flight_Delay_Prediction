import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Landing } from './components/landing/Landing';
import { PageFallback, Shell } from './components/Shell';

const Overview = lazy(() => import('./pages/Overview'));
const Causes = lazy(() => import('./pages/Causes'));
const Explorer = lazy(() => import('./pages/Explorer'));
const Compare = lazy(() => import('./pages/Compare'));
const Predict = lazy(() => import('./pages/Predict'));
const Model = lazy(() => import('./pages/Model'));
const Live = lazy(() => import('./pages/Live'));

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route element={<Shell />}>
          <Route path="/overview" element={<Overview />} />
          <Route path="/causes" element={<Causes />} />
          <Route path="/explorer" element={<Explorer />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/predict" element={<Predict />} />
          <Route path="/model" element={<Model />} />
          <Route path="/live" element={<Live />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
