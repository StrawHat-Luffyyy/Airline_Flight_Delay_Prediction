import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  clampIso,
  filterOptions,
  formatLongDate,
  isWithin,
  monthGrid,
  monthLabel,
  parseIso,
  typeAhead,
} from './picker';

const airports = [
  {
    value: 'ORD',
    code: 'ORD',
    name: "Chicago O'Hare International Airport",
    detail: 'Chicago, IL',
  },
  {
    value: 'MDW',
    code: 'MDW',
    name: 'Chicago Midway International Airport',
    detail: 'Chicago, IL',
  },
  {
    value: 'LAX',
    code: 'LAX',
    name: 'Los Angeles International Airport',
    detail: 'Los Angeles, CA',
  },
  { value: 'OAK', code: 'OAK', name: 'Oakland International Airport', detail: 'Oakland, CA' },
  { value: 'ORF', code: 'ORF', name: 'Norfolk International Airport', detail: 'Norfolk, VA' },
];

describe('filterOptions', () => {
  it('returns every option, in order, for an empty query', () => {
    expect(filterOptions(airports, '  ')).toEqual(airports);
  });

  it('puts an exact code first, then code prefixes, then name or city matches', () => {
    const codes = filterOptions(airports, 'or').map((option) => option.code);
    // ORD and ORF start with "or"; Norfolk only contains it in its name.
    expect(codes.slice(0, 2)).toEqual(['ORD', 'ORF']);
    expect(filterOptions(airports, 'orf').map((option) => option.code)[0]).toBe('ORF');
  });

  it('matches names and cities case-insensitively, keeping the original order within a rank', () => {
    expect(filterOptions(airports, 'chicago').map((option) => option.code)).toEqual(['ORD', 'MDW']);
    // "CA" starts a word in two cities; "Chicago" only contains it, so it ranks after them.
    expect(filterOptions(airports, 'ca').map((option) => option.code)).toEqual([
      'LAX',
      'OAK',
      'ORD',
      'MDW',
    ]);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterOptions(airports, 'zzz')).toEqual([]);
  });
});

describe('typeAhead', () => {
  it('finds the next option whose code starts with the typed text, wrapping round', () => {
    expect(typeAhead(airports, 0, 'o')).toBe(3);
    expect(typeAhead(airports, 3, 'o')).toBe(4);
    expect(typeAhead(airports, 4, 'o')).toBe(0);
  });

  it('finds a longer prefix from the current option itself', () => {
    expect(typeAhead(airports, 0, 'ord')).toBe(0);
  });

  it('is -1 when nothing starts with the text', () => {
    expect(typeAhead(airports, 0, 'x')).toBe(-1);
  });
});

describe('calendar helpers', () => {
  it('parses only real ISO dates', () => {
    expect(parseIso('2015-12-21')).toEqual({ year: 2015, month: 12, day: 21 });
    expect(parseIso('2015-02-30')).toBeNull();
    expect(parseIso('21-12-2015')).toBeNull();
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2015-12-31', 1)).toBe('2016-01-01');
    expect(addDays('2015-03-01', -1)).toBe('2015-02-28');
  });

  it('adds months, clamping the day to the shorter month', () => {
    expect(addMonths('2015-01-31', 1)).toBe('2015-02-28');
    expect(addMonths('2015-12-15', -11)).toBe('2015-01-15');
  });

  it('clamps and range-checks against the dataset year', () => {
    expect(clampIso('2014-12-31', '2015-01-01', '2015-12-31')).toBe('2015-01-01');
    expect(clampIso('2016-01-04', '2015-01-01', '2015-12-31')).toBe('2015-12-31');
    expect(isWithin('2015-06-01', '2015-01-01', '2015-12-31')).toBe(true);
    expect(isWithin('2016-01-01', '2015-01-01', '2015-12-31')).toBe(false);
  });

  it('lays out a month as six Monday-first weeks', () => {
    const grid = monthGrid(2015, 12);
    expect(grid).toHaveLength(42);
    // 1 Dec 2015 was a Tuesday, so the grid opens on Monday 30 Nov.
    expect(grid[0]).toBe('2015-11-30');
    expect(grid[1]).toBe('2015-12-01');
    expect(grid[41]).toBe('2016-01-10');
  });

  it('formats labels', () => {
    expect(formatLongDate('2015-12-21')).toBe('Mon 21 Dec 2015');
    expect(formatLongDate('nope')).toBe('');
    expect(monthLabel(2015, 2)).toBe('February 2015');
  });
});
