const DAY_MS = 86_400_000;
const WINDOW_DAYS = 3;

const utc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day));

/** The nth (1-based) given weekday (0 = Sunday) of a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = utc(year, month, 1).getUTCDay();
  return utc(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}

function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month, 0));
  return utc(year, month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
}

/** US federal holidays of a year, on their calendar dates (not observed-day shifts). */
export function usFederalHolidays(year: number): Date[] {
  return [
    utc(year, 1, 1), // New Year's Day
    nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3), // Presidents' Day
    lastWeekday(year, 5, 1), // Memorial Day
    utc(year, 7, 4), // Independence Day
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 10, 1, 2), // Columbus Day
    utc(year, 11, 11), // Veterans Day
    nthWeekday(year, 11, 4, 4), // Thanksgiving
    utc(year, 12, 25), // Christmas
  ];
}

/** 1 when the date is within 3 days of a US federal holiday (checks adjacent years too). */
export function isHolidayWeek(date: Date): boolean {
  const year = date.getUTCFullYear();
  return [year - 1, year, year + 1]
    .flatMap(usFederalHolidays)
    .some((holiday) => Math.abs(holiday.getTime() - date.getTime()) <= WINDOW_DAYS * DAY_MS);
}
