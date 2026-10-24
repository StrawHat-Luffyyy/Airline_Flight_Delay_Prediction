import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './csp';

const directives = (policy: string) =>
  new Map(
    policy.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );

describe('contentSecurityPolicy', () => {
  it('allows API calls only to this origin when the API is same-origin', () => {
    expect(directives(contentSecurityPolicy('')).get('connect-src')).toEqual(["'self'"]);
  });

  it('adds the configured API origin to connect-src and nowhere else', () => {
    const policy = directives(contentSecurityPolicy('https://api.example.org'));
    expect(policy.get('connect-src')).toEqual(["'self'", 'https://api.example.org']);
    expect(policy.get('script-src')).toEqual(["'self'"]);
    expect(policy.get('default-src')).toEqual(["'self'"]);
  });

  it('allows the fonts, styles and the WebGL globe the dashboard needs', () => {
    const policy = directives(contentSecurityPolicy(''));
    expect(policy.get('style-src')).toEqual([
      "'self'",
      "'unsafe-inline'",
      'https://fonts.googleapis.com',
    ]);
    expect(policy.get('font-src')).toEqual(['https://fonts.gstatic.com']);
    expect(policy.get('worker-src')).toEqual(["'self'", 'blob:']);
    expect(policy.get('object-src')).toEqual(["'none'"]);
  });

  it('leaves out frame-ancestors, which a <meta> policy ignores', () => {
    expect(directives(contentSecurityPolicy('')).has('frame-ancestors')).toBe(false);
  });
});
