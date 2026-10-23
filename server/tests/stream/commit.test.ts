import { describe, expect, it } from 'vitest';
import {
  CommitNotConfirmed,
  commitAndConfirm,
  type CommitClient,
} from '../../src/stream/commit.js';

const target = { topic: 'flights.raw', partition: 1, offset: '2302' };
const opts = { timeoutMs: 5_000, sleep: () => Promise.resolve() };

/**
 * A fake of the client: `commitOffsets` resolves as soon as the commit is queued, like
 * @confluentinc/kafka-javascript 1.11.0 (librdkafka commitAsync); whether the broker stored it is
 * decided separately by `stores`.
 */
function fakeClient(options: {
  stores: boolean;
  before?: string;
  committed?: CommitClient['committed'];
}): CommitClient & { calls: string[] } {
  let brokerOffset = options.before ?? '2202';
  const calls: string[] = [];
  return {
    calls,
    async commitOffsets(offsets) {
      calls.push(`commit ${offsets[0]?.offset}`);
      if (options.stores) brokerOffset = offsets[0]!.offset;
    },
    committed:
      options.committed ??
      (async (partitions, timeoutMs) => {
        calls.push(`committed ${timeoutMs}`);
        return partitions.map((p) => ({ ...p, offset: brokerOffset }));
      }),
  };
}

describe('commitAndConfirm', () => {
  it('returns once the broker holds the committed offset', async () => {
    const client = fakeClient({ stores: true });
    await commitAndConfirm(client, target, opts);
    expect(client.calls).toEqual(['commit 2302', 'committed 5000']);
  });

  it('fails when the commit resolved but the broker kept the old offset (run R1)', async () => {
    const client = fakeClient({ stores: false });
    const failure = commitAndConfirm(client, target, opts);
    await expect(failure).rejects.toBeInstanceOf(CommitNotConfirmed);
    await expect(failure).rejects.toThrow(/flights\.raw\[1\].*2302.*2202 after 3 reads/);
    // Three reads, then it gives up.
    expect(client.calls.filter((c) => c.startsWith('committed'))).toHaveLength(3);
  });

  it('reads again when the queued commit has not reached the broker yet', async () => {
    const answers = ['2202', '2302'];
    const client = fakeClient({
      stores: false,
      committed: async (partitions) => partitions.map((p) => ({ ...p, offset: answers.shift()! })),
    });
    await expect(commitAndConfirm(client, target, opts)).resolves.toBeUndefined();
    expect(answers).toEqual([]);
  });

  it('fails with CommitNotConfirmed, not a parse error, on a non-numeric offset', async () => {
    const odd = fakeClient({ stores: false, before: 'abc' });
    await expect(commitAndConfirm(odd, target, opts)).rejects.toBeInstanceOf(CommitNotConfirmed);
    await expect(
      commitAndConfirm(fakeClient({ stores: true }), { ...target, offset: 'x' }, opts),
    ).rejects.toThrow(/not an integer offset/);
  });

  it('fails when the broker cannot be asked (broker down: the read times out)', async () => {
    const client = fakeClient({
      stores: false,
      committed: () => Promise.reject(new Error('Local: Timed out')),
    });
    const failure = commitAndConfirm(client, target, opts);
    await expect(failure).rejects.toBeInstanceOf(CommitNotConfirmed);
    await expect(failure).rejects.toThrow(/Local: Timed out/);
  });

  it('fails when the commit itself is refused', async () => {
    const client: CommitClient = {
      commitOffsets: () => Promise.reject(new Error('Commit can only be called while connected.')),
      committed: () => Promise.resolve([]),
    };
    await expect(commitAndConfirm(client, target, opts)).rejects.toThrow(/while connected/);
  });

  it('fails when the broker answers without the partition, or with no offset', async () => {
    const missing = fakeClient({ stores: true, committed: async () => [] });
    await expect(commitAndConfirm(missing, target, opts)).rejects.toThrow(/no committed offset/);
    const none = fakeClient({ stores: false, before: '-1001' });
    await expect(commitAndConfirm(none, target, opts)).rejects.toThrow(/-1001/);
  });

  it('accepts an offset already past ours (a later commit for the same partition)', async () => {
    const client = fakeClient({ stores: false, before: '2402' });
    await expect(commitAndConfirm(client, target, opts)).resolves.toBeUndefined();
  });

  it('compares offsets as integers, not strings', async () => {
    const client = fakeClient({ stores: false, before: '10000' });
    await expect(
      commitAndConfirm(client, { ...target, offset: '9999' }, opts),
    ).resolves.toBeUndefined();
  });
});
