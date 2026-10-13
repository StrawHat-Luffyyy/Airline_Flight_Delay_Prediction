/**
 * The model's feature contract (PROJECT_OVERVIEW §7). The export, ml/train.py (asserts the CSV
 * header) and the Phase 5 /predict encoder all follow this order.
 *
 * Only information known before departure. Dropped from §7 (see DECISIONS, Phase 4):
 * - airline x month rate: rates are out-of-fold by month for training rows, so no evaluated row
 *   can have one without leakage;
 * - month: training sees only months 1-9, so Oct-Dec (the test set and any /predict date then)
 *   would all be treated like September; it also identifies the out-of-fold rate set.
 */
export const FEATURE_COLUMNS = [
  'dayOfWeek',
  'schedDepHour',
  'isHolidayWeek',
  'airline',
  'origin',
  'dest',
  'distance',
  'scheduledTime',
  'airlineRate',
  'originRate',
  'destRate',
  'originHourRate',
  'routeRate',
] as const;
export type FeatureColumn = (typeof FEATURE_COLUMNS)[number];

/** Encoded to integers by ml/train.py (encoders.json). */
export const CATEGORICAL_FEATURES = ['airline', 'origin', 'dest'] as const;

/**
 * CSV columns written by export:training: identifiers and label, then the features. month is an
 * identifier here (validation carve-out and split checks in ml/train.py), not a feature.
 */
export const EXPORT_COLUMNS = ['id', 'split', 'month', 'label', ...FEATURE_COLUMNS] as const;

/** Post-departure information (§7); none may ever be a model feature. */
export const FORBIDDEN_FEATURES = [
  'depDelay',
  'taxiOut',
  'taxiIn',
  'airTime',
  'arrDelay',
  'elapsedTime',
  'causes',
  'cancelled',
  'diverted',
] as const;

/** Lower-case stems of the forbidden fields; a name containing one is post-departure data. */
const FORBIDDEN_STEMS = [
  'depdelay',
  'taxiout',
  'taxiin',
  'airtime',
  'arrdelay',
  'elapsedtime',
  'cause',
  'cancel',
  'divert',
] as const;

/** True for a forbidden name, case-insensitively and including renamed variants (arrDelayMinutes). */
export function isForbiddenFeature(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_STEMS.some((stem) => lower.includes(stem));
}
