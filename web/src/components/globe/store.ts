import { useSyncExternalStore } from 'react';

/**
 * Shared state between the landing page's DOM and the WebGL globe.
 *
 * `globe` is render-free: scroll, cursor, drag and zoom write it every frame without touching
 * React, and the globe reads it inside useFrame. The interaction state below it (what is hovered,
 * what is selected) changes rarely and notifies subscribers, so React panels and the globe agree.
 */
export const globe = {
  /** Fractional chapter index from the scroll position (0 = hero). */
  chapter: 0,
  /** Cursor position, -0.5..0.5 of the viewport, for parallax (fine pointers only). */
  pointerX: 0,
  pointerY: 0,
  /** Extra rotation from dragging, in degrees; eases back once the visitor lets go. */
  dragLon: 0,
  dragLat: 0,
  /** The globe size the camera is framing now (written by the rig; drag speed follows it). */
  size: 1,
  /** Visitor zoom multiplier on the chapter's framing (1 = as framed). */
  zoom: 1,
  /** performance.now() of the last drag or zoom; auto-rotation waits for a quiet spell. */
  lastInteraction: -Infinity,
  /** True while a mouse button is held on the globe. */
  dragging: false,
};

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2.2;

export function zoomBy(factor: number): void {
  globe.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, globe.zoom * factor));
  globe.lastInteraction = performance.now();
  notify();
}

export function resetView(): void {
  globe.zoom = 1;
  globe.dragLon = 0;
  globe.dragLat = 0;
  notify();
}

// ---------- Interaction state ----------

export type Hover = { kind: 'route'; id: string } | { kind: 'airport'; code: string } | null;
/**
 * Where a hover came from: a board row steers the globe to its route; the globe itself shows the
 * cursor tooltip; a panel row (an airport's destinations) only lights its arc.
 */
export type HoverSource = 'board' | 'globe' | 'panel';

interface Interaction {
  hover: Hover;
  hoverSource: HoverSource;
  /** The selected route id. A route and an airport are never selected together. */
  selected: string | null;
  /** The selected airport code: the globe fans out its busiest destinations. */
  selectedAirport: string | null;
}

let state: Interaction = {
  hover: null,
  hoverSource: 'globe',
  selected: null,
  selectedAirport: null,
};
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function sameHover(a: Hover, b: Hover): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'route' && b.kind === 'route') return a.id === b.id;
  if (a.kind === 'airport' && b.kind === 'airport') return a.code === b.code;
  return false;
}

function update(next: Partial<Interaction>): void {
  const merged = { ...state, ...next };
  if (
    merged.selected === state.selected &&
    merged.selectedAirport === state.selectedAirport &&
    merged.hoverSource === state.hoverSource &&
    sameHover(merged.hover, state.hover)
  ) {
    return;
  }
  state = merged;
  notify();
}

export function setHover(hover: Hover, source: HoverSource = 'globe'): void {
  update({ hover, hoverSource: source });
}

/** Clears the hover only if it is still `hover` (a late "out" must not wipe a newer "over"). */
export function clearHover(hover: Hover): void {
  if (sameHover(state.hover, hover)) update({ hover: null });
}

export function setSelected(id: string | null): void {
  update({ selected: id, selectedAirport: id === null ? state.selectedAirport : null });
}

export function setSelectedAirport(code: string | null): void {
  update({ selectedAirport: code, selected: code === null ? state.selected : null });
}

/** Clears whichever route or airport is selected. */
export function clearSelection(): void {
  update({ selected: null, selectedAirport: null });
}

export function getInteraction(): Interaction {
  return state;
}

/** The route drawn lit: the hovered one, else the selected one. */
export function getHighlightRoute(): string | null {
  return state.hover?.kind === 'route' ? state.hover.id : state.selected;
}

/** The route the globe turns to face: a board-hovered route, else the selected one. */
export function getSteerRoute(): string | null {
  if (state.hover?.kind === 'route' && state.hoverSource === 'board') return state.hover.id;
  return state.selected;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInteraction(): Interaction {
  return useSyncExternalStore(subscribe, getInteraction, getInteraction);
}

/** Reset on unmount so a revisit starts at the hero pose with nothing selected. */
export function resetGlobe(): void {
  globe.chapter = 0;
  globe.pointerX = 0;
  globe.pointerY = 0;
  globe.dragLon = 0;
  globe.dragLat = 0;
  globe.zoom = 1;
  globe.lastInteraction = -Infinity;
  globe.dragging = false;
  state = { hover: null, hoverSource: 'globe', selected: null, selectedAirport: null };
  notify();
}
