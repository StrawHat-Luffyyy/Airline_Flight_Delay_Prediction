/** `npm run kafka:init`: creates the speed-layer topics if missing (idempotent; §15.3). */
import { logger } from '../logger.js';
import { ADMIN_TIMEOUT_MS, createKafka, topicNames } from './kafka.js';
import { initTopics, topicSpecs, type TopicAdmin } from './topics.js';

async function main(): Promise<void> {
  const admin = createKafka().admin();
  await admin.connect();
  try {
    // Bind the Confluent admin to the narrow interface initTopics needs, with timeouts.
    const topicAdmin: TopicAdmin = {
      listTopics: () => admin.listTopics({ timeout: ADMIN_TIMEOUT_MS }),
      fetchTopicMetadata: ({ topics }) =>
        admin.fetchTopicMetadata({ topics, timeout: ADMIN_TIMEOUT_MS }),
      createTopics: ({ topics }) => admin.createTopics({ topics, timeout: ADMIN_TIMEOUT_MS }),
    };
    const specs = topicSpecs(topicNames());
    const result = await initTopics(topicAdmin, specs);
    logger.info(
      {
        ...result,
        topics: specs.map(
          (spec) => `${spec.topic} (${spec.numPartitions}p, rf ${spec.replicationFactor})`,
        ),
      },
      result.created.length > 0 ? 'kafka:init created topics' : 'kafka:init: topics already exist',
    );
  } finally {
    await admin.disconnect();
  }
}

main().catch((error: unknown) => {
  logger.fatal(
    { err: error },
    'kafka:init failed (is the kafka service up? docker compose up -d kafka)',
  );
  process.exitCode = 1;
});
