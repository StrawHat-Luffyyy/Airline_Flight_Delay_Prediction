/**
 * The landing page's Motion layer, loaded lazily after first paint (dynamic import in Landing).
 * It is the only landing module that imports `motion`, so the eager bundle carries no animation
 * library. It never touches React state: scroll and cursor go to the globe store, and styles go
 * straight onto elements React already rendered. Never loaded under prefers-reduced-motion.
 */
import {
  animate,
  inView,
  motionValue,
  scroll,
  springValue,
  styleEffect,
  transformValue,
} from 'motion';
import { EASE_OUT_EXPO, MAGNET_SPRING, PARALLAX_SPRING, ramp } from '../../lib/motion';
import { chapterAt } from '../globe/geo';
import { globe } from '../globe/store';

export interface LandingNodes {
  /** Every chapter section, hero first, in document order. */
  chapters: HTMLElement[];
  /** The hero copy, which fades and lifts as the first chapter arrives. */
  heroContent: HTMLElement;
  /** Wrapper of the primary action that leans toward the cursor. */
  magnet: HTMLElement;
}

const MAGNET_MAX = 6;
const MAGNET_PULL = 0.18;
const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/** Wires scroll-to-chapter, the hero exit, chapter reveals, parallax and the magnet. */
export function enhanceLanding(nodes: LandingNodes): () => void {
  const cleanups: (() => void)[] = [];

  // ---------- Scroll: which chapter the globe should frame ----------
  let mids: number[] = [];
  const measure = () => {
    mids = nodes.chapters.map((section) => {
      const box = section.getBoundingClientRect();
      return box.top + window.scrollY + box.height / 2;
    });
  };
  measure();
  const resize = new ResizeObserver(measure);
  resize.observe(document.body);
  cleanups.push(() => resize.disconnect());

  const heroExit = motionValue(0);
  // Two-argument callback: Motion's JS path, where `info.y.current` is the real page offset.
  cleanups.push(
    scroll((_progress: number, info) => {
      const y = info.y.current;
      globe.chapter = chapterAt(mids, y + window.innerHeight / 2);
      heroExit.set(ramp(y, 0, window.innerHeight * 0.6));
    }),
  );
  cleanups.push(
    styleEffect(nodes.heroContent, {
      opacity: transformValue(() => 1 - heroExit.get()),
      y: transformValue(() => -48 * heroExit.get()),
      filter: transformValue(() => `blur(${(4 * heroExit.get()).toFixed(2)}px)`),
    }),
  );

  // ---------- Chapter reveals: each block rises out of a soft blur, once ----------
  for (const section of nodes.chapters.slice(1)) {
    const blocks = Array.from(section.querySelectorAll<HTMLElement>('[data-reveal]'));
    const box = section.getBoundingClientRect();
    // Only hide what is still below the fold; anything already on screen stays put.
    if (blocks.length === 0 || box.top < window.innerHeight * 0.85) continue;
    for (const block of blocks) {
      block.style.opacity = '0';
      block.style.transform = 'translateY(28px)';
      block.style.filter = 'blur(8px)';
    }
    cleanups.push(
      inView(
        section,
        () => {
          blocks.forEach((block, index) => {
            animate(
              block,
              { opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)' },
              { duration: 0.9, delay: index * 0.09, ease: EASE_OUT_EXPO },
            );
          });
        },
        { amount: 0.25 },
      ),
    );
  }

  // ---------- Cursor parallax for the globe (desktop, fine pointer) ----------
  const pointerX = motionValue(0);
  const pointerY = motionValue(0);
  const springX = springValue(pointerX, PARALLAX_SPRING);
  const springY = springValue(pointerY, PARALLAX_SPRING);
  cleanups.push(
    springX.on('change', (value) => {
      globe.pointerX = value;
    }),
    springY.on('change', (value) => {
      globe.pointerY = value;
    }),
  );
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || window.innerWidth < 1024) return;
    pointerX.set(event.clientX / window.innerWidth - 0.5);
    pointerY.set(event.clientY / window.innerHeight - 0.5);
  };
  const onPointerLeave = () => {
    pointerX.set(0);
    pointerY.set(0);
  };
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onPointerLeave);
  cleanups.push(() => {
    window.removeEventListener('pointermove', onPointerMove);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
  });

  // ---------- Magnetic primary action ----------
  const target = nodes.magnet.querySelector('a');
  if (target) {
    const magnetX = motionValue(0);
    const magnetY = motionValue(0);
    cleanups.push(
      styleEffect(nodes.magnet, {
        x: springValue(magnetX, MAGNET_SPRING),
        y: springValue(magnetY, MAGNET_SPRING),
      }),
    );
    const fine = window.matchMedia('(pointer: fine)');
    const follow = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || !fine.matches) return;
      const box = target.getBoundingClientRect();
      magnetX.set(clamp((event.clientX - (box.left + box.width / 2)) * MAGNET_PULL, MAGNET_MAX));
      magnetY.set(clamp((event.clientY - (box.top + box.height / 2)) * MAGNET_PULL, MAGNET_MAX));
    };
    const release = () => {
      magnetX.set(0);
      magnetY.set(0);
    };
    target.addEventListener('pointermove', follow);
    target.addEventListener('pointerleave', release);
    cleanups.push(() => {
      target.removeEventListener('pointermove', follow);
      target.removeEventListener('pointerleave', release);
    });
  }

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
