import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMMIT_CHECK_VERIFIED_CLIENT,
  KAFKA_CLIENT,
  installedKafkaClientVersion,
} from '../../src/stream/client-version.js';

const UPGRADE_STEPS =
  'The Kafka client changed. Before updating COMMIT_CHECK_VERIFIED_CLIENT, run with the broker up:\n' +
  '  npm run stream:commit-check -- --mode raw --yes --out docs/measurements/commit-check-raw.json\n' +
  '  npm run stream:commit-check -- --mode confirmed --yes --out docs/measurements/commit-check-confirmed.json\n' +
  'confirmed must pass. If raw no longer reproduces the defect, the client reports commit results ' +
  'itself and the read-back in commit.ts is redundant (keep or remove it deliberately). ' +
  'See docs/STREAMING.md, "Kafka client upgrades".';

describe('Kafka client version guard', () => {
  it('pins the client to an exact version', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies[KAFKA_CLIENT]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies[KAFKA_CLIENT], UPGRADE_STEPS).toBe(COMMIT_CHECK_VERIFIED_CLIENT);
  });

  it('runs on the client version stream:commit-check last verified', () => {
    expect(installedKafkaClientVersion(), UPGRADE_STEPS).toBe(COMMIT_CHECK_VERIFIED_CLIENT);
  });
});
