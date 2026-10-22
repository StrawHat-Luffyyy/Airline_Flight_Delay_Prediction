/**
 * The Predict form's date picker: a field face that opens a dark calendar in a portal.
 *
 * - Days: a Monday-first month grid with the selected day lit in the accent. Days outside [min, max] are
 *   struck through and cannot be chosen; days from the neighbouring months are dimmed.
 * - Months and years: the title opens a month view with year steps. Every arrow and every month
 *   outside [min, max] is disabled, so the dataset's 2015 limit cannot be crossed.
 * - Keyboard (WAI-ARIA date picker dialog pattern): arrows move a day or a week; PageUp/PageDown
 *   move a month (with Shift, a year); Home/End go to the week's start or end; Enter or Space
 *   chooses; Escape closes. Focus returns to the field.
 */
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  addDays,
  addMonths,
  clampIso,
  formatLongDate,
  isWithin,
  monthGrid,
  monthLabel,
  monthName,
  parseIso,
  toIso,
  WEEKDAY_SHORT,
  weekdayIndex,
} from '../../lib/picker';
import { FieldShell } from './FlightFields';
import { useOutsidePress, usePopover } from './usePopover';

const WEEKDAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function fullLabel(iso: string): string {
  const parts = parseIso(iso);
  if (!parts) return iso;
  return `${WEEKDAY_FULL[weekdayIndex(iso)]} ${parts.day} ${monthName(parts.month)} ${parts.year}`;
}

export interface DatePickerProps {
  label: string;
  value: string;
  /** Inclusive ISO bounds; nothing outside them can be chosen or navigated to. */
  min: string;
  max: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string;
  className?: string;
}

export function DatePicker({
  label,
  value,
  min,
  max,
  onChange,
  hint,
  error,
  className,
}: DatePickerProps) {
  const id = useId();
  const fieldId = `${id}-field`;
  const titleId = `${id}-title`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLTableElement>(null);

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'days' | 'months'>('days');
  /** The keyboard focus within the grid; also decides which month is shown. */
  const [focus, setFocus] = useState(() => clampIso(parseIso(value) ? value : min, min, max));
  const [viewYear, setViewYear] = useState(() => parseIso(focus)!.year);

  const shown = parseIso(focus)!;
  const placement = usePopover(trigger, open, { minWidth: 304, maxHeight: 420 });
  const days = useMemo(() => monthGrid(shown.year, shown.month), [shown.year, shown.month]);
  const minParts = parseIso(min)!;
  const maxParts = parseIso(max)!;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setView('days');
    if (refocus) trigger.current?.focus();
  }, []);

  const openPicker = () => {
    const start = clampIso(parseIso(value) ? value : min, min, max);
    setFocus(start);
    setViewYear(parseIso(start)!.year);
    setView('days');
    setOpen(true);
  };

  const choose = (iso: string) => {
    if (!isWithin(iso, min, max)) return;
    onChange(iso);
    close(true);
  };

  const refs = useMemo(() => [trigger, popover], []);
  useOutsidePress(
    refs,
    open,
    useCallback(() => close(false), [close]),
  );

  // Keep DOM focus on the focused day (roving tabindex), including after a month change; before
  // paint, so the first key press after opening already lands on the grid.
  useLayoutEffect(() => {
    if (!open || view !== 'days') return;
    grid.current
      ?.querySelector<HTMLButtonElement>(`[data-iso="${focus}"]`)
      ?.focus({ preventScroll: true });
  }, [open, view, focus]);

  const goTo = (iso: string) => setFocus(clampIso(iso, min, max));
  const canPrevMonth = toIso(shown.year, shown.month, 0) >= min;
  const canNextMonth = toIso(shown.year, shown.month + 1, 1) <= max;

  const onGridKey = (event: KeyboardEvent<HTMLTableElement>) => {
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focus, event.shiftKey ? 12 : 1),
      Home: () => addDays(focus, -weekdayIndex(focus)),
      End: () => addDays(focus, 6 - weekdayIndex(focus)),
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      goTo(move());
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(focus);
    }
  };

  const onPopoverKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (view === 'months') setView('days');
      else close(true);
    }
  };

  const navButton =
    'grid size-8 place-items-center rounded-full text-ink-2 transition-colors duration-150 hover:bg-wash hover:text-ink disabled:pointer-events-none disabled:opacity-30';

  return (
    <FieldShell label={label} fieldId={fieldId} hint={hint} error={error} className={className}>
      <button
        ref={trigger}
        id={fieldId}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${fieldId}-label ${fieldId}-value`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openPicker();
          }
        }}
        className="flight-field relative block h-11 w-full cursor-pointer pl-3.5 pr-9 text-left"
        data-open={open ? true : undefined}
        data-invalid={error ? true : undefined}
      >
        <span aria-hidden="true" className="num text-[14px] text-ink">
          {formatLongDate(value).replace(/^\w{3} /, '') || 'Choose a date'}
        </span>
        <span id={`${fieldId}-value`} className="sr-only">
          {fullLabel(value)}
        </span>
        <CalendarDays
          aria-hidden="true"
          size={15}
          strokeWidth={1.5}
          className="flight-field-chevron pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3"
        />
      </button>

      {open
        ? createPortal(
            <div
              ref={popover}
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
              onKeyDown={onPopoverKey}
              className="flight-popover flight-calendar overflow-y-auto p-3"
              data-side={placement.side}
              style={{
                ...placement.style,
                width: Math.max(Number(placement.style.width ?? 0), 304),
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className={navButton}
                  aria-label={view === 'days' ? 'Previous month' : 'Previous year'}
                  disabled={view === 'days' ? !canPrevMonth : viewYear <= minParts.year}
                  onClick={() =>
                    view === 'days' ? goTo(addMonths(focus, -1)) : setViewYear(viewYear - 1)
                  }
                >
                  <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  id={titleId}
                  aria-live="polite"
                  aria-label={
                    view === 'days'
                      ? `${monthLabel(shown.year, shown.month)}, choose a month`
                      : `${viewYear}, back to days`
                  }
                  onClick={() => {
                    setViewYear(shown.year);
                    setView(view === 'days' ? 'months' : 'days');
                  }}
                  className="rounded-full px-3 py-1.5 text-ink transition-colors duration-150 hover:bg-wash"
                >
                  {/* Type styles sit on the span: the global `button { font: inherit }` would win. */}
                  <span className="font-display text-[1.15rem] leading-none">
                    {view === 'days' ? monthLabel(shown.year, shown.month) : viewYear}
                  </span>
                </button>
                <button
                  type="button"
                  className={navButton}
                  aria-label={view === 'days' ? 'Next month' : 'Next year'}
                  disabled={view === 'days' ? !canNextMonth : viewYear >= maxParts.year}
                  onClick={() =>
                    view === 'days' ? goTo(addMonths(focus, 1)) : setViewYear(viewYear + 1)
                  }
                >
                  <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </div>

              {view === 'days' ? (
                <table
                  ref={grid}
                  role="grid"
                  aria-labelledby={titleId}
                  onKeyDown={onGridKey}
                  className="w-full border-collapse"
                >
                  <thead>
                    <tr>
                      {WEEKDAY_SHORT.map((day, index) => (
                        <th
                          key={day}
                          scope="col"
                          abbr={WEEKDAY_FULL[index]}
                          className="pb-1.5 text-center text-[11px] font-normal text-ink-3"
                        >
                          {day.slice(0, 2)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 6 }, (_unused, week) => (
                      <tr key={week}>
                        {days.slice(week * 7, week * 7 + 7).map((iso) => {
                          const parts = parseIso(iso)!;
                          const outside = parts.month !== shown.month;
                          const allowed = isWithin(iso, min, max);
                          const selected = iso === value;
                          return (
                            <td
                              key={iso}
                              role="gridcell"
                              aria-selected={selected}
                              className="p-0.5 text-center"
                            >
                              <button
                                type="button"
                                data-iso={iso}
                                tabIndex={iso === focus ? 0 : -1}
                                aria-label={fullLabel(iso)}
                                aria-disabled={allowed ? undefined : true}
                                aria-current={selected ? 'date' : undefined}
                                onClick={() => choose(iso)}
                                onFocus={() => iso !== focus && allowed && setFocus(iso)}
                                className="calendar-day num"
                                data-selected={selected ? true : undefined}
                                data-outside={outside ? true : undefined}
                                data-disabled={allowed ? undefined : true}
                              >
                                {parts.day}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div
                  role="group"
                  aria-label={`Months of ${viewYear}`}
                  className="grid grid-cols-3 gap-1.5 py-1"
                >
                  {Array.from({ length: 12 }, (_unused, index) => {
                    const month = index + 1;
                    const first = toIso(viewYear, month, 1);
                    const last = toIso(viewYear, month + 1, 0);
                    const allowed = last >= min && first <= max;
                    const isShown = viewYear === shown.year && month === shown.month;
                    return (
                      <button
                        key={month}
                        type="button"
                        disabled={!allowed}
                        aria-pressed={isShown}
                        onClick={() => {
                          goTo(toIso(viewYear, month, Math.min(shown.day, parseIso(last)!.day)));
                          setView('days');
                        }}
                        className="calendar-month"
                        data-selected={isShown ? true : undefined}
                      >
                        {monthName(month).slice(0, 3)}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="mt-2 flex items-center justify-between gap-3 border-t border-rule pt-2.5">
                <p className="text-[11px] text-ink-3">Flights from 2015 only</p>
                {value &&
                view === 'days' &&
                !value.startsWith(`${shown.year}-${String(shown.month).padStart(2, '0')}`) ? (
                  <button
                    type="button"
                    onClick={() => goTo(value)}
                    className="shrink-0 rounded-full px-2.5 py-1 text-ink-2 transition-colors hover:bg-wash hover:text-ink"
                  >
                    <span className="text-[11px]">Back to selected</span>
                  </button>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </FieldShell>
  );
}
