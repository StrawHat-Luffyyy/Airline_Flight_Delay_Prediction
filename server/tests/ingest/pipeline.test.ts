import { describe, expect, it } from 'vitest';
import { parseIngestArgs } from '../../src/ingest/args.js';
import { inBatches } from '../../src/ingest/batch.js';
import { transformAirlineRow, transformAirportRow } from '../../src/ingest/reference.js';

async function* count(n: number): AsyncGenerator<number> {
  for (let i = 0; i < n; i += 1) yield i;
}

describe('inBatches', () => {
  it('yields full batches then the remainder, never more than the batch size', async () => {
    const sizes: number[] = [];
    for await (const batch of inBatches(count(25_001), 10_000)) sizes.push(batch.length);
    expect(sizes).toEqual([10_000, 10_000, 5_001]);
  });

  it('does not read past the current batch until the consumer asks for more', async () => {
    let produced = 0;
    async function* tracked(): AsyncGenerator<number> {
      for (let i = 0; i < 100; i += 1) {
        produced += 1;
        yield i;
      }
    }
    const batches = inBatches(tracked(), 10);
    await batches.next();
    expect(produced).toBe(10);
    await batches.return(undefined);
  });

  it('yields nothing for an empty source', async () => {
    const sizes: number[] = [];
    for await (const batch of inBatches(count(0), 10_000)) sizes.push(batch.length);
    expect(sizes).toEqual([]);
  });
});

describe('reference rows', () => {
  it('maps airlines.csv rows', () => {
    expect(transformAirlineRow({ IATA_CODE: 'AA', AIRLINE: 'American Airlines Inc.' })).toEqual({
      _id: 'AA',
      name: 'American Airlines Inc.',
    });
    expect(transformAirlineRow({ IATA_CODE: '', AIRLINE: 'x' })).toBeNull();
  });

  it('maps airports.csv rows and keeps blank coordinates as null', () => {
    expect(
      transformAirportRow({
        IATA_CODE: 'ECP',
        AIRPORT: 'Northwest Florida Beaches International Airport',
        CITY: 'Panama City',
        STATE: 'FL',
        COUNTRY: 'USA',
        LATITUDE: '',
        LONGITUDE: '',
      }),
    ).toEqual({
      _id: 'ECP',
      name: 'Northwest Florida Beaches International Airport',
      city: 'Panama City',
      state: 'FL',
      country: 'USA',
      latitude: null,
      longitude: null,
    });
  });
});

describe('parseIngestArgs', () => {
  it('defaults to a fresh load that refuses a non-empty collection', () => {
    expect(parseIngestArgs([])).toEqual({ mode: 'fresh', limit: undefined, dir: undefined });
  });

  it('accepts --drop, --append, --limit and --dir', () => {
    expect(parseIngestArgs(['--drop', '--limit', '1000'])).toMatchObject({
      mode: 'drop',
      limit: 1000,
    });
    expect(parseIngestArgs(['--append', '--dir', 'D:/data'])).toMatchObject({
      mode: 'append',
      dir: 'D:/data',
    });
  });

  it('rejects conflicting or unknown flags', () => {
    expect(() => parseIngestArgs(['--drop', '--append'])).toThrow(/either --drop or --append/);
    expect(() => parseIngestArgs(['--limit', '0'])).toThrow(/--limit/);
    expect(() => parseIngestArgs(['--force'])).toThrow(/Unknown argument/);
  });
});
