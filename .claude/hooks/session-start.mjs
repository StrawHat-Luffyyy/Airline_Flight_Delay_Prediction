// SessionStart: give Claude a factual snapshot of the repo so it does not guess project state.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, readInput, run } from './lib.mjs';

const input = readInput();
const root = projectRoot(input);
const g = (args) => (run('git', args, { cwd: root, timeout: 8000 }).stdout ?? '').trim();
const mark = (ok) => (ok ? 'yes' : 'no');
const lines = ['## Project state snapshot (from SessionStart hook)'];

const inRepo = g(['rev-parse', '--is-inside-work-tree']) === 'true';
if (inRepo) {
  lines.push(`Git branch: ${g(['branch', '--show-current']) || '(detached)'}`);
  const dirty = g(['status', '--porcelain']).split('\n').filter(Boolean).length;
  lines.push(`Uncommitted changes: ${dirty}`);
  const log = g(['log', '--oneline', '-6']);
  lines.push(`Recent commits:\n${log || '(none)'}`);
} else {
  lines.push('Not a git repository yet (run `git init` and commit a baseline before restructuring).');
}

const layout = ['web', 'server', 'shared', 'ml', 'docs'].map((d) => `${d}/=${mark(existsSync(join(root, d)))}`);
lines.push(`Monorepo layout: ${layout.join('  ')}`);
if (!existsSync(join(root, 'web')) && existsSync(join(root, 'src'))) {
  lines.push('Note: the AI Studio frontend is still at the repo root; restructure into web/ is pending (see docs/RESTRUCTURE_PLAN.md if it exists).');
}
if (existsSync(join(root, 'bun.lock')) && existsSync(join(root, 'package-lock.json'))) {
  lines.push('Note: both bun.lock and package-lock.json exist. The project standard is npm.');
}

const docs = ['FRONTEND_AUDIT', 'RESTRUCTURE_PLAN', 'DECISIONS', 'SCHEMA', 'EXPLAIN_RESULTS', 'BIGDATA_JUSTIFICATION'];
lines.push(`Docs present: ${docs.filter((d) => existsSync(join(root, 'docs', `${d}.md`))).join(', ') || 'none'}`);

const rawDir = join(root, 'data/raw');
if (existsSync(rawDir)) {
  const files = readdirSync(rawDir).map((f) => `${f} (${Math.round(statSync(join(rawDir, f)).size / 1048576)} MB)`);
  lines.push(`data/raw: ${files.join(', ') || 'empty'}`);
} else {
  lines.push('data/raw: missing (CSV files not placed yet)');
}

const d = run('docker', ['ps', '--format', '{{.Names}}|{{.Status}}'], { timeout: 4000 });
if (d.error || d.status !== 0) {
  lines.push('Docker: not available or not running.');
} else {
  const mongo = d.stdout.split('\n').filter((l) => /mongo/i.test(l));
  lines.push(`MongoDB container: ${mongo.length ? mongo.join('; ') : 'not running'}`);
}

lines.push('Reminder: follow CLAUDE.md and PROJECT_OVERVIEW.md; work one phase at a time with /phase-runner.');
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(0);
