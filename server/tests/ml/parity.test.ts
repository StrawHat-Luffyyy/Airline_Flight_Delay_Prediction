import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FEATURE_COLUMNS } from '../../src/features/feature-list.js';
import { encodeFeatures } from '../../src/ml/encoders.js';
import { loadModel } from '../../src/ml/model.js';

/**
 * Phase 5 acceptance (PROJECT_OVERVIEW §11): the TypeScript encoder + onnxruntime-node give the
 * same probabilities as Python for the 100 fixed-seed test rows ml/train.py wrote.
 */
const root = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const ARTIFACTS = root('ml/artifacts');
const SAMPLE = root('ml/artifacts/parity_sample.json');
const TOLERANCE = 1e-4;

const ParitySample = z.object({
  modelVersion: z.string(),
  rows: z
    .array(
      z.object({
        id: z.string(),
        // Exhaustive over FEATURE_COLUMNS, so a missing or renamed feature fails the parse.
        raw: z.record(z.enum(FEATURE_COLUMNS), z.union([z.string(), z.number(), z.null()])),
        encoded: z.array(z.number()),
        probability: z.number(),
      }),
    )
    .length(100),
});

// The artifacts are committed, so this acceptance test fails (never skips) when they are missing.
describe('TS vs Python model parity (100 test rows)', () => {
  const hasArtifacts = existsSync(SAMPLE) && existsSync(`${ARTIFACTS}/model.onnx`);
  const sample = hasArtifacts ? ParitySample.parse(JSON.parse(readFileSync(SAMPLE, 'utf8'))) : null;
  const rows = sample?.rows ?? [];

  it('has the committed artifacts (model.onnx, parity_sample.json)', () => {
    expect(hasArtifacts).toBe(true);
  });

  it('serves the model version the sample was drawn from', async () => {
    const model = await loadModel(ARTIFACTS);
    expect(model.encoders.modelVersion).toBe(sample?.modelVersion);
  });

  it('encodes every row exactly as ml/train.py did', async () => {
    const { encoders } = await loadModel(ARTIFACTS);
    for (const row of rows) {
      expect([...encodeFeatures(row.raw, encoders)], row.id).toEqual(row.encoded.map(Math.fround));
    }
  });

  it(`matches Python probabilities within ${TOLERANCE}`, async () => {
    const model = await loadModel(ARTIFACTS);
    const probabilities = await model.predict(
      rows.map((row) => encodeFeatures(row.raw, model.encoders)),
    );
    const diffs = rows.map((row, i) => Math.abs((probabilities[i] ?? NaN) - row.probability));
    const maxDiff = Math.max(...diffs);
    console.info(`parity: ${rows.length} rows, max |p_ts - p_py| = ${maxDiff.toExponential(2)}`);
    expect(probabilities).toHaveLength(100);
    expect(maxDiff).toBeLessThan(TOLERANCE);
  });
});
