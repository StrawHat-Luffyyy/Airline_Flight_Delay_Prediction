import { describe, expect, it } from 'vitest';
import {
  weekdayOf,
  dayName,
  formatInteger,
  formatMillions,
  formatPercent,
  formatPoints,
  formatSignedMinutes,
  hourLabel,
  hourRangeLabel,
  monthName,
} from './format';

describe('format', () => {
  it('formats percentages and handles null', () => {
    expect(formatPercent(0.18611)).toBe('18.6%');
    expect(formatPercent(0.015446, 2)).toBe('1.54%');
    expect(formatPercent(null)).toBe('—');
  });

  it('formats signed minutes', () => {
    expect(formatSignedMinutes(4.407)).toBe('+4.4 min');
    expect(formatSignedMinutes(-3)).toBe('−3.0 min');
    expect(formatSignedMinutes(0)).toBe('0.0 min');
    expect(formatSignedMinutes(null)).toBe('—');
  });

  it('formats percentage points with sign', () => {
    expect(formatPoints(0.0816)).toBe('+8.2 pp');
    expect(formatPoints(-0.0231)).toBe('−2.3 pp');
    expect(formatPoints(0)).toBe('0.0 pp');
  });

  it('formats integers with thousands separators', () => {
    expect(formatInteger(5819079)).toBe('5,819,079');
    expect(formatInteger(12)).toBe('12');
  });

  it('formats millions', () => {
    expect(formatMillions(62651867)).toBe('62.7M');
  });

  it('names months from YYYY-MM', () => {
    expect(monthName('2015-03')).toBe('March');
    expect(monthName('2015-12', true)).toBe('Dec');
    expect(monthName('not a month')).toBe('not a month');
    expect(monthName('2015-13')).toBe('2015-13');
  });

  it('labels hours', () => {
    expect(hourLabel(17)).toBe('17:00');
    expect(hourLabel(5)).toBe('05:00');
    expect(hourRangeLabel(17)).toBe('17:00–17:59');
  });

  it('names days of week with 1 = Monday', () => {
    expect(dayName(1)).toBe('Mon');
    expect(dayName(7, false)).toBe('Sunday');
    expect(dayName(0)).toBe('');
    expect(dayName(8)).toBe('');
  });
});

describe('weekdayOf', () => {
  it('names the weekday of an ISO date, independent of the local time zone', () => {
    expect(weekdayOf('2015-12-21')).toBe('Monday');
    expect(weekdayOf('2015-01-01')).toBe('Thursday');
  });

  it('is empty for anything that is not a date', () => {
    expect(weekdayOf('')).toBe('');
    expect(weekdayOf('2015-13-45')).toBe('');
  });
});
