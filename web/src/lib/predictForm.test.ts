import type { MetaResponse } from '@flight-delay/shared';
import { describe, expect, it } from 'vitest';
import { seedForm } from './predictForm';

const airport = (code: string) => ({
  code,
  name: code,
  city: null,
  state: null,
  latitude: null,
  longitude: null,
});
const meta = {
  airlines: [
    { code: 'AA', name: 'American' },
    { code: 'DL', name: 'Delta' },
  ],
  airports: ['ATL', 'CMH', 'LAX', 'LGA', 'ORD'].map(airport),
} as unknown as MetaResponse;

describe('seedForm', () => {
  it('uses the house defaults when nothing is preferred', () => {
    expect(seedForm(meta)).toMatchObject({ airline: 'AA', origin: 'ORD', dest: 'LAX' });
  });

  it('takes a preferred route from the landing globe', () => {
    expect(seedForm(meta, { origin: 'LGA', dest: 'CMH' })).toMatchObject({
      origin: 'LGA',
      dest: 'CMH',
    });
  });

  it('ignores airports the dataset does not have, and a route to itself', () => {
    expect(seedForm(meta, { origin: 'XXX', dest: 'CMH' })).toMatchObject({
      origin: 'ORD',
      dest: 'CMH',
    });
    expect(seedForm(meta, { origin: 'LGA', dest: 'LGA' })).toMatchObject({
      origin: 'LGA',
      dest: 'LAX',
    });
  });
});
