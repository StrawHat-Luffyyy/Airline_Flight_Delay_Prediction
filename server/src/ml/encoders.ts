import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CATEGORICAL_FEATURES,
  FEATURE_COLUMNS,
  isForbiddenFeature,
} from '../features/feature-list.js';
import type { FeatureRow } from '../features/row.js';
import { fromRepoRoot } from '../paths.js';

export const DEFAULT_ENCODERS_FILE = fromRepoRoot('ml', 'artifacts', 'encoders.json');

const CodeMap = z.record(z.string(), z.number().int());

/**
 * ml/artifacts/encoders.json, written by ml/train.py: the contract /predict encodes with.
 * Refused unless the feature order is exactly FEATURE_COLUMNS and nothing post-departure is listed.
 */
export const EncodersSchema = z.object({
  modelVersion: z.string().min(1),
  algorithm: z.string().min(1),
  featureOrder: z
    .array(z.string())
    .refine(
      (order) => !order.some(isForbiddenFeature),
      'lists a forbidden (post-departure) feature',
    )
    .refine(
      (order) => isDeepStrictEqual(order, [...FEATURE_COLUMNS]),
      'does not match the TypeScript feature contract (FEATURE_COLUMNS)',
    ),
  categorical: z.object({ airline: CodeMap, origin: CodeMap, dest: CodeMap }),
  unknownCategoryCode: z.number().int(),
  imputation: z.object({ scheduledTime: z.number() }),
  lookupScope: z.literal('full'),
  threshold: z.number().min(0).max(1),
  onnx: z.object({
    input: z.string().min(1),
    inputType: z.literal('float32'),
    probabilityOutputColumn: z.number().int().min(0),
  }),
});
export type Encoders = z.infer<typeof EncodersSchema>;

export async function loadEncoders(file = DEFAULT_ENCODERS_FILE): Promise<Encoders> {
  return EncodersSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

const isCategorical = (feature: string): feature is (typeof CATEGORICAL_FEATURES)[number] =>
  (CATEGORICAL_FEATURES as readonly string[]).includes(feature);

/**
 * Pure: one feature row -> the model input vector, identical to ml/train.py encode():
 * categories map to their training code (unseen -> unknownCategoryCode), a missing scheduledTime
 * takes the training median, and everything is float32.
 */
export function encodeFeatures(row: FeatureRow, encoders: Encoders): Float32Array {
  return Float32Array.from(FEATURE_COLUMNS, (feature) => {
    const value = row[feature];
    if (isCategorical(feature)) {
      const codes = encoders.categorical[feature];
      const key = String(value);
      // hasOwn: an inherited key such as "constructor" must encode as unknown, not as NaN.
      const code = Object.hasOwn(codes, key) ? codes[key] : undefined;
      return code ?? encoders.unknownCategoryCode;
    }
    if (value === null) {
      if (feature !== 'scheduledTime') throw new Error(`Feature ${feature} is missing`);
      return encoders.imputation.scheduledTime;
    }
    if (typeof value !== 'number') throw new Error(`Feature ${feature} is not numeric: ${value}`);
    return value;
  });
}
