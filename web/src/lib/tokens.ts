/**
 * Colour tokens for code that cannot use CSS variables: SVG presentation attributes (Recharts) and
 * THREE.Color. The values are read from :root (web/src/index.css), so there is still one palette;
 * alpha variants and tints are computed here from those values.
 */

export interface Tokens {
  bg: string;
  surface: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  positive: string;
  negative: string;
  warning: string;
  neutral: string;
  focus: string;
}

const NAMES: Record<keyof Tokens, string> = {
  bg: '--bg',
  surface: '--surface',
  border: '--border',
  borderStrong: '--border-strong',
  text: '--text',
  textMuted: '--text-muted',
  textSubtle: '--text-subtle',
  positive: '--positive',
  negative: '--negative',
  warning: '--warning',
  neutral: '--neutral',
  focus: '--focus',
};

let cached: Tokens | undefined;

/** The resolved hex value of every token (custom properties resolve var() references). */
export function tokens(): Tokens {
  if (cached) return cached;
  const style = getComputedStyle(document.documentElement);
  cached = Object.fromEntries(
    Object.entries(NAMES).map(([key, name]) => [key, style.getPropertyValue(name).trim()]),
  ) as unknown as Tokens;
  return cached;
}

function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** A token at an opacity: the JS twin of color-mix(in srgb, token a%, transparent). */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** `share` of `a` mixed into `b`: the JS twin of color-mix(in srgb, a share%, b). */
export function mix(a: string, b: string, share: number): string {
  const [ra, ga, ba] = rgbOf(a);
  const [rb, gb, bb] = rgbOf(b);
  const c = (x: number, y: number) =>
    Math.round(x * share + y * (1 - share))
      .toString(16)
      .padStart(2, '0');
  return `#${c(ra, rb)}${c(ga, gb)}${c(ba, bb)}`;
}

/** Delay-cause fills: the same tints as the --cause-* CSS tokens. */
export function causeColours(t: Tokens = tokens()) {
  return {
    late: t.negative,
    carrier: mix(t.negative, t.bg, 0.78),
    nas: mix(t.negative, t.bg, 0.58),
    weather: mix(t.negative, t.bg, 0.4),
    security: t.neutral,
  };
}
