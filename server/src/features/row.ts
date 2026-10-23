import { createHash } from 'node:crypto';
import type { Split } from '../db/collections.js';
import type { FeatureColumn } from './feature-list.js';
import { isHolidayWeek } from './holidays.js';

export type LookupScope = 'full' | 'fold1' | 'fold2' | 'fold3';
export type LookupKind = 'global' | 'airline' | 'origin' | 'dest' | 'originHour' | 'route';

/** Train months per fold. A foldK lookup is computed from the train months outside fold K. */
export const FOLD_MONTHS: Record<Exclude<LookupScope, 'full'>, readonly number[]> = {
  fold1: [1, 2, 3],
  fold2: [4, 5, 6],
  fold3: [7, 8, 9],
};

/** Out-of-fold scope for a training row; the full train lookup for test rows and /predict. */
export function lookupScopeFor(split: Split, month: number): LookupScope {
  if (split === 'test') return 'full';
  if (month <= 3) return 'fold1';
  if (month <= 6) return 'fold2';
  return 'fold3';
}

export interface LookupEntry {
  scope: LookupScope;
  kind: LookupKind;
  key: string;
  rate: number;
}

/**
 * A content fingerprint of the rates /api/predict reads (the `full` scope): sha256 over the sorted
 * `kind/key=rate` lines. buildIds are random per build, so they change on every rebuild; this only
 * changes when a served rate does. `ml:register` pins it and the API compares it at startup.
 */
export function lookupFingerprint(entries: Iterable<LookupEntry>): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.scope === 'full') lines.push(`${entry.kind}/${entry.key}=${entry.rate}`);
  }
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

export const originHourKey = (origin: string, hour: number): string => `${origin}|${hour}`;

/** In-memory delay_lookup (~tens of thousands of keys), with a global fallback per scope. */
export class LookupTable {
  private readonly rates = new Map<string, number>();

  constructor(entries: Iterable<LookupEntry>) {
    for (const entry of entries)
      this.rates.set(`${entry.scope}/${entry.kind}/${entry.key}`, entry.rate);
  }

  get size(): number {
    return this.rates.size;
  }

  rate(scope: LookupScope, kind: Exclude<LookupKind, 'global'>, key: string): number {
    return this.rates.get(`${scope}/${kind}/${key}`) ?? this.global(scope);
  }

  global(scope: LookupScope): number {
    const rate = this.rates.get(`${scope}/global/`);
    if (rate === undefined) throw new Error(`delay_lookup has no global rate for scope ${scope}`);
    return rate;
  }
}

/** Pre-departure fields of a flight (or of a /predict request once derived server-side). */
export interface FeatureSource {
  date: Date;
  month: number;
  dayOfWeek: number;
  schedDepHour: number;
  airline: string;
  origin: string;
  dest: string;
  distance: number;
  scheduledTime: number | null;
}

export type FeatureRow = Record<FeatureColumn, string | number | null>;

/** Pure: one flight -> the model features, in FEATURE_COLUMNS order. */
export function buildFeatureRow(
  flight: FeatureSource,
  lookups: LookupTable,
  scope: LookupScope,
): FeatureRow {
  lookups.global(scope);
  return {
    dayOfWeek: flight.dayOfWeek,
    schedDepHour: flight.schedDepHour,
    isHolidayWeek: isHolidayWeek(flight.date) ? 1 : 0,
    airline: flight.airline,
    origin: flight.origin,
    dest: flight.dest,
    distance: flight.distance,
    scheduledTime: flight.scheduledTime,
    airlineRate: lookups.rate(scope, 'airline', flight.airline),
    originRate: lookups.rate(scope, 'origin', flight.origin),
    destRate: lookups.rate(scope, 'dest', flight.dest),
    originHourRate: lookups.rate(
      scope,
      'originHour',
      originHourKey(flight.origin, flight.schedDepHour),
    ),
    routeRate: lookups.rate(scope, 'route', `${flight.origin}-${flight.dest}`),
  };
}
