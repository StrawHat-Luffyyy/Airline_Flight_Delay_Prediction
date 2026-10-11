import { describe, expect, it } from 'vitest';
import { parseHhmm } from '../../src/ingest/hhmm.js';

describe('parseHhmm', () => {
  it('reads unpadded and zero-padded HHMM values', () => {
    expect(parseHhmm('5')).toEqual({ minutes: 5, hour: 0 });
    expect(parseHhmm('0005')).toEqual({ minutes: 5, hour: 0 });
    expect(parseHhmm('1845')).toEqual({ minutes: 1125, hour: 18 });
    expect(parseHhmm('2359')).toEqual({ minutes: 1439, hour: 23 });
  });

  it('treats 2400 as midnight so the hour stays within 0-23', () => {
    expect(parseHhmm('2400')).toEqual({ minutes: 0, hour: 0 });
  });

  it('returns null for blanks and impossible times', () => {
    expect(parseHhmm('')).toBeNull();
    expect(parseHhmm('  ')).toBeNull();
    expect(parseHhmm('2401')).toBeNull();
    expect(parseHhmm('1260')).toBeNull();
    expect(parseHhmm('-5')).toBeNull();
    expect(parseHhmm('12.5')).toBeNull();
    expect(parseHhmm('abc')).toBeNull();
  });
});
