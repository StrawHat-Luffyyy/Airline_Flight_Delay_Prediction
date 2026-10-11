// Stop: before Claude declares it is done, make sure the files it modified still type-check.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { block, head, projectRoot, readInput, run, tsconfigFor, typecheck } from './lib.mjs';

const input = readInput();
if (input.stop_hook_active) process.exit(0); // never loop: only force one more turn

const root = projectRoot(input);
const status = run('git', ['status', '--porcelain', '-uall'], { cwd: root, timeout: 10000 });
if (status.status !== 0) process.exit(0);

const changed = status.stdout
  .split('\n')
  .filter(Boolean)
  .map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''))
  .filter((f) => /\.(ts|tsx|mts)$/.test(f) && existsSync(join(root, f)));
if (!changed.length) process.exit(0);

const byConfig = new Map();
for (const f of changed) {
  const cfg = tsconfigFor(root, f);
  if (!cfg) continue;
  byConfig.set(cfg, [...(byConfig.get(cfg) ?? []), f]);
}

const problems = [];
for (const [cfg, files] of byConfig) {
  const { errors } = typecheck(root, cfg, 100000);
  for (const e of errors) {
    if (files.some((f) => e.startsWith(`${f}(`) || e.startsWith(`${f}:`))) problems.push(e);
  }
}

if (problems.length) {
  block(`You modified TypeScript files that no longer type-check (${problems.length} error(s)). Fix them before finishing:\n${head(problems.join('\n'), 25)}`);
}
process.exit(0);
