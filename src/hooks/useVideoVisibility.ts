import { useEffect, RefObject } from 'react';

interface ObservedVideoState {
  video: HTMLVideoElement;
  playbackRate: number;
  isVisible: boolean;
  playPromise: Promise<void> | null;
  safePlay: () => void;
  safePause: () => void;
}

// Global registry mapping video elements to their observed state
const videoRegistry = new Map<HTMLVideoElement, ObservedVideoState>();

// Shared singleton IntersectionObserver instance to prevent redundant concurrent observers
let sharedObserver: IntersectionObserver | null = null;
let isVisibilityListenerAttached = false;

function handleGlobalVisibilityChange() {
  const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  videoRegistry.forEach((state) => {
    if (isHidden) {
      state.safePause();
    } else if (state.isVisible) {
      state.safePlay();
    }
  });
}

function getOrCreateSharedObserver(): IntersectionObserver | null {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
    return null;
  }

  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const video = entry.target as HTMLVideoElement;
          const state = videoRegistry.get(video);
          if (!state) return;

          // When the video element is fully scrolled out of the viewport,
          // entry.isIntersecting is false.
          const isIntersecting = entry.isIntersecting;
          const isTabActive = document.visibilityState !== 'hidden';

          if (isIntersecting && isTabActive) {
            state.isVisible = true;
            state.safePlay();
          } else {
            state.isVisible = false;
            state.safePause();
          }
        });
      },
      {
        threshold: 0, // Triggers as soon as the video is fully scrolled out of the viewport
        rootMargin: '100px 0px 100px 0px', // Buffer so video resumes seamlessly on scroll
      }
    );
  }

  if (!isVisibilityListenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleGlobalVisibilityChange);
    isVisibilityListenerAttached = true;
  }

  return sharedObserver;
}

function registerVideo(video: HTMLVideoElement, playbackRate: number): () => void {
  const observer = getOrCreateSharedObserver();

  const applyPlaybackRate = () => {
    try {
      video.playbackRate = playbackRate;
    } catch {
      // Ignore in environments where playbackRate setting is restricted
    }
  };

  applyPlaybackRate();
  video.addEventListener('loadedmetadata', applyPlaybackRate);

  const state: ObservedVideoState = {
    video,
    playbackRate,
    isVisible: false,
    playPromise: null,
    safePlay() {
      applyPlaybackRate();
      if (video.paused) {
        state.playPromise = video.play();
        if (state.playPromise) {
          state.playPromise.catch(() => {
            // Silently handle autoplay restriction or pause interruption
          });
        }
      }
    },
    safePause() {
      if (state.playPromise) {
        state.playPromise
          .then(() => {
            if (!state.isVisible && !video.paused) {
              video.pause();
            }
          })
          .catch(() => {})
          .finally(() => {
            state.playPromise = null;
          });
      } else if (!video.paused) {
        video.pause();
      }
    },
  };

  videoRegistry.set(video, state);
  if (observer) {
    observer.observe(video);
  }

  return () => {
    video.removeEventListener('loadedmetadata', applyPlaybackRate);
    state.safePause();
    if (observer) {
      observer.unobserve(video);
    }
    videoRegistry.delete(video);

    // Disconnect shared observer and listener when no videos remain
    if (videoRegistry.size === 0) {
      if (sharedObserver) {
        sharedObserver.disconnect();
        sharedObserver = null;
      }
      if (isVisibilityListenerAttached && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleGlobalVisibilityChange);
        isVisibilityListenerAttached = false;
      }
    }
  };
}

/**
 * Performance-driven hook to automatically pause HTML5 video elements when
 * they are fully scrolled out of the viewport. Uses a shared singleton
 * IntersectionObserver instance to remain robust against concurrent observers
 * and maximize browser resource efficiency.
 */
export function useVideoVisibility(
  videoRef: RefObject<HTMLVideoElement | null>,
  playbackRate = 0.7
) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const unregister = registerVideo(video, playbackRate);
    return unregister;
  }, [videoRef, playbackRate]);
}

// Backwards-compatible alias
export const useVideoAutoPause = useVideoVisibility;
