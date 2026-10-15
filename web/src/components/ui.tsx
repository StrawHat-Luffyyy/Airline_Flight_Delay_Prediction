import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';

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

/** A pill toggle group. Every option is a real button, so it is keyboard-operable. */
export function Segmented<V extends string | number>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<V>) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-1 rounded-full bg-wash p-1">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`rounded-full px-3.5 py-1.5 text-[13px] transition-colors ${
              active ? 'bg-ink text-ground' : 'text-ink-2 hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> {
  label: string;
  children: ReactNode;
  error?: string;
}

const FIELD_CLASS =
  'w-full appearance-none truncate rounded-lg border border-rule-strong bg-ground/60 py-2.5 pl-3 pr-9 text-sm text-ink focus-visible:border-delayed';

/** A labelled native select with a drawn chevron. */
export function SelectField({ label, children, error, id, ...rest }: SelectFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div>
      <label htmlFor={fieldId} className="mb-1.5 block text-[12px] text-ink-2">
        {label}
      </label>
      <div className="relative">
        <select
          id={fieldId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-error` : undefined}
          className={FIELD_CLASS}
          {...rest}
        >
          {children}
        </select>
        <svg
          viewBox="0 0 12 12"
          className="pointer-events-none absolute right-3 top-1/2 size-3 -translate-y-1/2 text-ink-2"
          aria-hidden="true"
        >
          <path d="M2 4.5 6 8l4-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
      {error ? (
        <p id={`${fieldId}-error`} className="mt-1.5 text-[12px] text-cancelled">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export { FIELD_CLASS };

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
