/**
 * Pure logic behind the Predict form's dropdowns and calendar: search ranking, type-ahead, and
 * ISO-date arithmetic. Dates stay "YYYY-MM-DD" strings and are computed in UTC, so the local
 * time zone can never shift a day.
 */

export interface SearchableOption {
  value: string;
  code: string;
  name?: string;
  detail?: string;
}

/**
 * Options matching `query`, best first: an exact code, then codes starting with it, then names or
 * cities with a word starting with it, then names or cities containing it. Within a rank the
 * original order holds (destinations stay busiest-first). An empty query returns everything.
 */
export function filterOptions<T extends SearchableOption>(
  options: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...options];
  const ranked: { option: T; rank: number; index: number }[] = [];
  options.forEach((option, index) => {
    const code = option.code.toLowerCase();
    const text = `${option.name ?? ''} ${option.detail ?? ''}`.toLowerCase();
    let rank = -1;
    if (code === q) rank = 0;
    else if (code.startsWith(q)) rank = 1;
    else if (text.split(/[^a-z0-9']+/).some((word) => word.startsWith(q))) rank = 2;
    else if (text.includes(q)) rank = 3;
    if (rank >= 0) ranked.push({ option, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((entry) => entry.option);
}

/**
 * Type-ahead for a list without a search box: the index of the next option whose code starts with
 * `text`. A single repeated letter steps from the option after `from`; a longer prefix may stay on
 * `from` itself. Wraps round; -1 when nothing matches.
 */
export function typeAhead(
  options: readonly SearchableOption[],
  from: number,
  text: string,
): number {
  const q = text.toLowerCase();
  if (q === '' || options.length === 0) return -1;
  const start = q.length > 1 ? from : from + 1;
  for (let step = 0; step < options.length; step += 1) {
    const index = (((start + step) % options.length) + options.length) % options.length;
    if (options[index]!.code.toLowerCase().startsWith(q)) return index;
  }
  return -1;
}

// ---------- Dates ----------

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export interface DateParts {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
}

export function parseIso(iso: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function fromDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function toIso(year: number, month: number, day: number): string {
  return fromDate(new Date(Date.UTC(year, month - 1, day)));
}

export function addDays(iso: string, days: number): string {
  const parts = parseIso(iso);
  if (!parts) return iso;
  return toIso(parts.year, parts.month, parts.day + days);
}

/** Moves by whole months, clamping the day so 31 Jan + 1 month is 28 Feb, not 3 Mar. */
export function addMonths(iso: string, months: number): string {
  const parts = parseIso(iso);
  if (!parts) return iso;
  const first = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return toIso(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(parts.day, lastDay));
}

/** ISO strings compare correctly as text. */
export function isWithin(iso: string, min: string, max: string): boolean {
  return iso >= min && iso <= max;
}

export function clampIso(iso: string, min: string, max: string): string {
  if (iso < min) return min;
  if (iso > max) return max;
  return iso;
}

/** The 42 days (six Monday-first weeks) shown for a month, from the Monday on or before the 1st. */
export function monthGrid(year: number, month: number): string[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_unused, index) => toIso(year, month, 1 - offset + index));
}

/** Monday = 0 .. Sunday = 6. */
export function weekdayIndex(iso: string): number {
  const parts = parseIso(iso);
  if (!parts) return 0;
  return (new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() + 6) % 7;
}

export const WEEKDAY_SHORT = WEEKDAYS;

/** "2015-12-21" -> "Mon 21 Dec 2015"; invalid -> "". */
export function formatLongDate(iso: string): string {
  const parts = parseIso(iso);
  if (!parts) return '';
  return `${WEEKDAYS[weekdayIndex(iso)]} ${parts.day} ${MONTHS[parts.month - 1]!.slice(0, 3)} ${parts.year}`;
}

/** (2015, 2) -> "February 2015". */
export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? ''} ${year}`;
}

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? '';
}
