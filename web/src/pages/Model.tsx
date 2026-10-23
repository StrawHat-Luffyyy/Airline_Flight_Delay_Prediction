import type {
  Evaluation,
  ModelMetricsResponse,
  ModelRun,
  OperatingPoint,
} from '@flight-delay/shared';
import type { ReactNode } from 'react';
import type { ApiError } from '../api/client';
import { useFeatureImportance, useModelMetrics } from '../api/hooks';
import { Board, RateCell, type BoardColumn } from '../components/Board';
import { QueryState } from '../components/QueryState';
import { Note, PageHeader, Section } from '../components/ui';
import { formatDate, formatInteger, formatPercent, monthName } from '../lib/format';
import { ALGORITHM_LABELS, featureLabel } from '../lib/labels';
import { flaggedShare, liftOverBaseRate } from '../lib/selection';

function modelHint(error: ApiError): string | undefined {
  if (error.code === 'MODEL_NOT_REGISTERED') {
    return 'No trained model has been registered yet. Train one and run npm run ml:register.';
  }
  if (error.status === 503) {
    return 'The server could not serve the model. Check the API logs and try again.';
  }
  return undefined;
}

interface ModelRow {
  key: 'baseline' | 'logistic_regression' | 'lightgbm';
  name: string;
  validation: Evaluation;
  test: Evaluation;
}

function modelRows(run: ModelMetricsResponse): ModelRow[] {
  return [
    { key: 'baseline', name: 'Baseline (constant)', ...pick(run.models.baseline) },
    {
      key: 'logistic_regression',
      name: 'Logistic regression',
      ...pick(run.models.logisticRegression),
    },
    { key: 'lightgbm', name: 'LightGBM', ...pick(run.models.lightgbm) },
  ];
}

function pick(result: { validation: Evaluation; test: Evaluation }) {
  return { validation: result.validation, test: result.test };
}

const fixed3 = (value: number) => value.toFixed(3);

const HIDE_ON_MOBILE = 'hidden sm:table-cell';

function comparisonColumns(chosen: string): BoardColumn<ModelRow>[] {
  return [
    {
      id: 'model',
      header: 'Model',
      rowHeader: true,
      cell: (row) => (
        <span className="font-sans">
          {row.name}
          {row.key === chosen ? (
            <span className="ml-2 rounded-full bg-ink px-2 py-0.5 text-[10px] text-ground">
              served
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'valAuc',
      header: 'Validation AUC',
      align: 'right',
      className: HIDE_ON_MOBILE,
      cell: (row) => fixed3(row.validation.auc),
    },
    {
      id: 'testAuc',
      header: 'Test AUC',
      align: 'right',
      cell: (row) => <span className="font-medium text-ink">{fixed3(row.test.auc)}</span>,
    },
    {
      id: 'pr',
      header: 'PR-AUC',
      align: 'right',
      className: HIDE_ON_MOBILE,
      cell: (row) => fixed3(row.test.prAuc),
    },
    {
      id: 'precision',
      header: 'Precision',
      align: 'right',
      className: HIDE_ON_MOBILE,
      cell: (row) => fixed3(row.test.precision),
    },
    {
      id: 'recall',
      header: 'Recall',
      align: 'right',
      className: HIDE_ON_MOBILE,
      cell: (row) => fixed3(row.test.recall),
    },
    { id: 'f1', header: 'F1', align: 'right', cell: (row) => fixed3(row.test.f1) },
    {
      id: 'flagged',
      header: 'Share flagged',
      align: 'right',
      className: HIDE_ON_MOBILE,
      cell: (row) => formatPercent(flaggedShare(row.test.confusion)),
    },
    {
      id: 'lift',
      header: 'Lift',
      align: 'right',
      cell: (row) => formatLift(liftOverBaseRate(row.test.confusion)),
    },
  ];
}

const formatLift = (value: number | null) => (value === null ? '—' : `${value.toFixed(2)}×`);

/** What a flag is worth at the deployed threshold, in words, from the test confusion. */
function ThresholdVerdict({ run }: { run: ModelMetricsResponse }) {
  const { confusion } = run.metrics;
  const share = flaggedShare(confusion);
  const lift = liftOverBaseRate(confusion);
  const baseRate = run.classBalance.testDelayRate;
  const n = (text: string) => <span className="num text-ink">{text}</span>;
  return (
    <div className="max-w-[65ch] space-y-3 text-[14px] leading-relaxed text-ink-2">
      <p>
        At the deployed threshold ({n(run.threshold.value.toFixed(3))}) the model flags{' '}
        {n(formatPercent(share))} of test flights as delayed, while {n(formatPercent(baseRate))}{' '}
        actually were. Of the flagged flights {n(formatPercent(run.metrics.precision))} were
        delayed: a lift of only {n(formatLift(lift))} over the base rate. The threshold maximises
        F1, so it buys recall ({n(formatPercent(run.metrics.recall))} of delays caught) by flagging
        widely, and a single flag says little more than the base rate does.
      </p>
    </div>
  );
}

interface PointRow extends OperatingPoint {
  deployed: boolean;
}

const pointColumns: BoardColumn<PointRow>[] = [
  {
    id: 'rule',
    header: 'Flag',
    rowHeader: true,
    cell: (row) => (
      <span className="font-sans">
        {row.deployed ? 'Deployed threshold' : `Top ${row.rule.replace('top ', '')}`}
      </span>
    ),
  },
  {
    id: 'share',
    header: 'Share flagged',
    align: 'right',
    cell: (row) => formatPercent(row.flaggedShare),
  },
  {
    id: 'minScore',
    header: 'Lowest score',
    align: 'right',
    className: HIDE_ON_MOBILE,
    cell: (row) => fixed3(row.minScore),
  },
  {
    id: 'precision',
    header: 'Precision',
    align: 'right',
    cell: (row) => fixed3(row.precision),
  },
  { id: 'recall', header: 'Recall', align: 'right', cell: (row) => fixed3(row.recall) },
  {
    id: 'lift',
    header: 'Lift',
    align: 'right',
    cell: (row) => <span className="font-medium text-ink">{formatLift(row.lift)}</span>,
  },
];

function OperatingPoints({ points }: { points: ModelRun['operatingPoints'] }) {
  if (points === undefined) {
    return (
      <Note>
        Not computed for this model yet. Run ml/train.py --operating-points, then npm run
        ml:register.
      </Note>
    );
  }
  const rows: PointRow[] = [
    ...points.points.map((point) => ({ ...point, deployed: false })),
    { ...points.deployed, deployed: true },
  ].sort((a, b) => a.flaggedShare - b.flaggedShare);
  return (
    <>
      <Board
        rows={rows}
        getKey={(row) => row.rule}
        columns={pointColumns}
        caption="Precision, recall and lift on September validation if the model flagged its top-scored flights"
        showRank={false}
        selectedKey={points.deployed.rule}
        animate={false}
      />
      <div className="mt-3">
        <Note>
          Computed on September validation only ({formatInteger(points.rows)} flights,{' '}
          {formatPercent(points.baseRate)} delayed), with the scores of the January to August model
          the threshold was chosen on. No test or December data. Like every validation figure it is
          slightly optimistic (see Training setup). Flagging fewer flights raises precision and lift
          but catches fewer delays.
        </Note>
      </div>
    </>
  );
}

function ConfusionMatrix({ confusion }: { confusion: Evaluation['confusion'] }) {
  const { tn, fp, fn, tp } = confusion;
  const negatives = tn + fp;
  const positives = fn + tp;
  const cells = [
    {
      id: 'tn',
      label: 'On time, predicted on time',
      count: tn,
      rate: negatives ? tn / negatives : null,
      flagged: false,
    },
    {
      id: 'fp',
      label: 'On time, flagged delayed',
      count: fp,
      rate: negatives ? fp / negatives : null,
      flagged: true,
    },
    {
      id: 'fn',
      label: 'Delayed, predicted on time',
      count: fn,
      rate: positives ? fn / positives : null,
      flagged: false,
    },
    {
      id: 'tp',
      label: 'Delayed, flagged delayed',
      count: tp,
      rate: positives ? tp / positives : null,
      flagged: true,
    },
  ];
  return (
    <div>
      <div className="grid grid-cols-[72px_1fr_1fr] gap-1.5 text-[12px]">
        <span />
        <span className="pb-1 text-center text-ink-3">Predicted on time</span>
        <span className="pb-1 text-center text-ink-3">Predicted delayed</span>
        <span className="flex items-center text-ink-3">Actually on time</span>
        <Cell cell={cells[0]} />
        <Cell cell={cells[1]} />
        <span className="flex items-center text-ink-3">Actually delayed</span>
        <Cell cell={cells[2]} />
        <Cell cell={cells[3]} />
      </div>
      <p className="mt-3 text-[12px] text-ink-3">
        Test set at the chosen threshold. Percentages are of each row (actual outcome).
      </p>
    </div>
  );
}

function Cell({
  cell,
}: {
  cell: { label: string; count: number; rate: number | null; flagged: boolean } | undefined;
}) {
  if (!cell) return <span />;
  const alpha = 0.08 + 0.5 * (cell.rate ?? 0);
  // Tinted by the prediction (amber = flagged delayed, blue = predicted on time), like every
  // other delayed/on-time encoding in the app; intensity is the share of the actual row.
  const rgb = cell.flagged ? '232,165,75' : '124,155,209';
  return (
    <div
      className="rounded-md px-3 py-4 text-center"
      style={{ background: `rgba(${rgb},${alpha})` }}
      role="group"
      aria-label={`${cell.label}: ${formatInteger(cell.count)} flights, ${formatPercent(cell.rate)} of the row`}
    >
      <p className="num text-lg text-ink">{formatInteger(cell.count)}</p>
      <p className="num text-[12px] text-ink-2">{formatPercent(cell.rate)}</p>
    </div>
  );
}

function Facts({ run }: { run: ModelMetricsResponse }) {
  const validationMonth = monthName(`2015-${String(run.validation.month).padStart(2, '0')}`);
  const n = (text: string) => <span className="num">{text}</span>;
  const arrow = '→';
  const rows: [string, ReactNode][] = [
    [
      'Train',
      <>
        {n(`${run.trainRange.from} ${arrow} ${run.trainRange.to}`)} ·{' '}
        {n(formatInteger(run.trainRange.rows))} flights
      </>,
    ],
    [
      'Validation',
      <>
        {validationMonth} · {n(formatInteger(run.validation.rows))} flights · used for{' '}
        {run.validation.usedFor}
      </>,
    ],
    [
      'Test',
      <>
        {n(`${run.testRange.from} ${arrow} ${run.testRange.to}`)} ·{' '}
        {n(formatInteger(run.testRange.rows))} flights
      </>,
    ],
    [
      'Class balance',
      <>
        {n(formatPercent(run.classBalance.trainDelayRate))} delayed in train,{' '}
        {n(formatPercent(run.classBalance.testDelayRate))} in test
      </>,
    ],
    [
      'Threshold',
      <>
        {n(run.threshold.value.toFixed(4))} · chosen on {run.threshold.chosenOn} ·{' '}
        {run.threshold.criterion}
      </>,
    ],
    [
      'Excluded',
      <>
        {n(formatInteger(run.excluded.noOutcome))} flights without an arrival outcome,{' '}
        {n(formatInteger(run.excluded.unresolvedAirport))} with an unresolved airport
      </>,
    ],
    ['Model version', n(run.modelVersion)],
    ['Trained', n(formatDate(run.createdAt))],
  ];
  return (
    <dl className="divide-y divide-rule border-y border-rule text-[13px]">
      {rows.map(([term, value]) => (
        <div key={term} className="grid gap-x-6 gap-y-0.5 py-2.5 sm:grid-cols-[110px_1fr]">
          <dt className="text-ink-3">{term}</dt>
          <dd className="break-words text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Ceiling({ run }: { run: ModelMetricsResponse }) {
  return (
    <div className="max-w-[65ch] space-y-3 text-[14px] leading-relaxed text-ink-2">
      <p>
        On the held-out test months the served model reaches a ROC-AUC of{' '}
        <span className="num text-ink">{fixed3(run.metrics.auc)}</span> (0.5 is a coin flip, 1.0 is
        perfect).
      </p>
      <p>
        The model only sees what is known before departure: the date, airline, route, scheduled hour
        and historical delay rates. Weather on the day and delays inherited from earlier flights are
        mostly known only after departure, so they are not features. A time-based split (train on
        earlier months, test on later ones) keeps seasonal patterns from leaking into the test
        score; the test months were {formatPercent(run.classBalance.testDelayRate)} delayed against{' '}
        {formatPercent(run.classBalance.trainDelayRate)} in training.
      </p>
    </div>
  );
}

function ModelOverview() {
  const metrics = useModelMetrics();
  return (
    <QueryState
      query={metrics}
      label="the model metrics"
      skeletonClass="h-[32rem]"
      hint={modelHint}
    >
      {(run) => (
        <div className="space-y-10">
          <Section
            title="Three models, one held-out test set"
            note={`Precision, recall, F1, PR-AUC, share flagged and lift are on the test months (${run.testRange.from} to ${run.testRange.to}) at each model's own threshold. Lift is precision divided by the share actually delayed. The baseline predicts the majority class, so it never flags a delay.`}
          >
            <Board
              rows={modelRows(run)}
              getKey={(row) => row.key}
              columns={comparisonColumns(run.algorithm)}
              caption="Baseline, logistic regression and LightGBM compared on validation and test data"
              showRank={false}
              selectedKey={run.algorithm}
              animate={false}
            />
            <div className="mt-3">
              <Note>
                Served model: {ALGORITHM_LABELS[run.algorithm] ?? run.algorithm}. Features:{' '}
                {run.featureList.map(featureLabel).join(', ')}.
              </Note>
            </div>
          </Section>

          <div className="grid gap-x-12 gap-y-10 lg:grid-cols-2">
            <Section title="Confusion matrix">
              <ConfusionMatrix confusion={run.metrics.confusion} />
            </Section>
            <Section title="Training setup">
              <Facts run={run} />
            </Section>
          </div>

          <Section title="What a flag is worth">
            <ThresholdVerdict run={run} />
          </Section>

          <Section
            title="Other cut-offs, on September validation"
            note="The same scores, flagging only the highest-scored flights."
          >
            <OperatingPoints points={run.operatingPoints} />
          </Section>

          <Section title="Why the ceiling">
            <Ceiling run={run} />
          </Section>
        </div>
      )}
    </QueryState>
  );
}

interface ImportanceRow {
  feature: string;
  label: string;
  importance: number;
}

function importanceColumns(max: number): BoardColumn<ImportanceRow>[] {
  return [
    {
      id: 'feature',
      header: 'Feature',
      rowHeader: true,
      cell: (row) => <span className="font-sans">{row.label}</span>,
    },
    {
      id: 'share',
      header: 'Share of gain',
      align: 'right',
      className: 'sm:min-w-44',
      cell: (row) => <RateCell value={row.importance} max={max} tone="ink" barOnMobile />,
    },
  ];
}

function FeatureImportance() {
  const importance = useFeatureImportance();
  return (
    <Section
      title="What the model relies on"
      note="Share of LightGBM's total split gain per feature."
    >
      <QueryState
        query={importance}
        label="feature importance"
        skeletonClass="h-96"
        hint={modelHint}
        isEmpty={(data) => data.features.length === 0}
      >
        {(data) => {
          const rows: ImportanceRow[] = [...data.features]
            .sort((a, b) => b.importance - a.importance)
            .map((feature) => ({
              feature: feature.feature,
              label: featureLabel(feature.feature),
              importance: feature.importance,
            }));
          const max = Math.max(...rows.map((row) => row.importance), 0);
          return (
            <Board
              rows={rows}
              getKey={(row) => row.feature}
              columns={importanceColumns(max)}
              caption="Model features ranked by share of LightGBM split gain"
              animate={false}
            />
          );
        }}
      </QueryState>
    </Section>
  );
}

export default function Model() {
  return (
    <div className="space-y-10">
      <PageHeader title="How good is the model?">
        Test-set results for the model that serves the Predict page, with the baselines it has to
        beat.
      </PageHeader>
      <ModelOverview />
      <FeatureImportance />
    </div>
  );
}
