import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import {
  checkResetTarget,
  parseResetArgs,
  resetStream,
  type ResetAdmin,
} from '../../src/stream/reset.js';

const topics = { raw: 'flights.raw', dlq: 'flights.dlq' };

function fakeDb() {
  const touched: string[] = [];
  const db = {
    collection: (name: string) => {
      touched.push(name);
      return {
        deleteMany: vi.fn(async () => ({ deletedCount: name === 'stream_flights' ? 5 : 2 })),
      };
    },
  } as unknown as Db;
  return { db, touched };
}

function fakeAdmin(members = 0, state = 5): ResetAdmin & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    describeGroups: vi.fn(async () => {
      calls.push('describeGroups');
      return {
        groups: [{ groupId: 'flight-stream', members: Array.from({ length: members }), state }],
      };
    }),
    deleteGroups: vi.fn(async () => {
      calls.push('deleteGroups');
      return [];
    }),
    fetchTopicOffsets: vi.fn(async (topic: string) =>
      topic === 'flights.raw'
        ? [
            { partition: 0, offset: '9', high: '9', low: '2' },
            { partition: 1, offset: '4', high: '4', low: '4' },
          ]
        : [{ partition: 0, offset: '0', high: '0', low: '0' }],
    ),
    deleteTopicRecords: vi.fn(async (options: { topic: string }) => {
      calls.push(`deleteTopicRecords:${options.topic}`);
      return [];
    }),
  } as unknown as ResetAdmin & { calls: string[] };
}

describe('checkResetTarget', () => {
  it('refuses unless the configured database is named and confirmed', () => {
    expect(() => checkResetTarget({ db: undefined, yes: true }, 'flight_delay')).toThrow(
      '--db flight_delay',
    );
    expect(() => checkResetTarget({ db: 'other_db', yes: true }, 'flight_delay')).toThrow(
      'Refusing to reset "other_db"',
    );
    expect(() => checkResetTarget({ db: 'flight_delay', yes: false }, 'flight_delay')).toThrow(
      '--yes',
    );
    expect(() => checkResetTarget({ db: 'flight_delay', yes: true }, 'flight_delay')).not.toThrow();
  });

  it('parses --db and --yes and rejects anything else', () => {
    expect(parseResetArgs(['--db', 'flight_delay', '--yes'])).toEqual({
      db: 'flight_delay',
      yes: true,
    });
    expect(() => parseResetArgs(['--drop-all'])).toThrow('Unknown argument');
  });
});

describe('resetStream', () => {
  it('clears only the stream collections, the group and the stream topics', async () => {
    const { db, touched } = fakeDb();
    const admin = fakeAdmin();
    const summary = await resetStream({
      db,
      admin,
      groupId: 'flight-stream',
      topics,
      timeoutMs: 100,
    });

    expect(touched.sort()).toEqual(['stream_flights', 'stream_stats']);
    expect(summary).toEqual({
      groupDeleted: true,
      recordsDeleted: { 'flights.raw': 7, 'flights.dlq': 0 },
      documentsDeleted: { stream_flights: 5, stream_stats: 2 },
    });
    // Only the non-empty partition is truncated, up to its end offset.
    expect(admin.deleteTopicRecords).toHaveBeenCalledOnce();
    expect(admin.deleteTopicRecords).toHaveBeenCalledWith({
      topic: 'flights.raw',
      partitions: [{ partition: 0, offset: '9' }],
      timeout: 100,
    });
  });

  it('refuses while a consumer is running, before clearing anything', async () => {
    const { db, touched } = fakeDb();
    const admin = fakeAdmin(1, 3);
    await expect(
      resetStream({ db, admin, groupId: 'flight-stream', topics, timeoutMs: 100 }),
    ).rejects.toThrow('Stop npm run stream:consume first');
    expect(touched).toEqual([]);
    expect(admin.calls).toEqual(['describeGroups']);
  });

  it('clears nothing in MongoDB when Kafka is unreachable', async () => {
    const { db, touched } = fakeDb();
    const admin = {
      ...fakeAdmin(),
      describeGroups: vi.fn(async () => {
        throw new Error('Broker transport failure');
      }),
    } as unknown as ResetAdmin;
    await expect(
      resetStream({ db, admin, groupId: 'flight-stream', topics, timeoutMs: 100 }),
    ).rejects.toThrow('Broker transport failure');
    expect(touched).toEqual([]);
  });

  it('skips deleting a group that does not exist', async () => {
    const { db } = fakeDb();
    const admin = fakeAdmin(0, 4);
    const summary = await resetStream({
      db,
      admin,
      groupId: 'flight-stream',
      topics,
      timeoutMs: 100,
    });
    expect(summary.groupDeleted).toBe(false);
    expect(admin.deleteGroups).not.toHaveBeenCalled();
  });
});
