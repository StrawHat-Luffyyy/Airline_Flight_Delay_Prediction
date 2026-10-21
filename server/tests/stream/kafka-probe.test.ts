import { describe, expect, it, vi } from 'vitest';
import { createKafkaProbe, type ProbeAdmin } from '../../src/stream/status/kafka-probe.js';

const topics = { raw: 'flights.raw', dlq: 'flights.dlq' };

function healthyAdmin(): ProbeAdmin {
  return {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    fetchOffsets: vi.fn(async () => [
      { topic: 'flights.raw', partitions: [{ partition: 0, offset: '7', metadata: null }] },
    ]),
    fetchTopicOffsets: vi.fn(async (topic: string) =>
      topic === 'flights.raw'
        ? [{ partition: 0, offset: '10', high: '10', low: '0' }]
        : [{ partition: 0, offset: '3', high: '3', low: '1' }],
    ),
  } as unknown as ProbeAdmin;
}

function deadAdmin(connect: () => Promise<void>): ProbeAdmin {
  return { ...healthyAdmin(), connect: vi.fn(connect) } as unknown as ProbeAdmin;
}

describe('createKafkaProbe', () => {
  it('reads lag and the DLQ size when Kafka answers', async () => {
    const probe = createKafkaProbe({
      createAdmin: healthyAdmin,
      groupId: 'g',
      topics,
      timeoutMs: 500,
      cacheMs: 0,
    });
    const snapshot = await probe.read();
    expect(snapshot).toEqual({
      reachable: true,
      reason: null,
      lag: { total: 3, partitions: [{ partition: 0, committed: 7, end: 10, lag: 3 }] },
      dlqMessages: 2,
    });
  });

  it('returns lag null with a reason when Kafka refuses the connection', async () => {
    const probe = createKafkaProbe({
      createAdmin: () => deadAdmin(() => Promise.reject(new Error('Broker transport failure'))),
      groupId: 'g',
      topics,
      timeoutMs: 500,
      cacheMs: 0,
    });
    expect(await probe.read()).toEqual({
      reachable: false,
      reason: 'Broker transport failure',
      lag: null,
      dlqMessages: null,
    });
  });

  it('never hangs: a call that never answers becomes unreachable after the timeout', async () => {
    const probe = createKafkaProbe({
      createAdmin: () => deadAdmin(() => new Promise<void>(() => undefined)),
      groupId: 'g',
      topics,
      timeoutMs: 50,
      cacheMs: 0,
    });
    const started = Date.now();
    const snapshot = await probe.read();
    expect(Date.now() - started).toBeLessThan(500);
    expect(snapshot.reachable).toBe(false);
    expect(snapshot.reason).toContain('timed out after 50 ms');
  });

  it('replaces the admin client only when its connect failed', async () => {
    let brokerUp = false;
    const createAdmin = vi.fn(() =>
      brokerUp ? healthyAdmin() : deadAdmin(() => Promise.reject(new Error('down'))),
    );
    const probe = createKafkaProbe({
      createAdmin,
      groupId: 'g',
      topics,
      timeoutMs: 200,
      cacheMs: 0,
    });
    expect((await probe.read()).reachable).toBe(false);
    brokerUp = true;
    expect((await probe.read()).reachable).toBe(true);
    expect(createAdmin).toHaveBeenCalledTimes(2);
  });

  it('reuses a result within the cache window', async () => {
    let clock = 0;
    const createAdmin = vi.fn(healthyAdmin);
    const probe = createKafkaProbe({
      createAdmin,
      groupId: 'g',
      topics,
      timeoutMs: 200,
      cacheMs: 2_000,
      now: () => clock,
    });
    const first = await probe.read();
    expect(probe.lastKnown()).toBe(first);
    clock = 1_999;
    expect(await probe.read()).toBe(first);
    clock = 2_000;
    expect(await probe.read()).not.toBe(first);
    // One admin client, kept connected across reads.
    expect(createAdmin).toHaveBeenCalledTimes(1);
  });

  // Regression: disconnecting a librdkafka client with requests in flight blocks the Node event loop
  // until those requests time out (measured ~0.8-2 s per read against a stopped broker), and
  // tearing down a client mid-connection is unsafe. A timeout must leave the client alone.
  it('neither disconnects nor replaces the admin client after a timeout', async () => {
    const admin = healthyAdmin();
    vi.mocked(admin.fetchOffsets).mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve([
                {
                  topic: 'flights.raw',
                  partitions: [{ partition: 0, offset: '7', metadata: null }],
                },
              ] as never),
            120,
          ),
        ),
    );
    const createAdmin = vi.fn(() => admin);
    const probe = createKafkaProbe({
      createAdmin,
      groupId: 'g',
      topics,
      timeoutMs: 50,
      cacheMs: 0,
    });

    expect((await probe.read()).reachable).toBe(false);
    expect(admin.disconnect).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 120));
    // The slow-but-healthy broker is reported up on the same client.
    expect((await probe.read()).reachable).toBe(true);
    expect(createAdmin).toHaveBeenCalledTimes(1);
    expect(admin.disconnect).not.toHaveBeenCalled();
  });

  // Regression: a librdkafka admin client that lost its broker kept failing every call for minutes
  // after the broker was back (measured with docker compose stop/start), while a fresh client
  // worked at once. A failed fetch therefore retires its client, but only once none of its calls
  // is pending, so the disconnect cannot block the event loop.
  it('replaces a client whose calls failed, disconnecting it only once idle', async () => {
    let pending = 0;
    const pendingAtDisconnect: number[] = [];
    const track = <T>(promise: Promise<T>): Promise<T> => {
      pending += 1;
      return promise.finally(() => {
        pending -= 1;
      });
    };
    const failing = {
      ...healthyAdmin(),
      fetchOffsets: vi.fn(() => track(Promise.reject(new Error('Local: Timed out')))),
      fetchTopicOffsets: vi.fn(() =>
        track(new Promise((_, reject) => setTimeout(() => reject(new Error('metadata')), 60))),
      ),
      disconnect: vi.fn(async () => {
        pendingAtDisconnect.push(pending);
      }),
    } as unknown as ProbeAdmin;
    const admins = [failing, healthyAdmin()];
    const createAdmin = vi.fn(() => admins.shift()!);
    const probe = createKafkaProbe({
      createAdmin,
      groupId: 'g',
      topics,
      timeoutMs: 500,
      cacheMs: 0,
    });

    expect((await probe.read()).reachable).toBe(false);
    expect(pendingAtDisconnect).toEqual([0]);
    expect((await probe.read()).reachable).toBe(true);
    expect(createAdmin).toHaveBeenCalledTimes(2);
  });

  it('never stacks requests: reads during a pending fetch reuse it', async () => {
    const admin = healthyAdmin();
    vi.mocked(admin.fetchOffsets).mockImplementation(() => new Promise(() => undefined));
    const probe = createKafkaProbe({
      createAdmin: () => admin,
      groupId: 'g',
      topics,
      timeoutMs: 30,
      cacheMs: 0,
    });
    await probe.read();
    await probe.read();
    await probe.read();
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(1);
  });

  it('keeps the lag when only the DLQ offsets fail', async () => {
    const admin = healthyAdmin();
    vi.mocked(admin.fetchTopicOffsets).mockImplementation(async (topic: string) => {
      if (topic === 'flights.dlq') throw new Error('Unknown topic or partition');
      return [{ partition: 0, offset: '10', high: '10', low: '0' }] as never;
    });
    const probe = createKafkaProbe({
      createAdmin: () => admin,
      groupId: 'g',
      topics,
      timeoutMs: 200,
      cacheMs: 0,
    });
    expect(await probe.read()).toMatchObject({
      reachable: true,
      lag: { total: 3 },
      dlqMessages: null,
    });
  });

  it('disconnects its client on close', async () => {
    const admin = healthyAdmin();
    const probe = createKafkaProbe({
      createAdmin: () => admin,
      groupId: 'g',
      topics,
      timeoutMs: 200,
      cacheMs: 0,
    });
    await probe.read();
    await probe.close();
    expect(admin.disconnect).toHaveBeenCalledOnce();
  });
});
