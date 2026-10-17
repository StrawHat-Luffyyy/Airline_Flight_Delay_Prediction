import {
  PredictRequestSchema,
  RATE_FEATURES,
  type MetaResponse,
  type PredictRequest,
  type PredictResponse,
  type TopFactor,
} from '@flight-delay/shared';
import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { z } from 'zod';
import { ApiError } from '../api/client';
import { useMeta, usePredict, useRoutes } from '../api/hooks';
import { QueryState, Skeleton } from '../components/QueryState';
import { FIELD_CLASS, Note, PageHeader, SelectField } from '../components/ui';
import {
  dayName,
  formatDuration,
  formatInteger,
  formatPercent,
  formatPoints,
  hourRangeLabel,
} from '../lib/format';
import { FACTOR_LABELS } from '../lib/labels';
import { seedForm, type FormState } from '../lib/predictForm';

const MIN_DATE = '2015-01-01';
const MAX_DATE = '2015-12-31';
const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

type FieldName = 'date' | 'airline' | 'origin' | 'dest' | 'schedDepHour';
type FieldErrors = Partial<Record<FieldName, string>>;

function validate(form: FormState): { errors: FieldErrors; ok: boolean } {
  const parsed = PredictRequestSchema.safeParse({
    date: form.date,
    airline: form.airline,
    origin: form.origin,
    dest: form.dest,
    schedDepHour: form.hour === '' ? Number.NaN : Number(form.hour),
  });
  const errors: FieldErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string' && !(field in errors)) {
        errors[field as FieldName] = issue.message;
      }
    }
  } else if (form.date < MIN_DATE || form.date > MAX_DATE) {
    errors.date = 'The dataset only covers 2015.';
    return { errors, ok: false };
  }
  return { errors, ok: parsed.success };
}

const FieldIssuesSchema = z.array(z.object({ path: z.string(), message: z.string() }));
const FIELD_NAMES: readonly string[] = ['date', 'airline', 'origin', 'dest', 'schedDepHour'];

/** Map a 422 VALIDATION_ERROR's `details` onto the form fields. */
function serverFieldErrors(error: Error | null): FieldErrors {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_ERROR') return {};
  const issues = FieldIssuesSchema.safeParse(error.details);
  const errors: FieldErrors = {};
  if (!issues.success) return errors;
  for (const issue of issues.data) {
    if (FIELD_NAMES.includes(issue.path) && !(issue.path in errors)) {
      errors[issue.path as FieldName] = issue.message;
    }
  }
  return errors;
}

function describeError(error: Error): { title: string; body: string } {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK') {
      return {
        title: 'Cannot reach the API',
        body: 'The request did not get an answer. Check that the server is running, then try again.',
      };
    }
    if (error.code === 'VALIDATION_ERROR') {
      return { title: 'The server rejected the inputs', body: error.message };
    }
    if (error.code === 'UNKNOWN_CODE' || error.code === 'UNKNOWN_ROUTE') {
      return { title: 'The model has no data for that selection', body: error.message };
    }
    if (error.code === 'RATE_LIMITED') {
      return { title: 'Too many predictions in a row', body: error.message };
    }
    if (error.code === 'DATABASE_UNAVAILABLE') {
      return {
        title: 'The database is unavailable',
        body: 'Check that MongoDB is running (docker compose up -d mongo), then try again.',
      };
    }
    if (error.code === 'MODEL_UNAVAILABLE') {
      return {
        title: 'The model is not available',
        body: `${error.message} Try again once the server has loaded the model.`,
      };
    }
    return { title: 'The prediction failed', body: error.message };
  }
  return { title: 'The prediction failed', body: error.message };
}

// ---------- Gauge ----------

const GAUGE = { cx: 120, cy: 112, r: 92 } as const;

function pointOnArc(probability: number, radius: number) {
  const angle = Math.PI * (1 - probability);
  return {
    x: GAUGE.cx + radius * Math.cos(angle),
    y: GAUGE.cy - radius * Math.sin(angle),
  };
}

function Gauge({ result }: { result: PredictResponse }) {
  const delayed = result.label === 'delayed';
  const color = delayed ? 'var(--color-delayed)' : 'var(--color-ontime)';
  const start = pointOnArc(0, GAUGE.r);
  const end = pointOnArc(1, GAUGE.r);
  const arc = `M ${start.x} ${start.y} A ${GAUGE.r} ${GAUGE.r} 0 0 1 ${end.x} ${end.y}`;
  const tickInner = pointOnArc(result.threshold, GAUGE.r - 14);
  const tickOuter = pointOnArc(result.threshold, GAUGE.r + 12);
  const tickLabel = pointOnArc(result.threshold, GAUGE.r + 24);
  return (
    <figure className="m-0">
      <svg
        viewBox="0 0 240 150"
        role="img"
        aria-label={`Probability of arriving 15 or more minutes late: ${formatPercent(
          result.probability,
        )}. The decision threshold is ${formatPercent(result.threshold)}.`}
        className="mx-auto block w-full max-w-sm"
      >
        <path
          d={arc}
          pathLength={1}
          fill="none"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth={12}
          strokeLinecap="round"
        />
        <path
          d={arc}
          pathLength={1}
          fill="none"
          stroke={color}
          strokeWidth={12}
          strokeLinecap="round"
          strokeDasharray={`${Math.max(result.probability, 0.004)} 1`}
          style={{ transition: 'stroke-dasharray 0.9s var(--ease-out-expo)' }}
        />
        <line
          x1={tickInner.x}
          y1={tickInner.y}
          x2={tickOuter.x}
          y2={tickOuter.y}
          stroke="#f2f1ec"
          strokeWidth={2}
        />
        <text
          x={tickLabel.x}
          y={tickLabel.y}
          fill="#b9b8b3"
          fontSize={10}
          textAnchor="middle"
          className="num"
        >
          {formatPercent(result.threshold)}
        </text>
        <text
          x={GAUGE.cx}
          y={GAUGE.cy - 14}
          textAnchor="middle"
          fill={color}
          fontSize={44}
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {formatPercent(result.probability)}
        </text>
        <text x={GAUGE.cx} y={GAUGE.cy + 6} textAnchor="middle" fill="#b9b8b3" fontSize={11}>
          chance of arriving 15+ min late
        </text>
      </svg>
    </figure>
  );
}

// ---------- Factors ----------

function FactorRow({ factor, scale }: { factor: TopFactor; scale: number }) {
  const share = Math.min(1, Math.abs(factor.impact) / scale) * 50;
  const raises = factor.impact > 0;
  const lowers = factor.impact < 0;
  return (
    <li>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-[13px]">
        <span>{FACTOR_LABELS[factor.feature]}</span>
        <span className={`num ${raises ? 'text-delayed' : lowers ? 'text-ontime' : 'text-ink-2'}`}>
          {formatPoints(factor.impact)}
        </span>
      </div>
      <div className="relative mt-1.5 h-2 rounded-full bg-wash" aria-hidden="true">
        <span className="absolute inset-y-0 left-1/2 w-px bg-rule-strong" />
        <span
          className="absolute inset-y-0 rounded-full"
          style={{
            background: raises ? 'var(--color-delayed)' : 'var(--color-ontime)',
            width: `${share}%`,
            left: raises ? '50%' : `${50 - share}%`,
          }}
        />
      </div>
      <p className="num mt-1 text-[11px] text-ink-3">
        historical delay rate {formatPercent(factor.value)} · network average{' '}
        {formatPercent(factor.baseline)}
      </p>
    </li>
  );
}

function Result({ result }: { result: PredictResponse }) {
  const delayed = result.label === 'delayed';
  const factors = [...result.topFactors].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const scale = Math.max(0.01, ...factors.map((factor) => Math.abs(factor.impact)));
  const facts: [string, string][] = [
    ['Distance', `${formatInteger(result.derived.distance)} miles`],
    [
      'Scheduled block time',
      result.derived.scheduledTime === null ? '—' : formatDuration(result.derived.scheduledTime),
    ],
    ['Day of week', dayName(result.derived.dayOfWeek, false)],
    ['Holiday week', result.derived.isHolidayWeek ? 'Yes' : 'No'],
  ];
  return (
    <div className="space-y-8">
      <div>
        <Gauge result={result} />
        <p
          className={`display-num mt-2 text-center text-3xl ${
            delayed ? 'text-delayed' : 'text-ontime'
          }`}
        >
          {delayed ? 'Likely delayed' : 'Likely on time'}
        </p>
        <p className="mx-auto mt-2 max-w-[48ch] text-center text-[13px] leading-relaxed text-ink-2">
          The model flags a flight when the probability is at least{' '}
          <span className="num text-ink">{formatPercent(result.threshold)}</span>, a threshold
          chosen on validation data rather than 50%. This flight scored{' '}
          <span className="num text-ink">{formatPercent(result.probability)}</span>.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-rule py-4 sm:grid-cols-4">
        {facts.map(([term, value]) => (
          <div key={term}>
            <dt className="text-[11px] text-ink-3">{term}</dt>
            <dd className="num mt-0.5 text-[13px] text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      <div>
        <h3 className="font-display text-xl font-normal">What moved the score</h3>
        <p className="mb-4 mt-1 text-[12px] text-ink-3">
          <span className="text-delayed">Amber</span> raises the probability,{' '}
          <span className="text-ontime">blue</span> lowers it, in percentage points.
        </p>
        <ul className="space-y-4">
          {factors.map((factor) => (
            <FactorRow key={factor.feature} factor={factor} scale={scale} />
          ))}
        </ul>
        <div className="mt-4">
          <Note>
            Each impact comes from re-scoring the flight with that one rate replaced by the network
            average (occlusion). It is not SHAP. Model {result.modelVersion}.
          </Note>
        </div>
      </div>
    </div>
  );
}

// ---------- Form ----------

function PredictForm({
  meta,
  pending,
  serverErrors,
  onSubmit,
}: {
  meta: MetaResponse;
  pending: boolean;
  serverErrors: FieldErrors;
  onSubmit: (body: PredictRequest) => void;
}) {
  // A route picked on the landing globe arrives as ?origin=LGA&dest=CMH.
  const [params] = useSearchParams();
  const [form, setForm] = useState<FormState>(() =>
    seedForm(meta, { origin: params.get('origin'), dest: params.get('dest') }),
  );
  const [localErrors, setErrors] = useState<FieldErrors>({});
  const errors: FieldErrors = { ...serverErrors, ...localErrors };
  const airports = useMemo(
    () => [...meta.airports].sort((a, b) => a.code.localeCompare(b.code)),
    [meta.airports],
  );
  const airportNames = useMemo(
    () => new Map(meta.airports.map((airport) => [airport.code, airport.name])),
    [meta.airports],
  );

  // Only routes flown in 2015 can be scored (/predict needs their distance and schedule), so the
  // destination list comes from the origin's routes. A destination the new origin never flew to
  // falls back to that origin's busiest route.
  const routes = useRoutes(form.origin);
  const destinations = routes.data?.destinations ?? [];
  const dest = destinations.some((route) => route.dest === form.dest)
    ? form.dest
    : (destinations[0]?.dest ?? '');
  const routesReady = routes.isSuccess && dest !== '';

  const set = (field: keyof FormState) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const current = { ...form, dest };
    const { errors: found, ok } = validate(current);
    setErrors(found);
    if (ok && routesReady) onSubmit(toBody(current));
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <div>
        <label htmlFor="predict-date" className="mb-1.5 block text-[12px] text-ink-2">
          Flight date
        </label>
        <input
          id="predict-date"
          type="date"
          min={MIN_DATE}
          max={MAX_DATE}
          value={form.date}
          onChange={(event) => set('date')(event.target.value)}
          aria-invalid={errors.date ? true : undefined}
          aria-describedby={errors.date ? 'predict-date-error' : undefined}
          className={FIELD_CLASS}
        />
        {errors.date ? (
          <p id="predict-date-error" className="mt-1.5 text-[12px] text-cancelled">
            {errors.date}
          </p>
        ) : null}
      </div>

      <SelectField
        label="Airline"
        value={form.airline}
        onChange={(event) => set('airline')(event.target.value)}
        error={errors.airline}
      >
        {meta.airlines.map((airline) => (
          <option key={airline.code} value={airline.code}>
            {airline.code} {airline.name}
          </option>
        ))}
      </SelectField>

      <div className="space-y-5">
        <SelectField
          label="Origin"
          value={form.origin}
          onChange={(event) => set('origin')(event.target.value)}
          error={errors.origin}
        >
          {airports.map((airport) => (
            <option key={airport.code} value={airport.code}>
              {airport.code} {airport.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Destination"
          value={dest}
          onChange={(event) => set('dest')(event.target.value)}
          error={errors.dest}
          disabled={!routesReady}
        >
          {routesReady ? (
            destinations.map((route) => (
              <option key={route.dest} value={route.dest}>
                {route.dest} {airportNames.get(route.dest) ?? ''} · {formatInteger(route.flights)}{' '}
                flights
              </option>
            ))
          ) : (
            <option value="">
              {routes.isPending
                ? 'Loading routes…'
                : routes.isError
                  ? 'Routes unavailable'
                  : `No 2015 departures from ${form.origin}`}
            </option>
          )}
        </SelectField>
      </div>
      {routes.isError ? (
        <p className="-mt-2 text-[12px] text-cancelled" role="alert">
          Could not load the routes from {form.origin}: {routes.error.message}{' '}
          <button
            type="button"
            onClick={() => void routes.refetch()}
            className="text-ink underline underline-offset-2"
          >
            Retry
          </button>
        </p>
      ) : (
        <p className="-mt-2 text-[12px] text-ink-3">
          Destinations list only the routes flown from {form.origin} in 2015, busiest first (
          {routesReady ? formatInteger(destinations.length) : '…'}). Type a code to jump to it.
        </p>
      )}

      <SelectField
        label="Scheduled departure hour"
        value={form.hour}
        onChange={(event) => set('hour')(event.target.value)}
        error={errors.schedDepHour}
      >
        {HOURS.map((hour) => (
          <option key={hour} value={hour}>
            {hourRangeLabel(hour)}
          </option>
        ))}
      </SelectField>

      <button
        type="submit"
        disabled={pending || !routesReady}
        className="liquid-glass w-full rounded-full px-6 py-3 text-sm text-ink transition-colors disabled:opacity-60"
      >
        {pending ? 'Scoring…' : 'Score this flight'}
      </button>
    </form>
  );
}

function toBody(form: FormState): PredictRequest {
  return {
    date: form.date,
    airline: form.airline,
    origin: form.origin,
    dest: form.dest,
    schedDepHour: Number(form.hour),
  };
}

function resultSummary(
  pending: boolean,
  error: Error | null,
  result: PredictResponse | undefined,
): string {
  if (pending) return 'Scoring the flight';
  if (error) return describeError(error).title;
  if (result) {
    return `${result.label === 'delayed' ? 'Likely delayed' : 'Likely on time'}, ${formatPercent(
      result.probability,
    )}`;
  }
  return '';
}

export default function Predict() {
  const meta = useMeta();
  const predict = usePredict();
  const [lastBody, setLastBody] = useState<PredictRequest | null>(null);
  const submit = (body: PredictRequest) => {
    setLastBody(body);
    predict.mutate(body);
  };

  return (
    <div>
      <PageHeader title="Score a flight">
        Enter what is known before departure. The model returns the probability that the flight
        arrives 15 or more minutes late, using only the date, airline, route and scheduled hour.
      </PageHeader>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className="liquid-glass self-start rounded-3xl p-6 sm:p-8">
          <QueryState query={meta} label="airlines and airports" skeletonClass="h-96">
            {(data) => (
              <PredictForm
                meta={data}
                pending={predict.isPending}
                serverErrors={serverFieldErrors(predict.error)}
                onSubmit={submit}
              />
            )}
          </QueryState>
        </div>

        <div className="min-w-0">
          <p className="sr-only" role="status" aria-live="polite">
            {resultSummary(predict.isPending, predict.error, predict.data)}
          </p>
          {predict.isPending ? (
            <div>
              <Skeleton className="h-96" />
            </div>
          ) : predict.isError ? (
            <PredictError
              error={predict.error}
              onRetry={lastBody ? () => predict.mutate(lastBody) : undefined}
              onDismiss={() => predict.reset()}
            />
          ) : predict.data ? (
            <Result result={predict.data} />
          ) : (
            <div className="border-y border-rule py-8 text-sm text-ink-2">
              <p className="max-w-[55ch]">
                The result appears here: a probability, a label against the model&apos;s threshold,
                and the {RATE_FEATURES.length} historical rates that moved the score most.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PredictError({
  error,
  onRetry,
  onDismiss,
}: {
  error: Error;
  onRetry?: () => void;
  onDismiss: () => void;
}) {
  const { title, body } = describeError(error);
  return (
    <div role="alert" className="border-y border-rule py-6 text-sm">
      <p className="text-cancelled">{title}</p>
      <p className="mt-1 max-w-[65ch] text-ink-2">{body}</p>
      <div className="mt-3 flex gap-3">
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full border border-rule-strong px-4 py-1.5 hover:bg-wash"
          >
            Try again
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-full px-4 py-1.5 text-ink-2 hover:text-ink"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
