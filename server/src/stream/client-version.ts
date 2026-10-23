/**
 * The Kafka client version the commit workaround was last verified on, and the installed one.
 *
 * commit.ts works around a client defect: `commitOffsets()` resolves before the broker has the
 * commit. Whether that is still needed, and still works, depends on the client version, so a test
 * (client-version.test.ts) fails on any client change until `stream:commit-check` has been run in
 * both modes on the new version and this constant updated (docs/STREAMING.md, "Kafka client
 * upgrades").
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const KAFKA_CLIENT = '@confluentinc/kafka-javascript';

/**
 * Last verified with `npm run stream:commit-check` (2026-10-23): raw reproduced the defect,
 * confirmed showed the fix (docs/measurements/commit-check-*.json).
 */
export const COMMIT_CHECK_VERIFIED_CLIENT = '1.11.0';

/** The installed client's version, from its own package.json. */
export function installedKafkaClientVersion(): string {
  const require = createRequire(import.meta.url);
  // The package's exports do not list package.json; walk up from its entry point instead.
  let dir = dirname(require.resolve(KAFKA_CLIENT));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === KAFKA_CLIENT && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // no package.json here; keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${KAFKA_CLIENT}: package.json not found`);
    dir = parent;
  }
}
