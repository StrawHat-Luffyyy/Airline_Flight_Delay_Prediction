import { describe, expect, it } from 'vitest';
import {
  addId,
  formatDifference,
  formatMetric,
  makeBaseline,
  readSelection,
  removeId,
  selectionSearch,
} from './compare';

const params = (query: string) => new URLSearchParams(query);

describe('readSelection', () => {
  it('reads the type and ids from the URL, in order', () => {
    expect(readSelection(params('type=airport&ids=ATL,ORD'))).toEqual({
      type: 'airport',
      ids: ['ATL', 'ORD'],
      minFlights: 500,
    });
  });

  it('defaults to airlines with nothing chosen', () => {
    expect(readSelection(params(''))).toEqual({ type: 'airline', ids: [], minFlights: 500 });
    expect(readSelection(params('type=planet&ids=AA'))).toMatchObject({
      type: 'airline',
      ids: ['AA'],
    });
  });

  it('upper-cases, drops malformed or repeated ids and keeps at most four', () => {
    expect(readSelection(params('type=airline&ids=aa,,JFK,AA,DL,UA,WN,B6')).ids).toEqual([
      'AA',
      'DL',
      'UA',
      'WN',
    ]);
    expect(readSelection(params('type=route&ids=JFK-LAX,JFK-JFK,JFKLAX')).ids).toEqual(['JFK-LAX']);
  });
});

it('reads a minimum-flights threshold only from the offered options', () => {
  expect(readSelection(params('min=1000')).minFlights).toBe(1000);
  expect(readSelection(params('min=7')).minFlights).toBe(500);
  expect(readSelection(params('min=abc')).minFlights).toBe(500);
});

describe('selection edits', () => {
  const selection = { type: 'airline' as const, ids: ['AA', 'DL'], minFlights: 500 };

  it('adds to the end, never twice and never past four', () => {
    expect(addId(selection, 'UA').ids).toEqual(['AA', 'DL', 'UA']);
    expect(addId(selection, 'DL').ids).toEqual(['AA', 'DL']);
    expect(addId({ ...selection, ids: ['AA', 'DL', 'UA', 'WN'] }, 'B6').ids).toHaveLength(4);
  });

  it('removes and moves a choice to the front as the baseline', () => {
    expect(removeId(selection, 'AA').ids).toEqual(['DL']);
    expect(makeBaseline({ ...selection, ids: ['AA', 'DL', 'UA'] }, 'UA').ids).toEqual([
      'UA',
      'AA',
      'DL',
    ]);
  });

  it('writes the URL search, leaving ids out when nothing is chosen', () => {
    expect(selectionSearch(selection)).toEqual({ type: 'airline', ids: 'AA,DL' });
    expect(selectionSearch({ type: 'route', ids: [], minFlights: 500 })).toEqual({ type: 'route' });
    expect(selectionSearch({ ...selection, minFlights: 100 })).toEqual({
      type: 'airline',
      ids: 'AA,DL',
      min: '100',
    });
  });
});

describe('metric formatting', () => {
  it('formats values by kind, with a dash for missing values', () => {
    expect(formatMetric('count', 725984)).toBe('725,984');
    expect(formatMetric('rate', 0.18273)).toBe('18.3%');
    expect(formatMetric('minutes', -2.04)).toBe('−2.0 min');
    expect(formatMetric('rate', null)).toBe('—');
  });

  it('formats differences with a sign: counts, percentage points and minutes', () => {
    expect(formatDifference('count', 149897)).toBe('+149,897');
    expect(formatDifference('count', -348)).toBe('−348');
    expect(formatDifference('count', 0)).toBe('0');
    expect(formatDifference('rate', -0.0471)).toBe('−4.7 pp');
    expect(formatDifference('rate', 0)).toBe('0.0 pp');
    expect(formatDifference('minutes', -3.26)).toBe('−3.3 min');
    expect(formatDifference('minutes', null)).toBe('—');
  });
});
