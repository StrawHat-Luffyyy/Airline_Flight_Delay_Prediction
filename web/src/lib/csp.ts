/**
 * The dashboard's Content-Security-Policy, injected as a <meta> tag into the built index.html
 * (vite.config.ts), so a build served by any static server (`vite preview`, not only Caddy) carries
 * it, including a build-time API origin. It matches deploy/Caddyfile, plus the API origin
 * in connect-src when the API is on another host. `frame-ancestors` is ignored in a <meta> policy,
 * so framing is refused by the X-Frame-Options header instead (deploy/Caddyfile).
 */
export function contentSecurityPolicy(apiOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // React and Motion set inline style attributes; the Google Fonts stylesheet.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    apiOrigin === '' ? "connect-src 'self'" : `connect-src 'self' ${apiOrigin}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
