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

const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

const EM_DASH = '—';

const integerFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 0.1861 -> "18.6%". Null or non-finite -> an em dash. */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${(value * 100).toFixed(digits)}%`;
}

/** Percentage points with a sign: 0.0816 -> "+8.2 pp". */
export function formatPoints(value: number, digits = 1): string {
  const points = value * 100;
  const text = Math.abs(points) < 0.05 ? (0).toFixed(digits) : Math.abs(points).toFixed(digits);
  const sign = Math.abs(points) < 0.05 ? '' : points > 0 ? '+' : '−';
  return `${sign}${text} pp`;
}

/** 4.407 -> "+4.4 min", -3 -> "−3.0 min". */
export function formatSignedMinutes(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const rounded = Number(Math.abs(value).toFixed(digits));
  if (rounded === 0) return `${(0).toFixed(digits)} min`;
  return `${value > 0 ? '+' : '−'}${rounded.toFixed(digits)} min`;
}

/** 5819079 -> "5,819,079". */
export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return integerFormat.format(Math.round(value));
}

/** Minutes as millions: 62651867 -> "62.7M". */
export function formatMillions(value: number, digits = 1): string {
  return `${(value / 1_000_000).toFixed(digits)}M`;
}

/** "2015-03" -> "March" (or "Mar" when short). Anything else is returned unchanged. */
export function monthName(period: string, short = false): string {
  const match = /^(\d{4})-(\d{2})/.exec(period);
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!name) return period;
  return short ? name.slice(0, 3) : name;
}

/** 17 -> "17:00". */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** 17 -> "17:00–17:59". */
export function hourRangeLabel(hour: number): string {
  return `${hourLabel(hour)}–${String(hour).padStart(2, '0')}:59`;
}

/** 1..7 (1 = Monday) -> "Mon" / "Monday". Out-of-range values give an empty string. */
export function dayName(dow: number, short = true): string {
  const name = DAYS[dow - 1];
  if (!name) return '';
  return short ? name.slice(0, 3) : name;
}

/** "2026-10-13T09:31:39.329Z" -> "13 Oct 2026". */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Minutes of block time: 273 -> "4 h 33 min". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return hours > 0 ? `${hours} h ${String(rest).padStart(2, '0')} min` : `${rest} min`;
}
