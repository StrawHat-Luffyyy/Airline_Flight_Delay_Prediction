/**
 * The Predict form's dropdown: a field face (code, name, detail) that opens a dark listbox in a
 * portal. Long lists get a search box (code, airport or city; exact and prefix code matches first);
 * short ones get type-ahead instead.
 *
 * Accessibility follows the WAI-ARIA listbox patterns:
 * - the field is a button with aria-haspopup="listbox";
 * - when open, focus moves to the search input (role="combobox") or to the listbox itself, and
 *   the active option is announced through aria-activedescendant;
 * - Arrow keys, Home/End and PageUp/PageDown move; Enter selects; Escape closes; Tab closes and
 *   moves on.
 */
import { Check, ChevronDown, Search, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { filterOptions, typeAhead } from '../../lib/picker';
import { FieldShell, type FieldOption } from './FlightFields';
import { useOutsidePress, usePopover } from './usePopover';

const PAGE = 8;

/** Wraps the first case-insensitive occurrence of `query` in a highlight. */
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim();
  const at = q === '' ? -1 : text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent text-delayed">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

export interface FlightSelectProps {
  label: string;
  value: string;
  options: readonly FieldOption[];
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Show a search box (for long lists). Otherwise type-ahead jumps by code. */
  searchable?: boolean;
  /** What the search covers, e.g. "airport, code or city". */
  searchNoun?: string;
  /** Larger face for the route fields. */
  variant?: 'route' | 'compact';
  /** Minimum popover width, px (a narrow field can still open a readable list). */
  minListWidth?: number;
  className?: string;
}

export function FlightSelect({
  label,
  value,
  options,
  onChange,
  hint,
  error,
  placeholder = 'Choose',
  disabled,
  searchable = false,
  searchNoun = 'code or name',
  variant = 'compact',
  minListWidth = 0,
  className,
}: FlightSelectProps) {
  const id = useId();
  const fieldId = `${id}-field`;
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: '', at: 0 });

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const current = options.find((option) => option.value === value);
  const shown = useMemo(
    () => (searchable ? filterOptions(options, query) : [...options]),
    [options, query, searchable],
  );
  const route = variant === 'route';
  const placement = usePopover(trigger, open, { minWidth: minListWidth });

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (refocus) trigger.current?.focus();
  }, []);

  const openList = (initialQuery = '') => {
    if (disabled) return;
    const pool = searchable ? filterOptions(options, initialQuery) : options;
    const selected = pool.findIndex((option) => option.value === value);
    setQuery(initialQuery);
    setActive(initialQuery !== '' || selected < 0 ? 0 : selected);
    setOpen(true);
  };

  const choose = (option: FieldOption | undefined) => {
    if (!option) return;
    onChange(option.value);
    close(true);
  };

  // Focus moves into the popover as it opens (before paint, so no keystroke is lost).
  useLayoutEffect(() => {
    if (!open) return;
    (searchable ? search.current : list.current)?.focus({ preventScroll: true });
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    // optionId is derived from the stable useId value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, shown]);

  const refs = useMemo(() => [trigger, popover], []);
  useOutsidePress(
    refs,
    open,
    useCallback(() => close(false), [close]),
  );

  const move = (to: number) => setActive(Math.max(0, Math.min(shown.length - 1, to)));

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openList();
    } else if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey) {
      // Typing on the closed field opens it already searching (or jumping) for that letter.
      event.preventDefault();
      if (searchable) {
        openList(event.key);
      } else {
        openList();
        const index = typeAhead(options, Math.max(0, options.indexOf(current!)), event.key);
        if (index >= 0) setActive(index);
      }
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(active + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(active - 1);
        return;
      case 'PageDown':
        event.preventDefault();
        move(active + PAGE);
        return;
      case 'PageUp':
        event.preventDefault();
        move(active - PAGE);
        return;
      case 'Home':
      case 'End':
        // In the search box Home/End move the caret; in the list they jump to the ends.
        if (searchable && event.target === search.current) return;
        event.preventDefault();
        move(event.key === 'Home' ? 0 : shown.length - 1);
        return;
      case 'Enter':
        event.preventDefault();
        choose(shown[active]);
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case 'Tab':
        close(true);
        return;
      default:
        break;
    }
    if (!searchable && event.key.length === 1 && /\S/.test(event.key)) {
      const now = performance.now();
      const text = now - typed.current.at < 600 ? typed.current.text + event.key : event.key;
      typed.current = { text, at: now };
      const index = typeAhead(shown, active, text);
      if (index >= 0) setActive(index);
    }
  };

  const activeOption = shown[active];

  return (
    <FieldShell label={label} fieldId={fieldId} hint={hint} error={error} className={className}>
      <button
        ref={trigger}
        id={fieldId}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${fieldId}-label ${fieldId}-value`}
        aria-controls={open ? listId : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onTriggerKey}
        className="flight-field relative block w-full cursor-pointer text-left disabled:cursor-not-allowed"
        data-open={open ? true : undefined}
        data-invalid={error ? true : undefined}
        data-disabled={disabled ? true : undefined}
      >
        <span id={`${fieldId}-value`} className="sr-only">
          {current
            ? [current.code, current.name, current.detail].filter(Boolean).join(', ')
            : placeholder}
        </span>
        <span
          aria-hidden="true"
          className={`flex items-center gap-3 pl-3.5 pr-9 ${route ? 'min-h-14 py-2' : 'h-11'}`}
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
                    className={`block truncate ${route ? 'text-[13px] leading-snug text-ink' : 'text-[13px] text-ink-2'}`}
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
            <span className="truncate text-[13px] text-ink-3">{placeholder}</span>
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          size={14}
          strokeWidth={1.5}
          className="flight-field-chevron pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3"
        />
      </button>

      {open
        ? createPortal(
            <div
              ref={popover}
              className="flight-popover flex flex-col"
              data-side={placement.side}
              style={placement.style}
            >
              {searchable ? (
                <div className="flight-search-row flex items-center gap-2 border-b border-rule px-3">
                  <Search
                    aria-hidden="true"
                    size={14}
                    strokeWidth={1.5}
                    className="shrink-0 text-ink-3"
                  />
                  <input
                    ref={search}
                    role="combobox"
                    aria-expanded="true"
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={activeOption ? optionId(active) : undefined}
                    aria-label={`Search ${label.toLowerCase()} by ${searchNoun}`}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onListKey}
                    placeholder={`Search ${searchNoun}`}
                    spellCheck={false}
                    autoComplete="off"
                    className="flight-search h-11 min-w-0 flex-1 bg-transparent text-ink placeholder:text-ink-3"
                  />
                  {query ? (
                    <button
                      type="button"
                      aria-label="Clear search"
                      onClick={() => {
                        setQuery('');
                        setActive(0);
                        search.current?.focus();
                      }}
                      className="grid size-6 place-items-center rounded-full text-ink-3 hover:bg-wash hover:text-ink"
                    >
                      <X size={13} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  ) : null}
                  <span className="num shrink-0 text-[11px] text-ink-3" aria-live="polite">
                    {shown.length}
                  </span>
                </div>
              ) : null}
              <ul
                ref={list}
                id={listId}
                role="listbox"
                aria-label={label}
                tabIndex={searchable ? -1 : 0}
                aria-activedescendant={!searchable && activeOption ? optionId(active) : undefined}
                onKeyDown={searchable ? undefined : onListKey}
                className="flight-listbox min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 outline-none"
              >
                {shown.map((option, index) => {
                  const selected = option.value === value;
                  return (
                    <li
                      key={option.value}
                      id={optionId(index)}
                      role="option"
                      aria-selected={selected}
                      data-active={index === active ? true : undefined}
                      onMouseMove={() => index !== active && setActive(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(option)}
                      className="flight-option flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2"
                    >
                      <span
                        className={`num shrink-0 text-[13px] ${selected ? 'text-delayed' : 'text-ink'} ${option.name ? 'w-9' : ''}`}
                      >
                        <Highlight text={option.code} query={query} />
                      </span>
                      {option.name || option.detail ? (
                        <span className="min-w-0 flex-1">
                          {option.name ? (
                            <span className="block truncate text-[13px] leading-snug text-ink-2">
                              <Highlight text={option.name} query={query} />
                            </span>
                          ) : null}
                          {option.detail ? (
                            <span className="block truncate text-[11px] leading-snug tabular-nums text-ink-3">
                              <Highlight text={option.detail} query={query} />
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="flex-1" />
                      )}
                      <Check
                        aria-hidden="true"
                        size={14}
                        strokeWidth={1.75}
                        className={`shrink-0 text-delayed ${selected ? 'opacity-100' : 'opacity-0'}`}
                      />
                    </li>
                  );
                })}
              </ul>
              {shown.length === 0 ? (
                <p className="px-4 pb-4 pt-2 text-[12px] text-ink-3" role="status">
                  Nothing matches “{query.trim()}”. Try a three-letter code or a city.
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </FieldShell>
  );
}
