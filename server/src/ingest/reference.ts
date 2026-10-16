import { z } from 'zod';
import type { AirlineDoc, AirportDoc } from '../db/collections.js';

const AirlineRowSchema = z.object({ IATA_CODE: z.string(), AIRLINE: z.string() });

const AirportRowSchema = z.object({
  IATA_CODE: z.string(),
  AIRPORT: z.string(),
  CITY: z.string(),
  STATE: z.string(),
  COUNTRY: z.string(),
  LATITUDE: z.string(),
  LONGITUDE: z.string(),
});

/** Collapses whitespace runs, including the non-breaking spaces in airports.csv, to one space. */
function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function textOrNull(value: string): string | null {
  const cleaned = cleanText(value);
  return cleaned === '' ? null : cleaned;
}

function coordinate(value: string): number | null {
  const trimmed = value.trim();
  const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `airlines.csv` row -> reference document, or null when the row has no IATA code. */
export function transformAirlineRow(raw: unknown): AirlineDoc | null {
  const parsed = AirlineRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const code = parsed.data.IATA_CODE.trim();
  const name = cleanText(parsed.data.AIRLINE);
  return code === '' || name === '' ? null : { _id: code, name };
}

/** `airports.csv` row -> reference document, or null when the row has no IATA code. */
export function transformAirportRow(raw: unknown): AirportDoc | null {
  const parsed = AirportRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  const code = row.IATA_CODE.trim();
  if (code === '') return null;
  return {
    _id: code,
    name: cleanText(row.AIRPORT),
    city: textOrNull(row.CITY),
    state: textOrNull(row.STATE),
    country: textOrNull(row.COUNTRY),
    latitude: coordinate(row.LATITUDE),
    longitude: coordinate(row.LONGITUDE),
  };
}
