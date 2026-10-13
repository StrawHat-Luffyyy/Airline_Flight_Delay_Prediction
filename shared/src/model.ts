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
});
export type ModelRun = z.infer<typeof ModelRunSchema>;
