import { z } from 'zod';

/** Classification metrics at a decision threshold (threshold null = predicts the majority class). */
export const EvaluationSchema = z.object({
  auc: z.number(),
  prAuc: z.number(),
  precision: z.number(),
  recall: z.number(),
  f1: z.number(),
  threshold: z.number().nullable(),
  confusion: z.object({ tn: z.number(), fp: z.number(), fn: z.number(), tp: z.number() }),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

const ModelResultSchema = z.object({
  description: z.string().optional(),
  bestIteration: z.number().optional(),
  validation: EvaluationSchema,
  /** The final (Jan-Sep refit) model on the test set. */
  test: EvaluationSchema,
  /** The Jan-Aug model the threshold was chosen on, scored on test at the same threshold. */
  testFitModel: EvaluationSchema.optional(),
});

const OperatingPointSchema = z.object({
  /** "top 10%" ... or "deployed threshold". */
  rule: z.string(),
  /** Lowest score flagged under this rule. */
  minScore: z.number(),
  flagged: z.number(),
  flaggedShare: z.number(),
  precision: z.number(),
  recall: z.number(),
  /** precision / baseRate. */
  lift: z.number(),
});
export type OperatingPoint = z.infer<typeof OperatingPointSchema>;

/**
 * Precision, recall and lift if the model flagged its top N% of flights, on September validation
 * only. Written by `ml/train.py --operating-points` to ml/artifacts/operating-points.json.
 */
export const OperatingPointsSchema = z.object({
  modelVersion: z.string().min(1),
  computedOn: z.string(),
  scores: z.string(),
  rows: z.number(),
  baseRate: z.number(),
  deployed: OperatingPointSchema,
  points: z.array(OperatingPointSchema).min(1),
});
export type OperatingPoints = z.infer<typeof OperatingPointsSchema>;

/**
 * One training run, as written by ml/train.py to ml/artifacts/metrics.json and stored in
 * model_runs by `npm run ml:register` (PROJECT_OVERVIEW §6.1, §7).
 */
export const ModelRunSchema = z.object({
  modelVersion: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  algorithm: z.enum(['lightgbm', 'logistic_regression']),
  featureList: z.array(z.string()).min(1),
  trainRange: z.object({ from: z.string(), to: z.string(), rows: z.number() }),
  validation: z.object({ month: z.number(), rows: z.number(), usedFor: z.string() }),
  testRange: z.object({ from: z.string(), to: z.string(), rows: z.number() }),
  excluded: z.object({ unresolvedAirport: z.number(), noOutcome: z.number() }),
  classBalance: z.object({ trainDelayRate: z.number(), testDelayRate: z.number() }),
  threshold: z.object({ value: z.number(), chosenOn: z.string(), criterion: z.string() }),
  /** The chosen model on the test set. */
  metrics: EvaluationSchema,
  models: z.object({
    baseline: ModelResultSchema,
    logisticRegression: ModelResultSchema,
    lightgbm: ModelResultSchema,
  }),
  featureImportance: z.array(z.object({ feature: z.string(), importance: z.number() })),
  onnx: z.object({
    maxAbsDiffVsNative: z.number(),
    rowsChecked: z.number(),
    sizeBytes: z.number(),
  }),
  durationSeconds: z.number(),
  versions: z.record(z.string(), z.string()),
  /** Added by `npm run ml:register` from operating-points.json when present for this run. */
  operatingPoints: OperatingPointsSchema.optional(),
});
export type ModelRun = z.infer<typeof ModelRunSchema>;

// ---------- /api/model/* and /api/predict (§9) ----------

/** GET /model/metrics: the model_runs document of the model currently being served. */
export const ModelMetricsResponseSchema = ModelRunSchema.extend({
  registeredAt: z.string().datetime({ offset: true }),
});
export type ModelMetricsResponse = z.infer<typeof ModelMetricsResponseSchema>;

/** GET /model/feature-importance: LightGBM gain share per feature, from the served run. */
export const FeatureImportanceResponseSchema = z.object({
  modelVersion: z.string(),
  features: ModelRunSchema.shape.featureImportance,
});
export type FeatureImportanceResponse = z.infer<typeof FeatureImportanceResponseSchema>;

const UPPER_AIRPORT = /^[A-Z]{3}$/;

/** POST /predict body: only pre-departure facts; the server derives everything else. */
export const PredictRequestSchema = z
  .object({
    date: z.iso.date('date must be a calendar date (YYYY-MM-DD)'),
    airline: z.string().regex(/^[A-Z0-9]{2}$/, 'airline must be a 2-character IATA code'),
    origin: z.string().regex(UPPER_AIRPORT, 'origin must be a 3-letter IATA code'),
    dest: z.string().regex(UPPER_AIRPORT, 'dest must be a 3-letter IATA code'),
    schedDepHour: z.number().int().min(0).max(23),
  })
  .strict()
  .refine((body) => body.origin !== body.dest, {
    path: ['dest'],
    message: 'dest must differ from origin',
  });
export type PredictRequest = z.infer<typeof PredictRequestSchema>;

/** The historical-rate features a top factor can be. */
export const RATE_FEATURES = [
  'airlineRate',
  'originRate',
  'destRate',
  'originHourRate',
  'routeRate',
] as const;

/**
 * One rate feature's contribution, by occlusion: impact = p - p', where p' is the model's
 * probability with this rate replaced by the network-wide train delay rate (baseline).
 */
export const TopFactorSchema = z.object({
  feature: z.enum(RATE_FEATURES),
  value: z.number(),
  baseline: z.number(),
  impact: z.number(),
});
export type TopFactor = z.infer<typeof TopFactorSchema>;

export const PredictResponseSchema = z.object({
  probability: z.number().min(0).max(1),
  label: z.enum(['delayed', 'on-time']),
  threshold: z.number(),
  modelVersion: z.string(),
  /** What the server derived for this flight (route data and calendar). */
  derived: z.object({
    dayOfWeek: z.number().int(),
    isHolidayWeek: z.boolean(),
    distance: z.number(),
    scheduledTime: z.number().nullable(),
  }),
  topFactors: z.array(TopFactorSchema),
});
export type PredictResponse = z.infer<typeof PredictResponseSchema>;
