export interface ClockTime {
  /** Minutes from midnight, 0-1439. */
  minutes: number;
  /** Hour of day, 0-23. */
  hour: number;
}

/**
 * Parses a BTS `HHMM` integer such as `5` (00:05) or `1845` (18:45).
 * `2400` occurs in the source and is treated as midnight of the same day.
 */
export function parseHhmm(value: string): ClockTime | null {
  const trimmed = value.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;

  const hhmm = Number(trimmed);
  if (hhmm === 2400) return { minutes: 0, hour: 0 };

  const hour = Math.floor(hhmm / 100);
  const minute = hhmm % 100;
  if (hour > 23 || minute > 59) return null;
  return { minutes: hour * 60 + minute, hour };
}
