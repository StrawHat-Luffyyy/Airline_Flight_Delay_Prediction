/**
 * The Kafka client for the Phase 8 speed layer: `@confluentinc/kafka-javascript` (librdkafka) through
 * its KafkaJS-compatible API. The API server uses it only through the status probe, in a separate
 * process with short timeouts, so it never requires Kafka to start or to serve.
 */
import { fork } from 'node:child_process';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { kafkaClientConfig } from './kafka-config.js';
import {
  KAFKA_CACHE_MS,
  KAFKA_TIMEOUT_MS,
  createKafkaProbe,
  type KafkaProbe,
} from './status/kafka-probe.js';
import { createIsolatedProbe } from './status/isolated-probe.js';

/** Bounds every admin call, so a stopped broker fails fast instead of hanging a CLI. */
export const ADMIN_TIMEOUT_MS = 10_000;

export function createKafka(): KafkaJS.Kafka {
  const config = kafkaClientConfig({
    brokers: env.KAFKA_BROKERS,
    clientId: env.KAFKA_CLIENT_ID,
    timeoutMs: ADMIN_TIMEOUT_MS,
    securityProtocol: env.KAFKA_SECURITY_PROTOCOL,
    ...(env.KAFKA_SASL_USERNAME !== undefined && env.KAFKA_SASL_PASSWORD !== undefined
      ? { sasl: { username: env.KAFKA_SASL_USERNAME, password: env.KAFKA_SASL_PASSWORD } }
      : {}),
    ...(env.KAFKA_SSL_CA_FILE === undefined ? {} : { caFile: env.KAFKA_SSL_CA_FILE }),
  });
  return new KafkaJS.Kafka({
    ...config,
    kafkaJS: { ...config.kafkaJS, brokers: env.KAFKA_BROKERS, logLevel: KafkaJS.logLevel.WARN },
  });
}

export function consumerGroup(): string {
  return env.KAFKA_CONSUMER_GROUP;
}

export function topicNames(): { raw: string; dlq: string } {
  return { raw: env.KAFKA_TOPIC_RAW, dlq: env.KAFKA_TOPIC_DLQ };
}

/**
 * The Kafka probe that runs inside the probe process (status/probe-worker.ts). Its admin client logs
 * nothing: a stopped broker is reported in the status response, not as log noise.
 */
export function createInProcessProbe(): KafkaProbe {
  return createKafkaProbe({
    createAdmin: () => createKafka().admin({ kafkaJS: { logLevel: KafkaJS.logLevel.NOTHING } }),
    groupId: consumerGroup(),
    topics: topicNames(),
    timeoutMs: KAFKA_TIMEOUT_MS,
    cacheMs: KAFKA_CACHE_MS,
  });
}

/** Slack on top of the in-process timeout for process start-up and IPC. */
const PROBE_PROCESS_SLACK_MS = 500;

/**
 * The API's Kafka probe for /stream/status and /health: librdkafka runs in a forked child process
 * (status/isolated-probe.ts explains the crash this contains). Nothing starts until the first read.
 */
export function createStatusProbe(): KafkaProbe {
  // Under tsx this module is src/stream/kafka.ts; in the production build it is bundled into
  // dist/server.js, with the worker bundled beside it as dist/probe-worker.js.
  const worker = import.meta.url.endsWith('.ts')
    ? new URL('./status/probe-worker.ts', import.meta.url)
    : new URL('./probe-worker.js', import.meta.url);
  return createIsolatedProbe({
    // execArgv carries the tsx loader into the child. Detached: without its own console the child
    // does not need the API's, which can be gone (its terminal closed). A non-detached child of
    // such a process dies at start-up with 0xC0000142; reproduced on Windows by killing the
    // parent's conhost, and fixed by this flag. It still exits when the API does: its IPC channel
    // closes. Its output is piped back into the API's.
    spawn: () => {
      const child = fork(worker, [], {
        execArgv: process.execArgv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
      return child;
    },
    timeoutMs: KAFKA_TIMEOUT_MS + PROBE_PROCESS_SLACK_MS,
    logger,
  });
}
