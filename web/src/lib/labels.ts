import { CAUSE_KEYS, RATE_FEATURES, type CauseKey } from '@flight-delay/shared';

export type RateFeature = (typeof RATE_FEATURES)[number];

/** Display order for stacked causes: biggest-first as in the overall share. */
export const CAUSE_ORDER: readonly CauseKey[] = [
  'lateAircraft',
  'carrier',
  'nas',
  'weather',
  'security',
] satisfies readonly CauseKey[];

export const CAUSE_META: Record<CauseKey, { label: string; color: string }> = {
  lateAircraft: { label: 'Late-arriving aircraft', color: 'var(--color-cause-late)' },
  carrier: { label: 'Carrier', color: 'var(--color-cause-carrier)' },
  nas: { label: 'National Air System', color: 'var(--color-cause-nas)' },
  weather: { label: 'Weather', color: 'var(--color-cause-weather)' },
  security: { label: 'Security', color: 'var(--color-cause-security)' },
};

export function isCauseKey(value: string): value is CauseKey {
  return (CAUSE_KEYS as readonly string[]).includes(value);
}

export const FACTOR_LABELS: Record<RateFeature, string> = {
  airlineRate: "Airline's historical delay rate",
  originRate: 'Origin airport',
  destRate: 'Destination airport',
  originHourRate: 'Origin at this hour',
  routeRate: 'This route',
};

/** Human names for model input features (feature-importance chart). */
export const FEATURE_LABELS: Record<string, string> = {
  dayOfWeek: 'Day of week',
  schedDepHour: 'Scheduled departure hour',
  isHolidayWeek: 'Holiday week',
  airline: 'Airline',
  origin: 'Origin airport',
  dest: 'Destination airport',
  distance: 'Distance',
  scheduledTime: 'Scheduled block time',
  airlineRate: "Airline's historical delay rate",
  originRate: 'Origin historical delay rate',
  destRate: 'Destination historical delay rate',
  originHourRate: 'Origin at this hour, historical rate',
  routeRate: 'Route historical delay rate',
};

export function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature;
}

export const ALGORITHM_LABELS: Record<string, string> = {
  lightgbm: 'LightGBM',
  logistic_regression: 'Logistic regression',
};
