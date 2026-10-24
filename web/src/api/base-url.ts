/**
 * Where the dashboard sends API requests. Unset, paths stay relative (`/api/...`): the Vite dev
 * proxy (or a reverse proxy in front of both) serves the API on the page's own origin. Set at build time, it is the
 * API's origin when that is another host, e.g. `http://127.0.0.1:3001` for a `vite preview` build.
 *
 * Only the origin is kept: every client path already starts with `/api`, so a configured trailing
 * slash or `/api` suffix must not double it. vite.config.ts uses the same parser for the CSP.
 */
export function parseApiBaseUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`VITE_API_BASE_URL must be an http(s) URL, got "${value}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`VITE_API_BASE_URL must be an http(s) URL, got "${value}"`);
  }
  return url.origin;
}

export function apiUrl(base: string, path: string): string {
  return `${base}${path}`;
}
