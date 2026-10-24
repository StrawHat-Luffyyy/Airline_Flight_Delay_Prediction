import { describe, expect, it } from 'vitest';
import { apiUrl, parseApiBaseUrl } from './base-url';

describe('parseApiBaseUrl (VITE_API_BASE_URL)', () => {
  it('is empty when unset, so requests stay same-origin (the Vite proxy)', () => {
    expect(parseApiBaseUrl(undefined)).toBe('');
    expect(parseApiBaseUrl('')).toBe('');
    expect(parseApiBaseUrl('  ')).toBe('');
  });

  it('keeps only the origin of a full URL, so a trailing slash or /api suffix cannot double up', () => {
    expect(parseApiBaseUrl('https://api.example.org')).toBe('https://api.example.org');
    expect(parseApiBaseUrl('https://api.example.org/')).toBe('https://api.example.org');
    expect(parseApiBaseUrl('https://api.example.org/api')).toBe('https://api.example.org');
    expect(parseApiBaseUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
  });

  it('refuses anything that is not an http(s) URL, failing the build instead of the page', () => {
    expect(() => parseApiBaseUrl('api.example.org')).toThrow(/VITE_API_BASE_URL/);
    expect(() => parseApiBaseUrl('javascript:alert(1)')).toThrow(/VITE_API_BASE_URL/);
    expect(() => parseApiBaseUrl('ftp://example.com')).toThrow(/VITE_API_BASE_URL/);
  });
});

describe('apiUrl', () => {
  it('leaves paths relative without a base', () => {
    expect(apiUrl('', '/api/meta?x=1')).toBe('/api/meta?x=1');
  });

  it('prefixes the API origin when one is configured', () => {
    expect(apiUrl('https://api.example.org', '/api/meta?x=1')).toBe(
      'https://api.example.org/api/meta?x=1',
    );
  });
});
