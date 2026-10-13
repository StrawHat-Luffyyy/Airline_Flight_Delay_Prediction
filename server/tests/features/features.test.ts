import { describe, expect, it } from 'vitest';
import {
  CATEGORICAL_FEATURES,
  EXPORT_COLUMNS,
  FEATURE_COLUMNS,
  FORBIDDEN_FEATURES,
  isForbiddenFeature,
} from '../../src/features/feature-list.js';
import { isHolidayWeek, usFederalHolidays } from '../../src/features/holidays.js';
import {
  LookupTable,
  buildFeatureRow,
  lookupScopeFor,
  type FeatureSource,
} from '../../src/features/row.js';

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const iso = (date: Date): string => date.toISOString().slice(0, 10);

describe('feature list (§7 leakage guard)', () => {
  it('contains no forbidden post-departure feature', () => {
    expect(FEATURE_COLUMNS.filter(isForbiddenFeature)).toEqual([]);
  });

  it('recognises every forbidden name, including any causes.* field', () => {
    for (const name of FORBIDDEN_FEATURES) expect(isForbiddenFeature(name)).toBe(true);
    expect(isForbiddenFeature('causes.weather')).toBe(true);
    expect(isForbiddenFeature('causeLateAircraft')).toBe(true);
    // Renamed or re-cased variants are still post-departure information.
    expect(isForbiddenFeature('ArrDelay')).toBe(true);
    expect(isForbiddenFeature('arrDelayMinutes')).toBe(true);
    expect(isForbiddenFeature('wasCancelled')).toBe(true);
    expect(isForbiddenFeature('routeRate')).toBe(false);
    expect(isForbiddenFeature('destRate')).toBe(false);
    expect(isForbiddenFeature('scheduledTime')).toBe(false);
  });

  it('drops month-based features (no train month is ever seen at test or Oct-Dec /predict time)', () => {
    expect(FEATURE_COLUMNS).not.toContain('airlineMonthRate');
    expect(FEATURE_COLUMNS).not.toContain('month');
  });

  it('exports id, split and label before the features, in a fixed order', () => {
    // month is exported as an identifier (validation carve-out, split checks), not a feature.
    expect(EXPORT_COLUMNS).toEqual(['id', 'split', 'month', 'label', ...FEATURE_COLUMNS]);
    expect(CATEGORICAL_FEATURES).toEqual(['airline', 'origin', 'dest']);
  });
});

describe('US federal holidays', () => {
  it('computes the 2015 dates from their rules', () => {
    expect(usFederalHolidays(2015).map(iso)).toEqual([
      '2015-01-01',
      '2015-01-19',
      '2015-02-16',
      '2015-05-25',
      '2015-07-04',
      '2015-09-07',
      '2015-10-12',
      '2015-11-11',
      '2015-11-26',
      '2015-12-25',
    ]);
  });

  it('flags dates within 3 days of a holiday, across year boundaries', () => {
    expect(isHolidayWeek(utc('2015-11-23'))).toBe(true); // Thanksgiving - 3
    expect(isHolidayWeek(utc('2015-11-29'))).toBe(true); // Thanksgiving + 3
    expect(isHolidayWeek(utc('2015-11-30'))).toBe(false);
    expect(isHolidayWeek(utc('2015-12-29'))).toBe(true); // New Year 2016 - 3
    expect(isHolidayWeek(utc('2015-03-11'))).toBe(false);
  });
});

describe('lookupScopeFor', () => {
  it('uses the out-of-fold scope for train months and the full scope for test', () => {
    expect([1, 3, 4, 6, 7, 9].map((m) => lookupScopeFor('train', m))).toEqual([
      'fold1',
      'fold1',
      'fold2',
      'fold2',
      'fold3',
      'fold3',
    ]);
    expect(lookupScopeFor('test', 10)).toBe('full');
  });
});

describe('buildFeatureRow', () => {
  const table = new LookupTable([
    { scope: 'full', kind: 'global', key: '', rate: 0.2 },
    { scope: 'full', kind: 'airline', key: 'AA', rate: 0.21 },
    { scope: 'full', kind: 'origin', key: 'JFK', rate: 0.25 },
    { scope: 'full', kind: 'dest', key: 'LAX', rate: 0.18 },
    { scope: 'full', kind: 'originHour', key: 'JFK|17', rate: 0.3 },
    { scope: 'full', kind: 'route', key: 'JFK-LAX', rate: 0.22 },
    { scope: 'fold1', kind: 'global', key: '', rate: 0.19 },
    { scope: 'fold1', kind: 'airline', key: 'AA', rate: 0.17 },
  ]);

  const flight: FeatureSource = {
    date: utc('2015-11-25'),
    month: 11,
    dayOfWeek: 3,
    schedDepHour: 17,
    airline: 'AA',
    origin: 'JFK',
    dest: 'LAX',
    distance: 2475,
    scheduledTime: 360,
  };

  it('maps a flight to the feature columns using the given scope', () => {
    expect(buildFeatureRow(flight, table, 'full')).toEqual({
      dayOfWeek: 3,
      schedDepHour: 17,
      isHolidayWeek: 1,
      airline: 'AA',
      origin: 'JFK',
      dest: 'LAX',
      distance: 2475,
      scheduledTime: 360,
      airlineRate: 0.21,
      originRate: 0.25,
      destRate: 0.18,
      originHourRate: 0.3,
      routeRate: 0.22,
    });
  });

  it('falls back to the scope global rate for unseen keys', () => {
    const row = buildFeatureRow({ ...flight, month: 2, date: utc('2015-02-04') }, table, 'fold1');
    expect(row.airlineRate).toBe(0.17);
    expect(row.originRate).toBe(0.19);
    expect(row.routeRate).toBe(0.19);
    expect(row.isHolidayWeek).toBe(0);
  });

  it('returns keys in FEATURE_COLUMNS order', () => {
    expect(Object.keys(buildFeatureRow(flight, table, 'full'))).toEqual([...FEATURE_COLUMNS]);
  });

  it('refuses a scope with no global rate', () => {
    expect(() => buildFeatureRow(flight, table, 'fold2')).toThrow(/fold2/);
  });
});
