/**
 * The Predict form's fields. Each is a real native control (a select, or a date input) so keyboard
 * use, type-to-jump, screen readers and phone pickers all behave as the platform does. The select
 * sits invisibly over a drawn face that shows the choice the way a departure board would: the code
 * in mono, the name beside it, and a measured detail (flights, city) on its own line, so nothing is
 * cut off mid-number. Focus, hover, error and disabled states live on the shell (`.flight-field`).
 */
import { CalendarDays, ChevronDown } from 'lucide-react';
import { useId, useRef, type ReactNode, type SelectHTMLAttributes } from 'react';

export interface FieldOption {
  value: string;
  /** Shown large in mono: an IATA code, or an hour range. */
  code: string;
  /** The name beside the code. */
  name?: string;
  /** A second, quieter line: a city, a flight count. */
  detail?: string;
}

interface ShellProps {
  label: string;
  fieldId: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}

function FieldShell({ label, fieldId, hint, error, children, className = '' }: ShellProps) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={fieldId} className="text-[12px] text-ink-2">
          {label}
        </label>
        {hint ? <span className="truncate text-[11px] text-ink-3">{hint}</span> : null}
      </div>
      {children}
      {error ? (
        <p id={`${fieldId}-error`} className="mt-1.5 text-[12px] text-cancelled">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface RichSelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className' | 'value' | 'children'
> {
  label: string;
  value: string;
  options: readonly FieldOption[];
  hint?: ReactNode;
  error?: string;
  /** Shown when there is nothing to choose (loading, or no options). */
  placeholder?: string;
  /** Larger face for the route fields. */
  variant?: 'route' | 'compact';
  className?: string;
}

/** A native select under a drawn face: code, name, and a detail line. */
export function RichSelect({
  label,
  value,
  options,
  hint,
  error,
  placeholder,
  variant = 'compact',
  className,
  id,
  disabled,
  ...rest
}: RichSelectProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const current = options.find((option) => option.value === value);
  const route = variant === 'route';
  return (
    <FieldShell label={label} fieldId={fieldId} hint={hint} error={error} className={className}>
      <div
        className="flight-field relative"
        data-invalid={error ? true : undefined}
        data-disabled={disabled ? true : undefined}
      >
        <div
          aria-hidden="true"
          className={`pointer-events-none flex items-center gap-3 pl-3.5 pr-9 ${route ? 'min-h-14 py-2' : 'h-11'}`}
        >
          {current ? (
            <>
              <span
                className={`num shrink-0 text-ink ${route ? 'text-[19px] tracking-[0.04em]' : 'text-[14px]'}`}
              >
                {current.code}
              </span>
              <span className="min-w-0 flex-1">
                {current.name ? (
                  <span
                    className={`block truncate text-ink ${route ? 'text-[13px] leading-snug' : 'text-[13px] text-ink-2'}`}
                  >
                    {current.name}
                  </span>
                ) : null}
                {current.detail ? (
                  <span className="block truncate text-[11px] leading-snug tabular-nums text-ink-3">
                    {current.detail}
                  </span>
                ) : null}
              </span>
            </>
          ) : (
            <span className="truncate text-[13px] text-ink-3">{placeholder ?? 'Choose'}</span>
          )}
        </div>
        <ChevronDown
          aria-hidden="true"
          size={14}
          strokeWidth={1.5}
          className="flight-field-chevron pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3"
        />
        <select
          id={fieldId}
          value={current ? value : ''}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-error` : undefined}
          className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
          {...rest}
        >
          {current ? null : <option value="">{placeholder ?? 'Choose'}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {[option.code, option.name, option.detail].filter(Boolean).join('  ·  ')}
            </option>
          ))}
        </select>
      </div>
    </FieldShell>
  );
}

interface DateFieldProps {
  label: string;
  value: string;
  min: string;
  max: string;
  onChange: (value: string) => void;
  /** Shown beside the label, e.g. the weekday of the chosen date. */
  hint?: ReactNode;
  error?: string;
  className?: string;
}

/**
 * A visible native date input (typing into its segments still works) with the browser's own
 * calendar icon hidden; a click anywhere on the field opens the platform picker.
 */
export function DateField({
  label,
  value,
  min,
  max,
  onChange,
  hint,
  error,
  className,
}: DateFieldProps) {
  const fieldId = useId();
  const input = useRef<HTMLInputElement>(null);
  const open = () => {
    try {
      input.current?.showPicker();
    } catch {
      // Older browsers, or a picker already open: typing into the field still works.
    }
  };
  return (
    <FieldShell label={label} fieldId={fieldId} hint={hint} error={error} className={className}>
      <div className="flight-field relative" data-invalid={error ? true : undefined} onClick={open}>
        <input
          ref={input}
          id={fieldId}
          type="date"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-error` : undefined}
          className="flight-date num h-11 w-full cursor-pointer bg-transparent pl-3.5 pr-9 text-[14px] text-ink outline-none"
        />
        <CalendarDays
          aria-hidden="true"
          size={15}
          strokeWidth={1.5}
          className="flight-field-chevron pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3"
        />
      </div>
    </FieldShell>
  );
}

/**
 * Origin over destination, joined by a flight path: a ring at the origin, a dashed line, and a
 * filled dot at the destination. The path is drawn beside the two fields, never through them.
 */
export function RouteRail({ origin, dest }: { origin: ReactNode; dest: ReactNode }) {
  return (
    <div className="relative grid grid-cols-[18px_minmax(0,1fr)] gap-x-3">
      <div aria-hidden="true" className="relative row-span-2">
        <span className="absolute left-1/2 top-[calc(3.25rem-5px)] size-2.5 -translate-x-1/2 rounded-full border border-ink-2 bg-ground" />
        <span className="route-rail absolute bottom-[calc(1.75rem+8px)] left-1/2 top-[calc(3.25rem+8px)] w-px -translate-x-1/2" />
        <span className="absolute bottom-[calc(1.75rem-5px)] left-1/2 size-2.5 -translate-x-1/2 rounded-full bg-ink" />
      </div>
      <div className="space-y-4">
        {origin}
        {dest}
      </div>
    </div>
  );
}
