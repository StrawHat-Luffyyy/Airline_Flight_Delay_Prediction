import { useId, useRef, type ReactNode } from 'react';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { useSlidingIndicator } from '../hooks/useSlidingIndicator';

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-8 max-w-[75ch]">
      <h1 className="font-display text-[clamp(2.25rem,5vw,3.25rem)] font-normal leading-none text-balance">
        {title}
      </h1>
      {children ? <p className="mt-3 text-sm leading-relaxed text-ink-2">{children}</p> : null}
    </header>
  );
}

/** A titled block separated from its neighbours by a hairline rule rather than a card. */
export function Section({
  title,
  note,
  actions,
  children,
  className = '',
}: {
  title: string;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`border-t border-rule pt-6 ${className}`}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="max-w-[65ch]">
          <h2 id={id} className="font-display text-2xl font-normal leading-tight">
            {title}
          </h2>
          {note ? <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{note}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="max-w-[65ch] text-[13px] leading-relaxed text-ink-3">{children}</p>;
}

interface SegmentedProps<V extends string | number> {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
}

/** A pill toggle group. Every option is a real button, so it is keyboard-operable; one ink pill
 * slides to the chosen option. */
export function Segmented<V extends string | number>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<V>) {
  const group = useRef<HTMLDivElement>(null);
  const pill = useSlidingIndicator(group, '[aria-pressed="true"]', value);
  return (
    <div className="inline-flex rounded-full bg-wash p-1">
      <div ref={group} role="group" aria-label={label} className="relative flex gap-1">
        <span className="slide-pill bg-ink" style={pill} aria-hidden="true" />
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={`relative rounded-full px-3.5 py-1.5 text-[13px] transition-colors duration-200 ${
                active ? 'text-ground' : 'text-ink-2 hover:text-ink'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Swatch({ color }: { color: string }) {
  return (
    <span
      className="mr-2 inline-block size-2 rounded-[2px] align-middle"
      style={{ background: color }}
      aria-hidden="true"
    />
  );
}

/** Dark, hairline-ruled tooltip body shared by every recharts chart. */
export const TOOLTIP_STYLE = {
  background: '#0b0b0b',
  border: '1px solid rgba(255,255,255,0.16)',
  borderRadius: 8,
  color: '#f2f1ec',
  fontSize: 12,
  padding: '8px 10px',
} as const;

export const AXIS_TICK = { fill: '#94938f', fontSize: 11 } as const;

/**
 * Series animation shared by every recharts chart: bars and lines ease in when data first lands
 * and ease between values when a toggle changes them. Off under prefers-reduced-motion.
 */
export function useChartMotion() {
  const reduced = usePrefersReducedMotion();
  return {
    isAnimationActive: !reduced,
    animationDuration: 650,
    animationEasing: 'ease-out',
  } as const;
}
