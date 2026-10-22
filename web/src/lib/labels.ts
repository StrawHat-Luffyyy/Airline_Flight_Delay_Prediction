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

/**
 * Cause colours are tints of the delayed hue (--cause-* tokens) and every chart also labels the
 * segments directly; `short` is that label and `labelColour` the text on the tint (contrast in
 * web/DESIGN.md).
 */
export const CAUSE_META: Record<
  CauseKey,
  { label: string; short: string; color: string; labelColour: string }
> = {
  lateAircraft: {
    label: 'Late-arriving aircraft',
    short: 'Late aircraft',
    color: 'var(--color-cause-late)',
    labelColour: 'var(--bg)',
  },
  carrier: {
    label: 'Carrier',
    short: 'Carrier',
    color: 'var(--color-cause-carrier)',
    labelColour: 'var(--text)',
  },
  nas: {
    label: 'National Air System',
    short: 'NAS',
    color: 'var(--color-cause-nas)',
    labelColour: 'var(--text)',
  },
  weather: {
    label: 'Weather',
    short: 'Weather',
    color: 'var(--color-cause-weather)',
    labelColour: 'var(--text)',
  },
  security: {
    label: 'Security',
    short: 'Security',
    color: 'var(--color-cause-security)',
    labelColour: 'var(--bg)',
  },
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
