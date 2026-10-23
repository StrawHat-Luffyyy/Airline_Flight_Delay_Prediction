import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/**
 * Position of a pill that slides under the active item of a row (nav tabs, segmented options).
 * `selector` finds the active item inside `container`; `key` is anything that changes when the
 * active item does. The pill only animates after its first placement, so it never flies in from
 * the left edge on load. Returns `display: none` while no item is active.
 */
export function useSlidingIndicator(
  container: RefObject<HTMLElement | null>,
  selector: string,
  key: unknown,
): CSSProperties {
  const [box, setBox] = useState<{ x: number; width: number } | null>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>(selector);
      if (!active) {
        setBox(null);
        return;
      }
      // Rects, not offsetLeft: the item may sit inside a positioned wrapper.
      const from = root.getBoundingClientRect();
      const to = active.getBoundingClientRect();
      setBox({ x: to.left - from.left, width: to.width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    // Web fonts change label widths once they load.
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [container, selector, key]);

  useLayoutEffect(() => {
    if (!box || placed.current) return;
    // Enable the transition on the frame after the first placement.
    const frame = requestAnimationFrame(() => {
      placed.current = true;
      container.current?.setAttribute('data-indicator-ready', '');
    });
    return () => cancelAnimationFrame(frame);
  }, [box, container]);

  if (!box) return { display: 'none' };
  return { width: box.width, transform: `translateX(${box.x}px)` };
}
