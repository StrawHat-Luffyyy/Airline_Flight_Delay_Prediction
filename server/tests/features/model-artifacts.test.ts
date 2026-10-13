import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ModelRunSchema } from '@flight-delay/shared';
import { FEATURE_COLUMNS, isForbiddenFeature } from '../../src/features/feature-list.js';

const root = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const ENCODERS = root('ml/artifacts/encoders.json');
const METRICS = root('ml/artifacts/metrics.json');
const TRAIN_PY = root('ml/train.py');

/** The FEATURES list literal in ml/train.py. */
function pythonFeatures(): string[] {
  const source = readFileSync(TRAIN_PY, 'utf8');
  const block = /^FEATURES = \[([\s\S]*?)\]/m.exec(source)?.[1];
  if (!block) throw new Error('FEATURES list not found in ml/train.py');
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
}

describe('model feature contract (§7 leakage guard)', () => {
  it('ml/train.py trains on exactly the TypeScript feature list', () => {
    expect(pythonFeatures()).toEqual([...FEATURE_COLUMNS]);
  });

  it.skipIf(!existsSync(ENCODERS))(
    'encoders.json: feature order matches and nothing is forbidden',
    () => {
      const encoders = JSON.parse(readFileSync(ENCODERS, 'utf8')) as { featureOrder: string[] };
      expect(encoders.featureOrder).toEqual([...FEATURE_COLUMNS]);
      expect(encoders.featureOrder.filter(isForbiddenFeature)).toEqual([]);
    },
  );

  it.skipIf(!existsSync(METRICS))(
    'metrics.json: valid model run, no forbidden feature, beats the baseline',
    () => {
      const run = ModelRunSchema.parse(JSON.parse(readFileSync(METRICS, 'utf8')));
      expect(run.featureList.filter(isForbiddenFeature)).toEqual([]);
      expect(run.featureImportance.map((f) => f.feature).filter(isForbiddenFeature)).toEqual([]);
      expect(run.metrics.auc).toBeGreaterThan(run.models.baseline.test.auc);
    },
  );
});
