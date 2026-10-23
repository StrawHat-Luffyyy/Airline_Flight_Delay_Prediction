import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository root. This module runs from server/src (tsx) or is bundled into server/dist (the
 * production build, `npm run build -w @flight-delay/server`); both sit two levels below the root,
 * so one relative URL serves both. Every repo-relative path (.env, ml/artifacts, data/, docs/)
 * goes through here: a path computed from its own module's location would break once bundled.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function fromRepoRoot(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}
