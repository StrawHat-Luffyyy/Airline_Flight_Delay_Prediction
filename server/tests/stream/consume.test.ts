import { DlqMessageSchema, flightKey, type FlightEvent } from '@flight-delay/shared';
import { describe, expect, it } from 'vitest';
import {
  decodeBatch,
  handleBatch,
  MAX_DLQ_VALUE,
  type BatchDeps,
} from '../../src/stream/consume.js';

const pre = {
  date: '2015-12-21',
  airline: 'AA',
  flightNumber: 1234,
  origin: 'ORD',
  dest: 'LAX',
  schedDepMin: 1050,
  schedDepHour: 17,
};
function event(flightNumber: number): FlightEvent {
  const p = { ...pre, flightNumber };
  return {
    v: 1,
    key: flightKey(p),
    runId: 'run-1',
    producedAt: 1_700_000_000_000,
    pre: p,
    outcome: { depDelay: 3, arrDelay: 10, isDelayed: false, cancelled: false, diverted: false },
  };
}
const message = (offset: string, value: string | null) => ({
  offset,
  value: value === null ? null : Buffer.from(value),
});
const ctx = { topic: 'flights.raw', partition: 1, now: 1_700_000_000_500 };

describe('decodeBatch', () => {
  it('turns valid messages into events and commits the offset after the last one', () => {
    const decoded = decodeBatch(
      [message('10', JSON.stringify(event(1))), message('11', JSON.stringify(event(2)))],
      ctx,
    );
    expect(decoded.events.map((e) => e.pre.flightNumber)).toEqual([1, 2]);
    expect(decoded.dlq).toEqual([]);
    expect(decoded.commitOffset).toBe('12');
  });

  it('keeps the message each event came from, in event order, skipping dead letters', () => {
    const decoded = decodeBatch(
      [
        message('10', JSON.stringify(event(1))),
        message('11', 'bad'),
        message('12', JSON.stringify(event(2))),
      ],
      ctx,
    );
    expect(decoded.sources).toEqual([
      { topic: 'flights.raw', partition: 1, offset: '10' },
      { topic: 'flights.raw', partition: 1, offset: '12' },
    ]);
  });

  it('dead-letters empty, non-JSON and schema-invalid messages with a reason and their coordinates', () => {
    const forged = { ...event(3), key: 'forged' };
    const leaked = { ...event(4), pre: { ...event(4).pre, arrDelay: 10 } };
    const decoded = decodeBatch(
      [
        message('20', null),
        message('21', '{not json'),
        message('22', JSON.stringify(forged)),
        message('23', JSON.stringify(leaked)),
        message('24', JSON.stringify(event(5))),
      ],
      ctx,
    );
    expect(decoded.events.map((e) => e.pre.flightNumber)).toEqual([5]);
    expect(decoded.dlq.map((d) => [d.offset, d.reason])).toEqual([
      ['20', 'empty_value'],
      ['21', 'invalid_json'],
      ['22', 'invalid_event: key'],
      ['23', 'invalid_event: pre'],
    ]);
    for (const dlq of decoded.dlq) {
      expect(DlqMessageSchema.parse(dlq)).toMatchObject({
        v: 1,
        source: 'consumer',
        topic: 'flights.raw',
        partition: 1,
        at: ctx.now,
      });
    }
    expect(decoded.dlq[1]?.value).toBe('{not json');
    expect(decoded.commitOffset).toBe('25');
  });

  it('still commits past a batch that was entirely dead-lettered', () => {
    expect(decodeBatch([message('7', 'x')], ctx).commitOffset).toBe('8');
  });

  it('commits nothing for an empty batch', () => {
    expect(decodeBatch([], ctx)).toEqual({ events: [], sources: [], dlq: [], commitOffset: null });
  });
});

/** Fakes that record the order of side effects. */
function recorder(overrides: Partial<BatchDeps> = {}) {
  const calls: string[] = [];
  const deps: BatchDeps = {
    async write(events, sources) {
      calls.push(`write:${events.length}@${sources.map((s) => s.offset).join(',')}`);
      return { inserted: events.length, redelivered: 0 };
    },
    async sendDlq(messages) {
      calls.push(`dlq:${messages.length}`);
    },
    async commit(offset) {
      calls.push(`commit:${offset}`);
    },
    ...overrides,
  };
  return { calls, deps };
}

describe('handleBatch', () => {
  const batch = [
    message('30', JSON.stringify(event(1))),
    message('31', 'bad'),
    message('32', JSON.stringify(event(2))),
  ];

  it('writes to MongoDB, then dead-letters, then commits: never commits first', async () => {
    const { calls, deps } = recorder();
    const result = await handleBatch(batch, ctx, deps);
    expect(calls).toEqual(['write:2@30,32', 'dlq:1', 'commit:33']);
    expect(result).toEqual({ consumed: 3, inserted: 2, redelivered: 0, dlq: 1 });
  });

  it('does not commit when the MongoDB write fails, so the batch is redelivered', async () => {
    const { calls, deps } = recorder({
      async write() {
        throw new Error('MongoServerSelectionError');
      },
    });
    await expect(handleBatch(batch, ctx, deps)).rejects.toThrow(/MongoServerSelectionError/);
    expect(calls).toEqual([]);
  });

  it('does not commit when the DLQ send fails', async () => {
    const { calls, deps } = recorder({
      async sendDlq() {
        throw new Error('Broker: Request timed out');
      },
    });
    await expect(handleBatch(batch, ctx, deps)).rejects.toThrow(/timed out/);
    expect(calls).toEqual(['write:2@30,32']);
  });

  it('skips the write and the DLQ when there is nothing for them, but still commits', async () => {
    const { calls, deps } = recorder();
    await handleBatch([message('40', JSON.stringify(event(9)))], ctx, deps);
    expect(calls).toEqual(['write:1@40', 'commit:41']);
    calls.length = 0;
    await handleBatch([message('41', '')], ctx, deps);
    expect(calls).toEqual(['dlq:1', 'commit:42']);
  });
});

describe('dead-letter size', () => {
  it('caps the raw value kept in a DLQ entry', () => {
    const huge = 'x'.repeat(MAX_DLQ_VALUE * 3);
    const [entry] = decodeBatch([message('1', huge)], ctx).dlq;
    expect(entry?.value).toHaveLength(MAX_DLQ_VALUE);
  });
});
