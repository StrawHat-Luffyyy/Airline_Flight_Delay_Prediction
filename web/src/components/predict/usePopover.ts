import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/** Gap between the field and its popover, and the minimum margin to the viewport edge, px. */
const GAP = 6;
const MARGIN = 8;

export interface PopoverPlacement {
  style: CSSProperties;
  /** Which side of the field it opened on, for the open animation's origin. */
  side: 'below' | 'above';
}

/**
 * Fixed-position placement for a popover anchored to a field. The popover lives in a portal, so no
 * card, transform or overflow can clip it; it opens below unless there is more room above, never
 * runs past the viewport, and follows the field while the page scrolls or resizes.
 */
export function usePopover(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
  { minWidth = 0, maxHeight = 340 }: { minWidth?: number; maxHeight?: number } = {},
): PopoverPlacement {
  const [placement, setPlacement] = useState<PopoverPlacement>({ style: {}, side: 'below' });

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const place = () => {
      const node = anchor.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, minWidth), window.innerWidth - MARGIN * 2);
      const left = Math.min(Math.max(rect.left, MARGIN), window.innerWidth - width - MARGIN);
      const below = window.innerHeight - rect.bottom - GAP - MARGIN;
      const above = rect.top - GAP - MARGIN;
      const side = below >= Math.min(maxHeight, 260) || below >= above ? 'below' : 'above';
      const room = Math.max(160, Math.min(maxHeight, side === 'below' ? below : above));
      setPlacement({
        side,
        style: {
          position: 'fixed',
          left,
          width,
          maxHeight: room,
          ...(side === 'below'
            ? { top: rect.bottom + GAP }
            : { bottom: window.innerHeight - rect.top + GAP }),
        },
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
    };
  }, [anchor, open, minWidth, maxHeight]);

  return placement;
}

/** Calls `onOutside` for a pointer press outside every given element (the field and its popover). */
export function useOutsidePress(
  refs: readonly RefObject<HTMLElement | null>[],
  active: boolean,
  onOutside: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const press = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && refs.some((ref) => ref.current?.contains(target))) return;
      onOutside();
    };
    document.addEventListener('pointerdown', press, true);
    return () => document.removeEventListener('pointerdown', press, true);
  }, [refs, active, onOutside]);
}
