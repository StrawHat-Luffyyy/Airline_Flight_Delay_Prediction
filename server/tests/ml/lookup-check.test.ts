import { describe, expect, it } from 'vitest';
import { lookupFingerprint, type LookupEntry } from '../../src/features/row.js';
import { chooseLookupPin, lookupVerdict } from '../../src/ml/lookup-check.js';

const entries: LookupEntry[] = [
  { scope: 'full', kind: 'global', key: '', rate: 0.19 },
  { scope: 'full', kind: 'route', key: 'ORD|LAX', rate: 0.23 },
  { scope: 'full', kind: 'airline', key: 'AA', rate: 0.2 },
  { scope: 'fold1', kind: 'airline', key: 'AA', rate: 0.21 },
];

describe('lookupFingerprint', () => {
  it('is a sha256 that does not depend on document order', () => {
    const fingerprint = lookupFingerprint(entries);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(lookupFingerprint([...entries].reverse())).toBe(fingerprint);
  });

  it('changes when a rate /predict reads changes', () => {
    const changed = entries.map((entry) =>
      entry.scope === 'full' && entry.kind === 'route' ? { ...entry, rate: 0.24 } : entry,
    );
    expect(lookupFingerprint(changed)).not.toBe(lookupFingerprint(entries));
  });

  it('covers only the full scope, the one /predict reads', () => {
    const foldChanged = entries.map((entry) =>
      entry.scope === 'fold1' ? { ...entry, rate: 0.5 } : entry,
    );
    expect(lookupFingerprint(foldChanged)).toBe(lookupFingerprint(entries));
  });
});

describe('lookupVerdict', () => {
  it('matches when the served model was registered against the current lookup', () => {
    expect(lookupVerdict({ registered: true, pinned: 'abc' }, 'abc')).toBe('match');
  });

  it('flags a lookup rebuilt from different data since registration', () => {
    expect(lookupVerdict({ registered: true, pinned: 'abc' }, 'def')).toBe('mismatch');
  });

  it('says when the run predates the pin, or the model is not registered at all', () => {
    expect(lookupVerdict({ registered: true, pinned: undefined }, 'abc')).toBe('unpinned');
    expect(lookupVerdict({ registered: false, pinned: undefined }, 'abc')).toBe('unregistered');
  });
});

describe('chooseLookupPin (ml:register)', () => {
  it('pins the lookup the training export was built from', () => {
    expect(chooseLookupPin({ exported: 'abc', current: 'abc' })).toEqual({
      pin: 'abc',
      problem: null,
    });
  });

  it('still pins the exported lookup when it was rebuilt since, and says so', () => {
    expect(chooseLookupPin({ exported: 'abc', current: 'def' })).toEqual({
      pin: 'abc',
      problem: 'changed-since-export',
    });
  });

  it('falls back to the current lookup when the export predates fingerprints', () => {
    expect(chooseLookupPin({ exported: undefined, current: 'def' })).toEqual({
      pin: 'def',
      problem: 'export-unpinned',
    });
  });
});
