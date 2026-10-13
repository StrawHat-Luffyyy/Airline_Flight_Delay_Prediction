import { describe, expect, it } from 'vitest';
import { FEATURE_COLUMNS } from '../../src/features/feature-list.js';
import type { FeatureRow } from '../../src/features/row.js';
import { EncodersSchema, encodeFeatures, type Encoders } from '../../src/ml/encoders.js';

const encoders: Encoders = {
  modelVersion: 'test-model',
  algorithm: 'lightgbm',
  featureOrder: [...FEATURE_COLUMNS],
  categorical: {
    airline: { AA: 0, DL: 1 },
    origin: { ATL: 0, ORD: 1 },
    dest: { LAX: 0, ORD: 1 },
  },
  unknownCategoryCode: -1,
  imputation: { scheduledTime: 122 },
  lookupScope: 'full',
  threshold: 0.2,
  onnx: { input: 'features', inputType: 'float32', probabilityOutputColumn: 1 },
};

const row: FeatureRow = {
  dayOfWeek: 3,
  schedDepHour: 17,
  isHolidayWeek: 1,
  airline: 'DL',
  origin: 'ORD',
  dest: 'LAX',
  distance: 1744,
  scheduledTime: 270,
  airlineRate: 0.25,
  originRate: 0.21,
  destRate: 0.18,
  originHourRate: 0.3,
  routeRate: 0.22,
};

describe('encodeFeatures (mirrors ml/train.py encode())', () => {
  it('maps categories to their training codes, in feature order', () => {
    expect([...encodeFeatures(row, encoders)]).toEqual(
      [3, 17, 1, 1, 1, 0, 1744, 270, 0.25, 0.21, 0.18, 0.3, 0.22].map(Math.fround),
    );
  });

  it('encodes a category never seen in training as the unknown code', () => {
    const encoded = encodeFeatures({ ...row, airline: 'ZZ', dest: 'XYZ' }, encoders);
    expect(encoded[FEATURE_COLUMNS.indexOf('airline')]).toBe(-1);
    expect(encoded[FEATURE_COLUMNS.indexOf('dest')]).toBe(-1);
  });

  it('treats inherited object keys as unknown categories', () => {
    const encoded = encodeFeatures({ ...row, origin: 'constructor' }, encoders);
    expect(encoded[FEATURE_COLUMNS.indexOf('origin')]).toBe(-1);
  });

  it('imputes a missing scheduledTime with the training median', () => {
    const encoded = encodeFeatures({ ...row, scheduledTime: null }, encoders);
    expect(encoded[FEATURE_COLUMNS.indexOf('scheduledTime')]).toBe(122);
  });

  it('returns float32 values (the ONNX input type)', () => {
    expect(encodeFeatures(row, encoders)).toBeInstanceOf(Float32Array);
  });
});

describe('EncodersSchema', () => {
  it('rejects encoders whose feature order differs from FEATURE_COLUMNS', () => {
    const reordered = { ...encoders, featureOrder: [...FEATURE_COLUMNS].reverse() };
    expect(EncodersSchema.safeParse(reordered).success).toBe(false);
  });

  it('rejects encoders that list a post-departure feature', () => {
    const leaked = { ...encoders, featureOrder: [...FEATURE_COLUMNS, 'depDelay'] };
    expect(EncodersSchema.safeParse(leaked).success).toBe(false);
  });
});
