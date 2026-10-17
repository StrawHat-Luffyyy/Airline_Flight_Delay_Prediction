import type { MetaResponse } from '@flight-delay/shared';

export interface FormState {
  date: string;
  airline: string;
  origin: string;
  dest: string;
  hour: string;
}

const DEFAULTS = {
  date: '2015-12-21',
  airline: 'AA',
  origin: 'ORD',
  dest: 'LAX',
  hour: '17',
} as const;

/**
 * The form's starting values: a preferred route (from `?origin=&dest=`, e.g. the landing globe)
 * when the dataset has both airports, else the house defaults, else the first available option.
 */
export function seedForm(
  meta: Pick<MetaResponse, 'airlines' | 'airports'>,
  preferred: { origin?: string | null; dest?: string | null } = {},
): FormState {
  const airlines = meta.airlines.map((airline) => airline.code);
  const airports = [...meta.airports.map((airport) => airport.code)].sort();
  const pick = (choices: (string | null | undefined)[], options: string[], skip?: string) =>
    choices.find((code): code is string => !!code && options.includes(code) && code !== skip) ??
    options.find((code) => code !== skip) ??
    '';
  const origin = pick([preferred.origin, DEFAULTS.origin], airports);
  return {
    date: DEFAULTS.date,
    airline: pick([DEFAULTS.airline], airlines),
    origin,
    dest: pick([preferred.dest, DEFAULTS.dest], airports, origin),
    hour: DEFAULTS.hour,
  };
}
