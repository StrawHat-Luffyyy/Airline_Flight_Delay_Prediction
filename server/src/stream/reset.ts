/**
 * `npm run stream:reset`: returns the speed layer to an empty state for the 8g measurements. It clears
 * ONLY the stream collections and the stream's Kafka state (the consumer group's offsets and the
 * messages on the stream topics); the batch collections (flights, stats_*, delay_lookup, model_runs,
 * ...) are never named here, so they cannot be touched.
 *
 * Kafka goes first: if the broker is unreachable or a consumer is still running, nothing is cleared.
 * Topics are emptied with DeleteRecords rather than deleted and recreated, so their partition counts
 * and configs never change and there is no delete/create race; offsets keep counting from where they
 * were, and the (deleted) group starts again from the new start of each partition.
 */
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Db } from 'mongodb';
import { STREAM_FLIGHTS } from './store.js';

/** Every collection the reset clears. Each must be a stream_* collection (checked at runtime). */
export const STREAM_COLLECTIONS = [STREAM_FLIGHTS, 'stream_stats'] as const;

/** librdkafka ConsumerGroupStates.DEAD: the group does not exist. */
const GROUP_DEAD = 4;

export type ResetAdmin = Pick<
  KafkaJS.Admin,
  'describeGroups' | 'deleteGroups' | 'fetchTopicOffsets' | 'deleteTopicRecords'
>;

export interface ResetSummary {
  groupDeleted: boolean;
  /** Messages removed per topic (end minus start offset before the delete). */
  recordsDeleted: Record<string, number>;
  /** Documents removed per collection. */
  documentsDeleted: Record<string, number>;
}

/** Refuses unless the operator named the configured database explicitly and confirmed. */
export function checkResetTarget(
  args: { db: string | undefined; yes: boolean },
  configuredDb: string,
): void {
  if (args.db === undefined) {
    throw new Error(`Name the database to reset: --db ${configuredDb} --yes`);
  }
  if (args.db !== configuredDb) {
    throw new Error(
      `Refusing to reset "${args.db}": the configured database (MONGODB_DB) is "${configuredDb}".`,
    );
  }
  if (!args.yes) throw new Error('Refusing to reset without --yes.');
}

export function parseResetArgs(argv: readonly string[]): { db: string | undefined; yes: boolean } {
  let db: string | undefined;
  let yes = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db' && argv[i + 1] !== undefined) {
      db = argv[i + 1];
      i += 1;
    } else if (arg === '--yes') {
      yes = true;
    } else {
      throw new Error(
        `Unknown argument "${arg}". Usage: npm run stream:reset -- --db <name> --yes`,
      );
    }
  }
  return { db, yes };
}

export async function resetStream({
  db,
  admin,
  groupId,
  topics,
  timeoutMs,
}: {
  db: Db;
  admin: ResetAdmin;
  groupId: string;
  topics: { raw: string; dlq: string };
  timeoutMs: number;
}): Promise<ResetSummary> {
  for (const name of STREAM_COLLECTIONS) {
    if (!name.startsWith('stream_')) throw new Error(`Not a stream collection: ${name}`);
  }

  // 1. The consumer group: refuse while it has members, then drop its committed offsets.
  const { groups } = await admin.describeGroups([groupId], { timeout: timeoutMs });
  const group = groups.find((g) => g.groupId === groupId);
  if (group !== undefined && group.members.length > 0) {
    throw new Error(
      `Consumer group "${groupId}" has ${group.members.length} active member(s). ` +
        'Stop npm run stream:consume first.',
    );
  }
  let groupDeleted = false;
  if (group !== undefined && group.state !== GROUP_DEAD) {
    await admin.deleteGroups([groupId], { timeout: timeoutMs });
    groupDeleted = true;
  }

  // 2. The stream topics: delete every message up to the current end offset.
  const recordsDeleted: Record<string, number> = {};
  for (const topic of [topics.raw, topics.dlq]) {
    const offsets = await admin.fetchTopicOffsets(topic, { timeout: timeoutMs, isolationLevel: 0 });
    const nonEmpty = offsets.filter((p) => Number(p.high) > Number(p.low));
    recordsDeleted[topic] = nonEmpty.reduce((sum, p) => sum + Number(p.high) - Number(p.low), 0);
    if (nonEmpty.length > 0) {
      await admin.deleteTopicRecords({
        topic,
        partitions: nonEmpty.map((p) => ({ partition: p.partition, offset: p.high })),
        timeout: timeoutMs,
      });
    }
  }

  // 3. MongoDB: empty the stream collections (indexes are kept).
  const documentsDeleted: Record<string, number> = {};
  for (const name of STREAM_COLLECTIONS) {
    documentsDeleted[name] = (await db.collection(name).deleteMany({})).deletedCount;
  }
  return { groupDeleted, recordsDeleted, documentsDeleted };
}
