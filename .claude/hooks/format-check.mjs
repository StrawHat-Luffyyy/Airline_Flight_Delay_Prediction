// PostToolUse (Write|Edit|MultiEdit): prettier (if configured) + type errors for the edited file + reminders.
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { addContext, block, head, projectRoot, readInput, rel, run, tsconfigFor, typecheck } from './lib.mjs';

const input = readInput();
const root = projectRoot(input);
const file = input.tool_input?.file_path ?? input.tool_input?.path ?? '';
if (!file) process.exit(0);
const p = rel(root, file);
if (!existsSync(join(root, p))) process.exit(0);

const isTs = /\.(ts|tsx|mts)$/.test(p);

// 1. Prettier only when the project has its own config (do not reformat generated code with defaults)
const prettierBin = join(root, 'node_modules/prettier/bin/prettier.cjs');
const hasPrettierConfig = readdirSync(root).some((f) => f.startsWith('.prettierrc') || f.startsWith('prettier.config'));
if (hasPrettierConfig && existsSync(prettierBin) && /\.(ts|tsx|mts|js|mjs|json|css)$/.test(p) && !/^(data|dist|node_modules)\//.test(p)) {
  run(process.execPath, [prettierBin, '--write', p], { cwd: root, timeout: 30000 });
}

// 2. Type errors in the edited file
if (isTs) {
  const cfg = tsconfigFor(root, p);
  if (cfg) {
    const { errors } = typecheck(root, cfg);
    const mine = errors.filter((l) => l.startsWith(`${p}(`) || l.startsWith(`${p}:`));
    if (mine.length) {
      block(`Type errors in ${p} (fix before continuing):\n${head(mine.join('\n'), 20)}`);
    }
  }
}

// 3. Context reminders (non-blocking)
const notes = [];
if (/^(ml\/train\.py|server\/src\/(features|ml)\/)/.test(p)) {
  notes.push('Leakage-sensitive file changed. Before reporting any model metric, run the leakage-auditor agent and /model-parity-check.');
}
if (/^server\/src\/analytics\/[^/]+\.ts$/.test(p)) {
  const name = basename(p, '.ts');
  const testSpots = [
    `server/tests/${name}.test.ts`,
    `server/tests/analytics/${name}.test.ts`,
    `server/src/analytics/${name}.test.ts`,
  ];
  if (!testSpots.some((t) => existsSync(join(root, t)))) {
    notes.push(`Pipeline builder ${p} has no test yet. Use the test-writer agent (seeded fixture, hand-computed expectations), then the mongo-query-optimizer agent.`);
  }
}
if (/^server\/src\/(db|ingest)\//.test(p)) {
  notes.push('Schema/ingestion code changed. Re-check docs/SCHEMA.md and run /verify-ingestion after the next load.');
}
if (notes.length) addContext('PostToolUse', notes.join(' '));
process.exit(0);
