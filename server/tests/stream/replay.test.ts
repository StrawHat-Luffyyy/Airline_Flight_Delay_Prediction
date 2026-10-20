import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DlqMessageSchema, FlightEventSchema } from '@flight-delay/shared';
import { afterAll, describe, expect, it } from 'vitest';
import type { ReferenceData } from '../../src/ingest/transform.js';
import {
  createReplaySummary,
  replayMonth,
  type EventSink,
  type OutboundMessage,
} from '../../src/stream/replay.js';

const HEADER = [
  'YEAR',
  'MONTH',
  'DAY',
  'DAY_OF_WEEK',
  'AIRLINE',
  'FLIGHT_NUMBER',
  'TAIL_NUMBER',
  'ORIGIN_AIRPORT',
  'DESTINATION_AIRPORT',
  'SCHEDULED_DEPARTURE',
  'DEPARTURE_TIME',
  'DEPARTURE_DELAY',
  'TAXI_OUT',
  'WHEELS_OFF',
  'SCHEDULED_TIME',
  'ELAPSED_TIME',
  'AIR_TIME',
  'DISTANCE',
  'WHEELS_ON',
  'TAXI_IN',
  'SCHEDULED_ARRIVAL',
  'ARRIVAL_TIME',
  'ARRIVAL_DELAY',
  'DIVERTED',
  'CANCELLED',
  'CANCELLATION_REASON',
  'AIR_SYSTEM_DELAY',
  'SECURITY_DELAY',
  'AIRLINE_DELAY',
  'LATE_AIRCRAFT_DELAY',
  'WEATHER_DELAY',
];

function line(o: Partial<Record<string, string>> = {}): string {
  const base: Record<string, string> = {
    YEAR: '2015',
    MONTH: '12',
    DAY: '21',
    DAY_OF_WEEK: '1',
    AIRLINE: 'AA',
    FLIGHT_NUMBER: '1',
    TAIL_NUMBER: 'N1',
    ORIGIN_AIRPORT: 'ORD',
    DESTINATION_AIRPORT: 'LAX',
    SCHEDULED_DEPARTURE: '1730',
    DEPARTURE_TIME: '1730',
    DEPARTURE_DELAY: '0',
    TAXI_OUT: '10',
    WHEELS_OFF: '1740',
    SCHEDULED_TIME: '275',
    ELAPSED_TIME: '270',
    AIR_TIME: '250',
    DISTANCE: '1744',
    WHEELS_ON: '2000',
    TAXI_IN: '5',
    SCHEDULED_ARRIVAL: '2005',
    ARRIVAL_TIME: '2005',
    ARRIVAL_DELAY: '0',
    DIVERTED: '0',
    CANCELLED: '0',
    CANCELLATION_REASON: '',
    AIR_SYSTEM_DELAY: '',
    SECURITY_DELAY: '',
    AIRLINE_DELAY: '',
    LATE_AIRCRAFT_DELAY: '',
    WEATHER_DELAY: '',
  };
  const row = { ...base, ...o };
  return HEADER.map((column) => row[column] ?? '').join(',');
}

const dir = mkdtempSync(join(tmpdir(), 'replay-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
  join(dir, 'flights.csv'),
  [
    HEADER.join(','),
    line({ MONTH: '11', FLIGHT_NUMBER: '900' }), // another month: skipped, never sent
    line({ FLIGHT_NUMBER: '1', ORIGIN_AIRPORT: 'ORD' }),
    line({ FLIGHT_NUMBER: '2', ORIGIN_AIRPORT: 'LAX', DESTINATION_AIRPORT: 'ORD' }),
    line({ FLIGHT_NUMBER: '3', AIRLINE: 'ZZ' }), // unknown airline -> DLQ
    line({ FLIGHT_NUMBER: '4', ARRIVAL_DELAY: '45', DEPARTURE_DELAY: '40' }),
    line({ FLIGHT_NUMBER: '5', SCHEDULED_DEPARTURE: '9999' }), // bad HHMM -> DLQ
  ].join('\n') + '\n',
);

const refs: ReferenceData = {
  airlines: new Map([['AA', 'American Airlines Inc.']]),
  airports: new Map([
    ['ORD', { city: 'Chicago', state: 'IL' }],
    ['LAX', { city: 'Los Angeles', state: 'CA' }],
  ]),
};

function recordingSink() {
  const sent: { topic: string; messages: OutboundMessage[] }[] = [];
  const sink: EventSink = {
    async send(topic, messages) {
      sent.push({ topic, messages: [...messages] });
    },
  };
  const on = (topic: string) => sent.filter((s) => s.topic === topic).flatMap((s) => s.messages);
  return { sink, sent, on };
}

const topics = { raw: 'flights.raw', dlq: 'flights.dlq' };
const clock = { now: () => 0, sleep: async () => undefined };

describe('replayMonth', () => {
  it('sends every month row to flights.raw or the DLQ, keyed by origin, and nothing else', async () => {
    const { sink, on } = recordingSink();
    const summary = await replayMonth(
      { month: 12, rate: 0, limit: undefined, dir },
      { sink, refs, topics, runId: 'run-t', clock, epochNow: () => 1_700_000_000_000 },
    );

    expect(summary).toMatchObject({
      rowsScanned: 6,
      monthRows: 5,
      sentRaw: 3,
      sentDlq: 2,
      malformedCsv: 0,
      dlqReasons: { unknown_airline: 1, invalid_scheduled_departure: 1 },
    });
    // Conservation: every row of the month went somewhere.
    expect(summary.sentRaw + summary.sentDlq).toBe(summary.monthRows);

    const raw = on('flights.raw');
    expect(raw.map((m) => m.key)).toEqual(['ORD', 'LAX', 'ORD']);
    const events = raw.map((m) => FlightEventSchema.parse(JSON.parse(m.value)));
    expect(events.map((e) => e.pre.flightNumber)).toEqual([1, 2, 4]);
    expect(events.every((e) => e.runId === 'run-t' && e.producedAt === 1_700_000_000_000)).toBe(
      true,
    );
    expect(events[2]?.outcome).toMatchObject({ arrDelay: 45, isDelayed: true });

    const dlq = on('flights.dlq').map((m) => DlqMessageSchema.parse(JSON.parse(m.value)));
    expect(dlq.map((m) => [m.source, m.reason, m.row?.FLIGHT_NUMBER])).toEqual([
      ['producer', 'unknown_airline', '3'],
      ['producer', 'invalid_scheduled_departure', '5'],
    ]);
  });

  it('stops after --limit rows of the month', async () => {
    const { sink } = recordingSink();
    const summary = await replayMonth(
      { month: 12, rate: 0, limit: 2, dir },
      { sink, refs, topics, runId: 'run-l', clock, epochNow: () => 1 },
    );
    expect(summary).toMatchObject({ monthRows: 2, sentRaw: 2, sentDlq: 0 });
  });

  it('sends nothing for a month with no rows', async () => {
    const { sink, sent } = recordingSink();
    const summary = await replayMonth(
      { month: 3, rate: 0, limit: undefined, dir },
      { sink, refs, topics, runId: 'run-e', clock, epochNow: () => 1 },
    );
    expect(summary).toMatchObject({ rowsScanned: 6, monthRows: 0, sentRaw: 0, sentDlq: 0 });
    expect(sent).toEqual([]);
  });

  it('stops early, flushing what it has, when aborted', async () => {
    const { sink, on } = recordingSink();
    const controller = new AbortController();
    controller.abort();
    const summary = await replayMonth(
      { month: 12, rate: 0, limit: undefined, dir },
      { sink, refs, topics, runId: 'run-a', clock, epochNow: () => 1, signal: controller.signal },
    );
    expect(summary.interrupted).toBe(true);
    expect(summary.sentRaw + summary.sentDlq).toBe(summary.monthRows);
    expect(on('flights.raw').length).toBe(summary.sentRaw);
  });

  it('does not count a batch the broker rejected as sent', async () => {
    const failing: EventSink = {
      async send() {
        throw new Error('Broker: Not enough in-sync replicas');
      },
    };
    await expect(
      replayMonth(
        { month: 12, rate: 0, limit: undefined, dir },
        { sink: failing, refs, topics, runId: 'run-f', clock, epochNow: () => 1 },
      ),
    ).rejects.toThrow(/in-sync replicas/);
  });

  it('times the send phase from the first row of the month, not from the start of the file', async () => {
    const { sink } = recordingSink();
    let t = 0;
    const ticking = { now: () => (t += 10), sleep: async () => undefined };
    const summary = await replayMonth(
      { month: 12, rate: 0, limit: undefined, dir },
      { sink, refs, topics, runId: 'run-c', clock: ticking, epochNow: () => 1 },
    );
    expect(summary.sendElapsedMs).toBeGreaterThan(0);
    expect(summary.sendElapsedMs).toBeLessThan(summary.elapsedMs);
  });

  it('leaves the caller what the broker acknowledged when a later send fails', async () => {
    let calls = 0;
    const flaky: EventSink = {
      async send() {
        calls += 1;
        if (calls > 1) throw new Error('Broker: Request timed out');
      },
    };
    const summary = createReplaySummary('run-p');
    await expect(
      replayMonth(
        { month: 12, rate: 1, limit: undefined, dir },
        { sink: flaky, refs, topics, runId: 'run-p', clock, epochNow: () => 1, summary },
      ),
    ).rejects.toThrow(/timed out/);
    // rate 1 sends one event per batch: the first was acknowledged, the second failed.
    expect(summary.sentRaw).toBe(1);
  });

  it('stops reading as soon as the limit is met', async () => {
    const { sink } = recordingSink();
    const summary = await replayMonth(
      { month: 12, rate: 0, limit: 5, dir },
      { sink, refs, topics, runId: 'run-s', clock, epochNow: () => 1 },
    );
    // Five December rows exist and are the last five lines: nothing after them is needed, and
    // with limit 5 the November row and all five December rows are read, no more.
    expect(summary).toMatchObject({ rowsScanned: 6, monthRows: 5 });
  });
});
