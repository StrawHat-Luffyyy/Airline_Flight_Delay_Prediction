import { describe, expect, it } from 'vitest';
import {
  ALL_FLIGHT_INDEXES,
  API_INDEXES,
  FLIGHT_INDEXES,
  matchesSpec,
} from '../../src/db/indexes.js';

describe('FLIGHT_INDEXES', () => {
  it('is exactly the PROJECT_OVERVIEW §6.2 index set, in order', () => {
    expect(FLIGHT_INDEXES.map((spec) => [spec.key, spec.partialFilterExpression ?? null])).toEqual([
      [{ date: 1 }, null],
      [{ airline: 1, date: 1 }, null],
      [{ origin: 1, schedDepHour: 1 }, null],
      [{ route: 1 }, null],
      [{ isDelayed: 1, month: 1 }, null],
      [{ month: 1, airline: 1 }, { causes: { $type: 'object' } }],
    ]);
  });

  it('adds only the documented airline + origin index beyond §6.2', () => {
    expect(API_INDEXES.map((spec) => spec.key)).toEqual([{ airline: 1, origin: 1 }]);
  });

  it('gives every index a unique explicit name', () => {
    const names = ALL_FLIGHT_INDEXES.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('matchesSpec', () => {
  const partial = FLIGHT_INDEXES[5];
  if (!partial) throw new Error('missing partial index spec');

  it('matches an existing index with the same key and partial filter', () => {
    expect(
      matchesSpec(
        {
          name: partial.name,
          key: { month: 1, airline: 1 },
          partialFilterExpression: { causes: { $type: 'object' } },
        },
        partial,
      ),
    ).toBe(true);
  });

  it('does not match when the key order, direction or partial filter differ', () => {
    expect(matchesSpec({ key: { airline: 1, month: 1 } }, partial)).toBe(false);
    expect(matchesSpec({ key: { month: 1, airline: -1 } }, partial)).toBe(false);
    expect(matchesSpec({ key: { month: 1, airline: 1 } }, partial)).toBe(false);
    expect(
      matchesSpec(
        { key: { month: 1, airline: 1 }, partialFilterExpression: { causes: { $type: 'null' } } },
        partial,
      ),
    ).toBe(false);
  });
});
