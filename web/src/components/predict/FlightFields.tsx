/**
 * Shared pieces of the Predict form's fields: the option shape, the label/hint/error shell, and the
 * route rail. The dropdown is FlightSelect.tsx and the calendar DatePicker.tsx. Focus, hover,
 * error and disabled states live on the field face (`.flight-field` in index.css).
 */
import type { ReactNode } from 'react';

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

export function FieldShell({ label, fieldId, hint, error, children, className = '' }: ShellProps) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label id={`${fieldId}-label`} htmlFor={fieldId} className="text-[12px] text-ink-2">
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
