import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createIsolatedProbe, type ProbeChild } from '../../src/stream/status/isolated-probe.js';
import type { KafkaSnapshot } from '../../src/stream/status/kafka-probe.js';

const UP: KafkaSnapshot = {
  reachable: true,
  reason: null,
  lag: { total: 2, partitions: [{ partition: 0, committed: 8, end: 10, lag: 2 }] },
  dlqMessages: 0,
};

const TOPICS_MISSING: KafkaSnapshot = {
  reachable: true,
  reason: 'topic flights.raw does not exist: run npm run kafka:init',
  lag: null,
  dlqMessages: null,
};

type Behaviour = 'answer' | 'topicsMissing' | 'crash' | 'hang' | 'garbage';

/** A stand-in for the forked probe process: answers, crashes (exit), hangs or sends junk. */
function fakeChild(behaviour: () => Behaviour): ProbeChild & { sent: unknown[] } {
  const child = new EventEmitter() as EventEmitter & ProbeChild & { sent: unknown[] };
  child.sent = [];
  child.connected = true;
  child.send = (message: unknown) => {
    child.sent.push(message);
    const { id } = message as { id: number };
    const mode = behaviour();
    setTimeout(() => {
      if (mode === 'answer') child.emit('message', { id, snapshot: UP });
      if (mode === 'topicsMissing') child.emit('message', { id, snapshot: TOPICS_MISSING });
      if (mode === 'garbage') child.emit('message', { id, snapshot: { reachable: 'yes' } });
      if (mode === 'crash') {
        child.connected = false;
        // 0xC0000005: the Windows access violation measured from librdkafka.
        child.emit('exit', 3221225477, null);
      }
    }, 5);
    return true;
  };
  child.disconnect = vi.fn(() => {
    child.connected = false;
  });
  return child;
}

describe('createIsolatedProbe', () => {
  it('returns the snapshot the probe process sends back', async () => {
    const probe = createIsolatedProbe({ spawn: () => fakeChild(() => 'answer'), timeoutMs: 200 });
    expect(await probe.read()).toEqual(UP);
    expect(probe.lastKnown()).toEqual(UP);
  });

  it('passes on "reachable, topics missing" (a crossing every snapshot shape must survive)', async () => {
    const probe = createIsolatedProbe({
      spawn: () => fakeChild(() => 'topicsMissing'),
      timeoutMs: 200,
    });
    expect(await probe.read()).toEqual(TOPICS_MISSING);
  });

  it('reports a crash of the probe process as unreachable, without crashing the API', async () => {
    const probe = createIsolatedProbe({ spawn: () => fakeChild(() => 'crash'), timeoutMs: 200 });
    const snapshot = await probe.read();
    expect(snapshot).toMatchObject({ reachable: false, lag: null, dlqMessages: null });
    expect(snapshot.reason).toContain('Kafka probe process exited (code 3221225477)');
  });

  it('starts a fresh probe process on the read after a crash', async () => {
    const modes: Behaviour[] = ['crash', 'answer'];
    const spawn = vi.fn(() => fakeChild(() => modes.shift() ?? 'answer'));
    const probe = createIsolatedProbe({ spawn, timeoutMs: 200 });
    expect((await probe.read()).reachable).toBe(false);
    expect((await probe.read()).reachable).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('never hangs: a probe process that does not answer times out', async () => {
    const probe = createIsolatedProbe({ spawn: () => fakeChild(() => 'hang'), timeoutMs: 40 });
    const started = Date.now();
    const snapshot = await probe.read();
    expect(Date.now() - started).toBeLessThan(500);
    expect(snapshot.reason).toContain('timed out after 40 ms');
  });

  it('ignores a malformed answer instead of passing it on', async () => {
    const probe = createIsolatedProbe({ spawn: () => fakeChild(() => 'garbage'), timeoutMs: 40 });
    expect((await probe.read()).reachable).toBe(false);
  });

  it('shares one request between concurrent reads, and reuses the process', async () => {
    const child = fakeChild(() => 'answer');
    const spawn = vi.fn(() => child);
    const probe = createIsolatedProbe({ spawn, timeoutMs: 200 });
    await Promise.all([probe.read(), probe.read()]);
    await probe.read();
    expect(child.sent).toHaveLength(2);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('disconnects the probe process on close, which makes it exit', async () => {
    const child = fakeChild(() => 'answer');
    const probe = createIsolatedProbe({ spawn: () => child, timeoutMs: 200 });
    await probe.read();
    await probe.close();
    expect(child.disconnect).toHaveBeenCalledOnce();
  });
});
