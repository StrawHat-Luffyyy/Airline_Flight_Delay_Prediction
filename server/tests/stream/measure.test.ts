import { describe, expect, it } from 'vitest';
import {
  checkRun,
  parseMeasureArgs,
  runStatsPipeline,
  type RunReport,
} from '../../src/stream/measure.js';

describe('runStatsPipeline', () => {
  it('reads only the run through its runId index, then summarises it in one group', () => {
    const pipeline = runStatsPipeline('run-7');
    expect(pipeline[0]).toEqual({ $match: { runId: 'run-7' } });
    expect(pipeline).toHaveLength(2);
    const group = (pipeline[1] as { $group: Record<string, unknown> }).$group;
    expect(group.latency).toEqual({
      $percentile: {
        input: { $subtract: ['$firstWrittenAt', '$producedAt'] },
        p: [0.5, 0.95, 0.99],
        method: 'approximate',
      },
    });
  });
});

/** A clean completed run: 1,000 rows of the month, all sent and all stored once. */
function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'run-1',
    producer: {
      status: 'completed',
      rate: 500,
      limit: 1000,
      monthRows: 1000,
      sentRaw: 1000,
      sentDlq: 0,
      malformedCsv: 0,
      sendElapsedMs: 2000,
      achievedRate: 500,
      elapsedMs: 70000,
      peakRssMb: 130,
    },
    kafka: { rawRetained: 1000, dlqRetained: 0, lag: 0 },
    stored: { flights: 1000, flightsOfRun: 1000, deliveries: 1000, scored: 1000, refused: 0 },
    timing: null,
    sinceReset: { producerRuns: 1, sentRaw: 1000, sentDlq: 0, largestRun: 1000 },
    ...overrides,
  };
}

const verdict = (r: RunReport, name: string) => {
  const found = checkRun(r).find((c) => c.name === name);
  if (!found) throw new Error(`no check ${name}`);
  return found.ok;
};

describe('checkRun', () => {
  it('passes every check for a clean run', () => {
    expect(checkRun(report()).every((c) => c.ok)).toBe(true);
  });

  it('fails conservation when month rows are not all accounted for', () => {
    const r = report({ producer: { ...report().producer, sentRaw: 999 } });
    expect(verdict(r, 'month rows = sent to raw + producer DLQ')).toBe(false);
  });

  it('fails conservation when a message on the topic was neither stored nor dead-lettered', () => {
    const r = report({
      stored: { ...report().stored, deliveries: 999, flights: 999, flightsOfRun: 999 },
    });
    expect(verdict(r, 'raw messages = upserts + consumer DLQ')).toBe(false);
  });

  it('accepts extra deliveries from a crash (at-least-once) but never a missing one', () => {
    // A hard kill between write and commit redelivers part of a batch: more upserts, same flights.
    const crashed = report({ stored: { ...report().stored, deliveries: 1200 } });
    expect(verdict(crashed, 'raw messages = upserts + consumer DLQ')).toBe(true);
    expect(verdict(crashed, 'stored flights = distinct keys produced')).toBe(true);
  });

  it('fails the unique-key check when a flight is stored twice or lost', () => {
    const r = report({ stored: { ...report().stored, flights: 1001 } });
    expect(verdict(r, 'stored flights = distinct keys produced')).toBe(false);
  });

  it('requires the consumer to have caught up', () => {
    expect(verdict(report({ kafka: { ...report().kafka, lag: 5 } }), 'consumer lag = 0')).toBe(
      false,
    );
  });
});

describe('checkRun with dead-lettered messages', () => {
  it('counts a dead-lettered message as accounted for, not lost', () => {
    // 1,000 sent; one malformed message dead-lettered by the consumer; 999 stored.
    const r = report({
      kafka: { rawRetained: 1000, dlqRetained: 1, lag: 0 },
      stored: { ...report().stored, flights: 999, flightsOfRun: 999, deliveries: 999 },
    });
    expect(verdict(r, 'raw messages = upserts + consumer DLQ')).toBe(true);
    expect(verdict(r, 'stored flights = distinct keys produced')).toBe(true);
  });

  it('fails when the DLQ holds fewer messages than the producer sent there', () => {
    const r = report({
      producer: { ...report().producer, sentRaw: 998, sentDlq: 2 },
      kafka: { rawRetained: 998, dlqRetained: 1, lag: 0 },
      sinceReset: { producerRuns: 1, sentRaw: 998, sentDlq: 2, largestRun: 998 },
      stored: { ...report().stored, flights: 998, flightsOfRun: 998, deliveries: 998 },
    });
    expect(verdict(r, 'raw messages = upserts + consumer DLQ')).toBe(false);
  });

  it('fails when the raw topic does not hold exactly what was sent', () => {
    const r = report({ kafka: { ...report().kafka, rawRetained: 1001 } });
    expect(verdict(r, 'raw topic holds exactly what was sent')).toBe(false);
  });

  it('does not guess distinct keys when several runs share a dead-lettered row', () => {
    // Runs of 1,000 and 500 events, one bad row in the shared first 500: dead-lettered twice.
    const r = report({
      producer: { ...report().producer, monthRows: 500, sentRaw: 500, limit: 500 },
      kafka: { rawRetained: 1500, dlqRetained: 2, lag: 0 },
      stored: { ...report().stored, flights: 999, flightsOfRun: 0, deliveries: 1498 },
      sinceReset: { producerRuns: 2, sentRaw: 1500, sentDlq: 0, largestRun: 1000 },
    });
    const check = checkRun(r).find((c) => c.name === 'stored flights = distinct keys produced');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain('n/a');
  });

  it('reports redeliveries as information', () => {
    const r = report({ stored: { ...report().stored, deliveries: 1200 } });
    const info = checkRun(r).find((c) => c.name === 'redeliveries (information)');
    expect(info).toMatchObject({
      ok: true,
      detail: '200 upserts beyond the messages on the topic',
    });
  });
});

describe('parseMeasureArgs', () => {
  it('reads --run and --out, in either form', () => {
    expect(parseMeasureArgs(['--run', 'r1', '--out=x.json'])).toEqual({
      runId: 'r1',
      out: 'x.json',
    });
    expect(parseMeasureArgs([])).toEqual({});
  });

  it('rejects unknown flags and a flag where a value belongs', () => {
    expect(() => parseMeasureArgs(['--runs', 'x'])).toThrow();
    expect(() => parseMeasureArgs(['--run', '--out', 'x.json'])).toThrow();
  });
});
