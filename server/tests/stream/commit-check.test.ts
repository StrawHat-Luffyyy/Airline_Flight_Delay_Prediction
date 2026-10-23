import { describe, expect, it } from 'vitest';
import { CommitLog, commitVerdict, type CommitSummary } from '../../src/stream/commit-check.js';

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe('CommitLog', () => {
  it('counts offsets delivered twice and commits made while the broker was down', () => {
    const log = new CommitLog();
    log.delivered(range(0, 100));
    log.delivered(range(100, 200));
    log.delivered(range(100, 200)); // redelivered
    log.commits.push(
      { t: 1, next: 100, brokerDown: false, outcome: 'resolved' },
      { t: 6, next: 200, brokerDown: true, outcome: 'resolved' },
      { t: 7, next: 200, brokerDown: true, outcome: 'rejected' },
    );
    expect(log.summary(200)).toEqual({
      messages: 200,
      delivered: 300,
      distinctOffsets: 200,
      deliveredTwice: 100,
      deliveredTwiceRange: [100, 199],
      commitsWhileDown: { total: 2, resolved: 1, rejected: 1 },
    });
  });
});

const summary = (overrides: Partial<CommitSummary>): CommitSummary => ({
  mode: 'confirmed',
  messages: 6000,
  delivered: 6100,
  distinctOffsets: 6000,
  deliveredTwice: 100,
  deliveredTwiceRange: [2002, 2101],
  commitsWhileDown: { total: 1, resolved: 0, rejected: 1 },
  batchSize: 100,
  partitions: 1,
  brokerCommitted: 6000,
  ...overrides,
});

describe('commitVerdict', () => {
  it('passes a confirmed run that refused every commit while the broker was down', () => {
    expect(commitVerdict(summary({}))).toEqual({ ok: true, failures: [] });
  });

  it('fails a confirmed run that believed a commit while the broker was down (run R1)', () => {
    const verdict = commitVerdict(
      summary({
        commitsWhileDown: { total: 38, resolved: 38, rejected: 0 },
        deliveredTwice: 3798,
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual([
      '38 commits were believed while the broker was down',
      '3798 offsets delivered twice, more than one batch per partition',
    ]);
  });

  it('passes a raw run only when it reproduces the defect', () => {
    const reproduced = summary({
      mode: 'raw',
      commitsWhileDown: { total: 38, resolved: 38, rejected: 0 },
      deliveredTwice: 3798,
    });
    expect(commitVerdict(reproduced).ok).toBe(true);
    const notReproduced = summary({ mode: 'raw' });
    expect(commitVerdict(notReproduced).failures).toEqual([
      'raw commits did not resolve while the broker was down: defect not reproduced',
    ]);
  });

  it('fails when a message was never delivered or the final offset was not committed', () => {
    const verdict = commitVerdict(summary({ distinctOffsets: 5900, brokerCommitted: 5900 }));
    expect(verdict.failures).toEqual([
      'delivered 5900 distinct offsets of 6000',
      'broker holds offset 5900, expected 6000',
    ]);
  });

  it('fails when the outage missed every commit (nothing was tested)', () => {
    const verdict = commitVerdict(
      summary({ commitsWhileDown: { total: 0, resolved: 0, rejected: 0 } }),
    );
    expect(verdict.failures).toEqual(['no commit was attempted while the broker was down']);
  });
});
