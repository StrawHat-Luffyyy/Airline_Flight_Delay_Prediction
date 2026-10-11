// Shared helpers for Claude Code hooks. Plain Node, no dependencies (works on Windows, macOS, Linux).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

export function projectRoot(input = {}) {
  return resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
}

/** Exit code 2: the action is blocked and stderr is shown to Claude. */
export function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** PreToolUse: do not block, but make the user confirm. */
export function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

/** PostToolUse: pass extra context to Claude without blocking. */
export function addContext(eventName, text) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } }),
  );
  process.exit(0);
}

export function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 30000,
    cwd: opts.cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

export function rel(root, file) {
  return relative(root, resolve(root, file)).split(sep).join('/');
}

export function head(text, n = 20) {
  return text.split('\n').filter(Boolean).slice(0, n).join('\n');
}

/** Which tsconfig covers this path? Supports the pre-restructure layout (root) and the monorepo layout. */
export function tsconfigFor(root, relFile) {
  const top = relFile.split('/')[0];
  const inWorkspace = ['server', 'shared', 'web'].includes(top);
  const candidates = inWorkspace
    ? [`${top}/tsconfig.app.json`, `${top}/tsconfig.json`]
    : ['tsconfig.app.json', 'tsconfig.json'];
  return candidates.find((c) => existsSync(join(root, c)));
}

export function findTsc(root, cfg) {
  const top = cfg.includes('/') ? cfg.split('/')[0] : '';
  const spots = [
    join(root, 'node_modules/typescript/bin/tsc'),
    top && join(root, top, 'node_modules/typescript/bin/tsc'),
  ].filter(Boolean);
  return spots.find((p) => existsSync(p));
}

/** Run tsc --noEmit for a config; returns array of error lines (paths relative to project root). */
export function typecheck(root, cfg, timeout = 90000) {
  const tsc = findTsc(root, cfg);
  if (!tsc) return { skipped: true, errors: [] };
  const r = run(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', cfg], { cwd: root, timeout });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return { skipped: false, errors: out.split('\n').filter((l) => /error TS\d+/.test(l)) };
}
