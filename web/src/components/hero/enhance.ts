/**
 * The intro hero's Motion layer, loaded lazily after first paint (dynamic import in
 * HeroSection). It is the only hero module that imports `motion`, so the eager bundle carries no
 * animation library: the entrance is CSS and requestAnimationFrame. Uses Motion's framework-free
 * API (motion values, springs, styleEffect, scroll) on elements React already rendered.
 */
import { motionValue, scroll, springValue, styleEffect, transformValue } from 'motion';
import { MAGNET_SPRING, PARALLAX_PX, PARALLAX_SPRING, ramp } from '../../lib/motion';

export interface HeroNodes {
  /** The tall scroll stage; scroll progress runs 0..1 across it. */
  stage: HTMLElement;
  /** The sticky frame; mouse parallax listens here. */
  section: HTMLElement;
  /** The copy block that fades and lifts away. */
  content: HTMLElement;
  /** The "Continue to the dashboard" block that fades in at the end. */
  handoff: HTMLElement;
  /** Background stack that scales and blurs with scroll. */
  stack: HTMLElement;
  /** Parallax layers, far to near. */
  video: HTMLElement;
  far: HTMLElement;
  near: HTMLElement;
  path: HTMLElement;
  /** Wrapper of the primary action that leans toward the cursor. */
  magnet: HTMLElement;
}

/** How far the primary action may follow the cursor, in px, and how strongly. */
const MAGNET_MAX = 6;
const MAGNET_PULL = 0.18;

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/**
 * Wires parallax, the scroll stage and the magnetic action. `onScrollState` reports whether the
 * visitor has started scrolling (for the cue). Returns a cleanup function.
 */
export function enhanceHero(
  nodes: HeroNodes,
  onScrollState: (scrolled: boolean) => void,
): () => void {
  const cleanups: (() => void)[] = [];

  // ---------- Scroll stage ----------
  // Progress is computed here from the page scroll position. A `target`-based scroll() is driven by
  // a native ViewTimeline whose range is wrong for a sticky stage (it stalled at 0.5), and a
  // two-argument callback keeps Motion on its JS path, where `info.y.current` is the real offset.
  const progress = motionValue(0);
  cleanups.push(
    scroll((_progress: number, info) => {
      const start = nodes.stage.offsetTop;
      const end = start + nodes.stage.offsetHeight - window.innerHeight;
      progress.set(ramp(info.y.current, start, end));
    }),
  );
  cleanups.push(
    styleEffect(nodes.content, {
      opacity: transformValue(() => 1 - ramp(progress.get(), 0, 0.5)),
      y: transformValue(() => -64 * ramp(progress.get(), 0, 0.5)),
    }),
    styleEffect(nodes.stack, {
      scale: transformValue(() => 1 + 0.08 * progress.get()),
      filter: transformValue(() => `blur(${(6 * progress.get()).toFixed(2)}px)`),
    }),
    styleEffect(nodes.handoff, {
      opacity: transformValue(() => ramp(progress.get(), 0.55, 0.85)),
      y: transformValue(() => 20 * (1 - ramp(progress.get(), 0.55, 0.85))),
    }),
  );
  let handoffActive = false;
  let scrolled = false;
  cleanups.push(
    progress.on('change', (value) => {
      const active = value > 0.6;
      if (active !== handoffActive) {
        handoffActive = active;
        // Only what is visible can take focus.
        nodes.content.inert = active;
        nodes.handoff.inert = !active;
      }
      const started = value > 0.04;
      if (started !== scrolled) {
        scrolled = started;
        onScrollState(started);
      }
    }),
  );

  // ---------- Mouse parallax (desktop, fine pointer) ----------
  const pointerX = motionValue(0);
  const pointerY = motionValue(0);
  const springX = springValue(pointerX, PARALLAX_SPRING);
  const springY = springValue(pointerY, PARALLAX_SPRING);
  const layers: [HTMLElement, number][] = [
    [nodes.video, PARALLAX_PX.video],
    [nodes.far, PARALLAX_PX.cloudsFar],
    [nodes.near, PARALLAX_PX.cloudsNear],
    [nodes.path, PARALLAX_PX.path],
  ];
  for (const [element, travel] of layers) {
    cleanups.push(
      styleEffect(element, {
        x: transformValue(() => -springX.get() * travel * 2),
        y: transformValue(() => -springY.get() * travel * 2),
      }),
    );
  }
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || window.innerWidth < 1024) return;
    pointerX.set(event.clientX / window.innerWidth - 0.5);
    pointerY.set(event.clientY / window.innerHeight - 0.5);
  };
  const onPointerLeave = () => {
    pointerX.set(0);
    pointerY.set(0);
  };
  nodes.section.addEventListener('pointermove', onPointerMove);
  nodes.section.addEventListener('pointerleave', onPointerLeave);
  cleanups.push(() => {
    nodes.section.removeEventListener('pointermove', onPointerMove);
    nodes.section.removeEventListener('pointerleave', onPointerLeave);
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
