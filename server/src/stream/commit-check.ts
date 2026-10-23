/**
 * Bookkeeping and verdict for `stream:commit-check` (commit-check-cli.ts), which reproduces run R1's
 * lost commits against the real broker. Pure, so the verdict is unit-tested.
 */
export type CommitMode = 'raw' | 'confirmed';

export interface CommitRecord {
  /** Seconds since the check started. */
  t: number;
  /** The offset committed (next to read). */
  next: number;
  /** The broker container was fully stopped when the commit resolved or was rejected. */
  brokerDown: boolean;
  outcome: 'resolved' | 'rejected';
}

export class CommitLog {
  readonly commits: CommitRecord[] = [];
  private readonly seen = new Map<number, number>();

  /** One delivered batch, by its message offsets. */
  delivered(offsets: readonly number[]): void {
    for (const offset of offsets) this.seen.set(offset, (this.seen.get(offset) ?? 0) + 1);
  }

  summary(messages: number) {
    const down = this.commits.filter((c) => c.brokerDown);
    const twice = [...this.seen].filter(([, n]) => n > 1).map(([offset]) => offset);
    return {
      messages,
      delivered: [...this.seen.values()].reduce((sum, n) => sum + n, 0),
      distinctOffsets: this.seen.size,
      deliveredTwice: twice.length,
      deliveredTwiceRange: twice.length === 0 ? null : [Math.min(...twice), Math.max(...twice)],
      commitsWhileDown: {
        total: down.length,
        resolved: down.filter((c) => c.outcome === 'resolved').length,
        rejected: down.filter((c) => c.outcome === 'rejected').length,
      },
    };
  }
}

export type CommitSummary = ReturnType<CommitLog['summary']> & {
  mode: CommitMode;
  /** One batch's size: the most a confirmed consumer may redeliver per partition. */
  batchSize: number;
  partitions: number;
  /** The group's committed offset on the broker at the end (kafka-consumer-groups.sh). */
  brokerCommitted: number | null;
};

export interface CommitVerdict {
  ok: boolean;
  failures: string[];
}

/**
 * raw: the check passes when it reproduces the defect (a commit resolved while the broker was
 * down). confirmed: no commit may be believed while the broker is down, at most one batch per
 * partition may be delivered twice, and every message must be delivered and finally committed.
 */
export function commitVerdict(s: CommitSummary): CommitVerdict {
  const failures: string[] = [];
  if (s.distinctOffsets !== s.messages) {
    failures.push(`delivered ${s.distinctOffsets} distinct offsets of ${s.messages}`);
  }
  if (s.brokerCommitted !== s.messages) {
    failures.push(`broker holds offset ${s.brokerCommitted}, expected ${s.messages}`);
  }
  if (s.commitsWhileDown.total === 0)
    failures.push('no commit was attempted while the broker was down');
  if (s.mode === 'raw') {
    if (s.commitsWhileDown.resolved === 0) {
      failures.push('raw commits did not resolve while the broker was down: defect not reproduced');
    }
  } else {
    if (s.commitsWhileDown.resolved > 0) {
      failures.push(
        `${s.commitsWhileDown.resolved} commits were believed while the broker was down`,
      );
    }
    if (s.deliveredTwice > s.batchSize * s.partitions) {
      failures.push(
        `${s.deliveredTwice} offsets delivered twice, more than one batch per partition`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}
