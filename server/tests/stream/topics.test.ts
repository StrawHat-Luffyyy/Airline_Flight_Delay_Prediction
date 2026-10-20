import { describe, expect, it } from 'vitest';
import { initTopics, planTopics, topicSpecs, type TopicAdmin } from '../../src/stream/topics.js';

const specs = topicSpecs({ raw: 'flights.raw', dlq: 'flights.dlq' });

/** An in-memory broker: topic name -> partition count. */
function fakeAdmin(initial: Record<string, number> = {}) {
  const topics = new Map(Object.entries(initial));
  const created: string[][] = [];
  const admin: TopicAdmin = {
    async listTopics() {
      return [...topics.keys()];
    },
    async fetchTopicMetadata({ topics: names }) {
      return names.map((name) => ({
        name,
        partitions: Array.from({ length: topics.get(name) ?? 0 }, (_, partitionId) => ({
          partitionId,
        })),
      }));
    },
    async createTopics({ topics: wanted }) {
      created.push(wanted.map((spec) => spec.topic));
      for (const spec of wanted) topics.set(spec.topic, spec.numPartitions);
      return wanted.length > 0;
    },
  };
  return { admin, topics, created };
}

describe('topicSpecs', () => {
  it('declares flights.raw with 3 partitions and the DLQ with 1, both replication factor 1', () => {
    expect(specs).toEqual([
      { topic: 'flights.raw', numPartitions: 3, replicationFactor: 1 },
      { topic: 'flights.dlq', numPartitions: 1, replicationFactor: 1 },
    ]);
  });
});

describe('planTopics', () => {
  it('creates what is missing, keeps what matches, and flags a wrong partition count', () => {
    const plan = planTopics(specs, new Map([['flights.dlq', 4]]));
    expect(plan.create.map((spec) => spec.topic)).toEqual(['flights.raw']);
    expect(plan.ok).toEqual([]);
    expect(plan.mismatched).toEqual([{ topic: 'flights.dlq', expected: 1, actual: 4 }]);
  });
});

describe('initTopics', () => {
  it('creates both topics on an empty broker', async () => {
    const { admin, topics } = fakeAdmin();
    const result = await initTopics(admin, specs);
    expect(result).toEqual({ created: ['flights.raw', 'flights.dlq'], existing: [] });
    expect(Object.fromEntries(topics)).toEqual({ 'flights.raw': 3, 'flights.dlq': 1 });
  });

  it('is idempotent: a second run creates nothing', async () => {
    const { admin, created } = fakeAdmin();
    await initTopics(admin, specs);
    const second = await initTopics(admin, specs);
    expect(second).toEqual({ created: [], existing: ['flights.raw', 'flights.dlq'] });
    expect(created).toHaveLength(1);
  });

  it('ignores unrelated topics', async () => {
    const { admin } = fakeAdmin({ __consumer_offsets: 50, 'flights.raw': 3 });
    expect(await initTopics(admin, specs)).toEqual({
      created: ['flights.dlq'],
      existing: ['flights.raw'],
    });
  });

  it('fails loudly, creating nothing, when an existing topic has the wrong partition count', async () => {
    const { admin, created } = fakeAdmin({ 'flights.raw': 1 });
    await expect(initTopics(admin, specs)).rejects.toThrow(
      /flights\.raw has 1 partition.*expected 3/,
    );
    expect(created).toHaveLength(0);
  });

  it('fails if a created topic does not come back with the expected partitions', async () => {
    const { admin, topics } = fakeAdmin();
    const lossy: TopicAdmin = {
      ...admin,
      async createTopics(options) {
        await admin.createTopics(options);
        topics.set('flights.raw', 2);
        return true;
      },
    };
    await expect(initTopics(lossy, specs)).rejects.toThrow(/flights\.raw has 2 partition/);
  });

  it('retries while a new topic propagates (metadata errors, then the topic appears)', async () => {
    const { admin } = fakeAdmin();
    let calls = 0;
    const slow: TopicAdmin = {
      ...admin,
      async fetchTopicMetadata(options) {
        calls += 1;
        if (calls <= 2) throw new Error('Broker: Unknown topic or partition');
        return admin.fetchTopicMetadata(options);
      },
    };
    const sleeps: number[] = [];
    const result = await initTopics(slow, specs, {
      delayMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.created).toEqual(['flights.raw', 'flights.dlq']);
    expect(sleeps).toEqual([5, 5]);
  });

  it('gives up after the last attempt if the topic never appears', async () => {
    const { admin } = fakeAdmin();
    const never: TopicAdmin = {
      ...admin,
      async fetchTopicMetadata() {
        throw new Error('Broker: Unknown topic or partition');
      },
    };
    await expect(
      initTopics(never, specs, { attempts: 3, sleep: async () => undefined }),
    ).rejects.toThrow(/Unknown topic/);
  });

  it('treats "already exists" from a concurrent run as success when the topic checks out', async () => {
    const { admin, topics } = fakeAdmin();
    const raced: TopicAdmin = {
      ...admin,
      async createTopics({ topics: wanted }) {
        for (const spec of wanted) topics.set(spec.topic, spec.numPartitions);
        throw new Error('Topic already exists');
      },
    };
    const result = await initTopics(raced, specs, { sleep: async () => undefined });
    expect(result.created).toEqual(['flights.raw', 'flights.dlq']);
  });

  it('rethrows the create error when the topics never appear', async () => {
    const { admin } = fakeAdmin();
    const broken: TopicAdmin = {
      ...admin,
      async createTopics() {
        throw new Error('Broker: Policy violation');
      },
    };
    await expect(
      initTopics(broken, specs, { attempts: 2, sleep: async () => undefined }),
    ).rejects.toThrow(/Policy violation/);
  });
});
