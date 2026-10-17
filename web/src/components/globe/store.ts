import { useSyncExternalStore } from 'react';

/**
 * Shared, render-free state between the landing page's DOM and the WebGL globe. Scroll and
 * pointer write here every frame without touching React; the globe reads it inside useFrame.
 * Only `focus` (the route a reader points at, from either side) notifies React subscribers.
 */
export const globe = {
  /** Fractional chapter index from the scroll position (0 = hero). */
  chapter: 0,
  /** Cursor position, -0.5..0.5 of the viewport, for parallax (fine pointers only). */
  pointerX: 0,
  pointerY: 0,
  /** Extra rotation from dragging the globe, in degrees; eases back to the chapter pose. */
  dragLon: 0,
  dragLat: 0,
};

let focus: string | null = null;
/** Where the focus came from: a board row turns the globe to the route, an arc under the cursor does not. */
let focusSource: 'board' | 'globe' = 'globe';
const listeners = new Set<() => void>();

export function setFocusRoute(id: string | null, source: 'board' | 'globe' = 'globe'): void {
  if (id === focus) return;
  focus = id;
  focusSource = source;
  for (const listener of listeners) listener();
}

/** The route the globe should turn to face, or null. */
export function getSteerRoute(): string | null {
  return focusSource === 'board' ? focus : null;
}

export function getFocusRoute(): string | null {
  return focus;
}

export function subscribeFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The highlighted route id (e.g. "DCA-JFK"), or null. */
export function useFocusRoute(): string | null {
  return useSyncExternalStore(subscribeFocus, getFocusRoute, () => null);
}

/** Reset on unmount so a revisit starts at the hero pose. */
export function resetGlobe(): void {
  globe.chapter = 0;
  globe.pointerX = 0;
  globe.pointerY = 0;
  globe.dragLon = 0;
  globe.dragLat = 0;
  setFocusRoute(null);
}
