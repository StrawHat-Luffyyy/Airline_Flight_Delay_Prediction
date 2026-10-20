import { z } from 'zod';

/**
 * The Phase 8 speed layer's event contract (PROJECT_OVERVIEW §15.4). Pre-departure fields and the
 * actual outcome live in separate sub-objects, so the leakage boundary is structural: the scorer
 * only ever receives a projection of `pre`.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** IATA code, or the 5-digit BTS id the source uses for some (October) rows. */
const AIRPORT = /^(?:[A-Z0-9]{3}|\d{5})$/;
const AIRLINE = /^[A-Z0-9]{2}$/;

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Only what is known before departure. Strict: an outcome field here is a schema error. */
export const PreDepartureSchema = z
  .object({
    date: z.string().regex(ISO_DATE).refine(isRealDate, 'not a real date'),
    airline: z.string().regex(AIRLINE),
    flightNumber: z.number().int().positive(),
    origin: z.string().regex(AIRPORT),
    dest: z.string().regex(AIRPORT),
    /** Minutes from midnight, 0-1439 (the source's 2400 is stored as 0). */
    schedDepMin: z.number().int().min(0).max(1439),
    schedDepHour: z.number().int().min(0).max(23),
  })
  .strict();
export type PreDeparture = z.infer<typeof PreDepartureSchema>;

/** What actually happened. Read only after a prediction has been made. */
export const FlightOutcomeSchema = z
  .object({
    depDelay: z.number().nullable(),
    arrDelay: z.number().nullable(),
    /** arrDelay >= 15; null when cancelled, diverted or the arrival delay is unknown. */
    isDelayed: z.boolean().nullable(),
    cancelled: z.boolean(),
    diverted: z.boolean(),
  })
  .strict();
export type FlightOutcome = z.infer<typeof FlightOutcomeSchema>;

/**
 * The deterministic flight key: one scheduled departure. Re-delivered or re-replayed events map
 * to the same key, which is the MongoDB `_id` of `stream_flights` (idempotent upserts).
 */
export function flightKey(
  pre: Pick<PreDeparture, 'date' | 'airline' | 'flightNumber' | 'origin' | 'schedDepMin'>,
): string {
  return [pre.date, pre.airline, pre.flightNumber, pre.origin, pre.schedDepMin].join('|');
}

export const FlightEventSchema = z
  .object({
    v: z.literal(1),
    key: z.string().min(1),
    /** One replay invocation. */
    runId: z.string().min(1),
    /** Epoch ms, set by the producer at send time. */
    producedAt: z.number().int().positive(),
    pre: PreDepartureSchema,
    outcome: FlightOutcomeSchema,
  })
  .strict()
  .refine((event) => event.key === flightKey(event.pre), {
    message: 'key does not match the pre-departure fields',
    path: ['key'],
  });
export type FlightEvent = z.infer<typeof FlightEventSchema>;

/** A dead-lettered event: why it was rejected, by whom, and enough to find or replay it. */
export const DlqMessageSchema = z
  .object({
    v: z.literal(1),
    source: z.enum(['producer', 'consumer']),
    reason: z.string().min(1),
    runId: z.string().min(1).optional(),
    /** Epoch ms when it was dead-lettered. */
    at: z.number().int().positive(),
    /** Producer: the raw CSV row the transformer rejected. */
    row: z.record(z.string(), z.string()).optional(),
    /** Consumer: where the bad message sat, and its raw value. */
    topic: z.string().optional(),
    partition: z.number().int().min(0).optional(),
    offset: z.string().optional(),
    value: z.string().optional(),
  })
  .strict();
export type DlqMessage = z.infer<typeof DlqMessageSchema>;
