/**
 * Kafka topics for the Phase 8 speed layer (PROJECT_OVERVIEW §15.3) and their idempotent creation.
 * The admin client is injected as the narrow `TopicAdmin`, so creation is unit-testable without a
 * broker; `kafka:init` passes the real Confluent admin client.
 */

export interface TopicSpec {
  topic: string;
  numPartitions: number;
  /** 1: a single broker. No fault tolerance (stated in BIGDATA_JUSTIFICATION). */
  replicationFactor: number;
}

/**
 * flights.raw is keyed by origin, so one airport's events stay ordered on one of 3 partitions.
 * The DLQ needs no parallelism. Retention is the broker default (7 days), ample for a replay.
 */
export function topicSpecs(names: { raw: string; dlq: string }): TopicSpec[] {
  return [
    { topic: names.raw, numPartitions: 3, replicationFactor: 1 },
    { topic: names.dlq, numPartitions: 1, replicationFactor: 1 },
  ];
}

export interface Mismatch {
  topic: string;
  expected: number;
  actual: number;
}

export interface TopicPlan {
  create: TopicSpec[];
  ok: string[];
  mismatched: Mismatch[];
}

/** Pure: compares the wanted specs with the existing topics (name -> partition count). */
export function planTopics(
  specs: readonly TopicSpec[],
  existing: ReadonlyMap<string, number>,
): TopicPlan {
  const plan: TopicPlan = { create: [], ok: [], mismatched: [] };
  for (const spec of specs) {
    const actual = existing.get(spec.topic);
    if (actual === undefined) plan.create.push(spec);
    else if (actual === spec.numPartitions) plan.ok.push(spec.topic);
    else plan.mismatched.push({ topic: spec.topic, expected: spec.numPartitions, actual });
  }
  return plan;
}

/** The slice of the KafkaJS-compatible admin API that topic creation needs. */
export interface TopicAdmin {
  listTopics(): Promise<string[]>;
  fetchTopicMetadata(options: {
    topics: string[];
  }): Promise<{ name: string; partitions: { partitionId: number }[] }[]>;
  /** Resolves false when nothing was created; may throw if a topic appeared meanwhile. */
  createTopics(options: { topics: TopicSpec[] }): Promise<boolean>;
}

async function partitionCounts(admin: TopicAdmin, topics: string[]): Promise<Map<string, number>> {
  if (topics.length === 0) return new Map();
  const metadata = await admin.fetchTopicMetadata({ topics });
  return new Map(metadata.map((topic) => [topic.name, topic.partitions.length]));
}

function describeMismatches(mismatched: readonly Mismatch[]): string {
  return mismatched
    .map((m) =>
      m.actual === 0
        ? `${m.topic} was not found after it was created.`
        : `${m.topic} has ${m.actual} partition(s), expected ${m.expected}. Delete and recreate it, ` +
          'or the key-to-partition mapping (one airport per partition) no longer holds.',
    )
    .join(' ');
}

export interface InitOptions {
  /** Metadata checks after creation; a new topic takes a moment to appear (default 15). */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Creates the missing topics and leaves existing ones alone. Throws, before creating anything,
 * if an existing topic has the wrong partition count. After creating, it re-reads the metadata
 * (retrying while the new topics propagate) and throws unless every created topic has the
 * expected partitions.
 */
export async function initTopics(
  admin: TopicAdmin,
  specs: readonly TopicSpec[],
  { attempts = 15, delayMs = 400, sleep = pause }: InitOptions = {},
): Promise<{ created: string[]; existing: string[] }> {
  const wanted = new Set(specs.map((spec) => spec.topic));
  const present = (await admin.listTopics()).filter((topic) => wanted.has(topic));
  const plan = planTopics(specs, await partitionCounts(admin, present));
  if (plan.mismatched.length > 0) throw new Error(describeMismatches(plan.mismatched));

  if (plan.create.length > 0) {
    // Another run may create the same topic between listTopics and here ("already exists"). That
    // is success if the topic then has the right partitions, so a create error is only rethrown
    // when the verification below cannot confirm every topic.
    let createError: unknown;
    try {
      await admin.createTopics({ topics: plan.create });
    } catch (error) {
      createError = error;
    }
    const names = plan.create.map((spec) => spec.topic);
    let problems: Mismatch[] = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let counts: Map<string, number>;
      try {
        counts = await partitionCounts(admin, names);
      } catch (error) {
        // Typically "unknown topic" while the new topic propagates; give up only at the end.
        if (attempt === attempts) throw createError ?? error;
        await sleep(delayMs);
        continue;
      }
      const after = planTopics(plan.create, counts);
      problems = [
        ...after.mismatched,
        ...after.create.map((spec) => ({
          topic: spec.topic,
          expected: spec.numPartitions,
          actual: 0,
        })),
      ];
      // A wrong count is final (a topic is created with all its partitions at once); a missing
      // topic may still be propagating.
      if (after.mismatched.length > 0 || after.create.length === 0 || attempt === attempts) break;
      await sleep(delayMs);
    }
    if (problems.length > 0) {
      throw createError instanceof Error ? createError : new Error(describeMismatches(problems));
    }
  }
  return { created: plan.create.map((spec) => spec.topic), existing: plan.ok };
}
