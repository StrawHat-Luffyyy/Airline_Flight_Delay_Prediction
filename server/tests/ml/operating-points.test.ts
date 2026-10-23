import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatingPoints } from '@flight-delay/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_METRICS_FILE,
  attachOperatingPoints,
  readModelRun,
  readOperatingPoints,
} from '../../src/ml/register.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'operating-points-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const point = (rule: string, share: number) => ({
  rule,
  minScore: 0.3,
  flagged: Math.round(share * 1000),
  flaggedShare: share,
  precision: 0.2,
  recall: 0.4,
  lift: 1.5,
});

const points = (modelVersion: string): OperatingPoints => ({
  modelVersion,
  computedOn: 'validation (September)',
  scores: 'Jan-Aug model',
  rows: 1000,
  baseRate: 0.13,
  deployed: point('deployed threshold', 0.41),
  points: [point('top 10%', 0.1)],
});

describe('operating points', () => {
  it('reads null when the file does not exist', async () => {
    expect(await readOperatingPoints(join(dir, 'missing.json'))).toBeNull();
  });

  it('reads and validates the file', async () => {
    const file = join(dir, 'ok.json');
    await writeFile(file, JSON.stringify(points('m-1')));
    expect(await readOperatingPoints(file)).toEqual(points('m-1'));
    await writeFile(file, JSON.stringify({ ...points('m-1'), points: [] }));
    await expect(readOperatingPoints(file)).rejects.toThrow();
  });

  it('attaches the points to the run they were computed for', async () => {
    const run = await readModelRun();
    expect(attachOperatingPoints(run, points(run.modelVersion)).operatingPoints).toEqual(
      points(run.modelVersion),
    );
  });

  it('refuses points computed for another model', async () => {
    const run = await readModelRun();
    expect(() => attachOperatingPoints(run, points('other-model'))).toThrow(/other-model/);
  });

  it('matches the committed artifact to the committed run', async () => {
    const run = await readModelRun();
    const committed = await readOperatingPoints();
    expect(committed?.modelVersion).toBe(run.modelVersion);
    // The deployed row reproduces the recorded September validation at the deployed threshold.
    const validation = JSON.parse(await readFile(DEFAULT_METRICS_FILE, 'utf8')) as {
      models: { lightgbm: { validation: { precision: number; recall: number } } };
    };
    expect(committed?.deployed.precision).toBeCloseTo(
      validation.models.lightgbm.validation.precision,
      12,
    );
    expect(committed?.deployed.recall).toBeCloseTo(
      validation.models.lightgbm.validation.recall,
      12,
    );
  });
});
