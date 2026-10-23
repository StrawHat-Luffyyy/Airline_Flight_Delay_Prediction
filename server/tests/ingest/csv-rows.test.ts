import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { csvRows } from '../../src/ingest/run.js';

const dir = mkdtempSync(join(tmpdir(), 'csv-rows-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function readAll(name: string, text: string, required: string[] = []): Promise<unknown[]> {
  const file = join(dir, name);
  writeFileSync(file, text);
  const rows: unknown[] = [];
  for await (const row of csvRows(file, required, () => undefined)) rows.push(row);
  return rows;
}

describe('csvRows', () => {
  it('reads records keyed by the header, with a BOM and blank lines', async () => {
    const rows = await readAll('plain.csv', '﻿IATA_CODE,AIRLINE\nAA,American\n\nUA,United\n', [
      'IATA_CODE',
    ]);
    expect(rows).toEqual([
      { IATA_CODE: 'AA', AIRLINE: 'American' },
      { IATA_CODE: 'UA', AIRLINE: 'United' },
    ]);
  });

  it('refuses a file missing a required column', async () => {
    await expect(readAll('missing.csv', 'AIRLINE\nAmerican\n', ['IATA_CODE'])).rejects.toThrow(
      /missing columns: IATA_CODE/,
    );
  });

  // GHSA-8cw4-87c7-c6xx (csv-parse < 7.0.2): a "__proto__" header reached the record's prototype
  // through the columns path. The column must be an ordinary field and the prototype untouched.
  it('keeps a __proto__ header as a plain field, never the record prototype', async () => {
    const rows = await readAll('proto.csv', 'A,__proto__\n1,x\n');
    expect(rows).toHaveLength(1);
    const record = rows[0] as Record<string, unknown>;
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toBe('x');
    expect(record.A).toBe('1');
  });
});
