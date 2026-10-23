import { createApp } from './app.js';
import { closeMongo, connectToMongo } from './db/client.js';
import { retry } from './db/retry.js';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { DEFAULT_ARTIFACTS_DIR, loadModel, type DelayModel } from './ml/model.js';
import { createStatusProbe } from './stream/kafka.js';

/** The API still serves analytics without a model; /predict then answers 503 until a restart. */
async function loadModelOrNull(): Promise<DelayModel | null> {
  try {
    const model = await loadModel();
    logger.info({ modelVersion: model.encoders.modelVersion }, 'Prediction model loaded');
    return model;
  } catch (error) {
    logger.error(
      { err: error, artifactsDir: DEFAULT_ARTIFACTS_DIR },
      'Prediction model not loaded; /api/predict will return 503',
    );
    return null;
  }
}

/**
 * MongoDB may still be starting (a fresh `docker compose up`), so the first connect is retried:
 * 8 attempts over about 45 s. If it is still down, the process exits non-zero for its supervisor
 * (Docker's restart policy) to start again.
 */
const MONGO_CONNECT = { attempts: 8, initialDelayMs: 1_000, maxDelayMs: 10_000 } as const;

async function start(): Promise<void> {
  await retry(connectToMongo, {
    ...MONGO_CONNECT,
    onRetry: (attempt, error) =>
      logger.warn(
        { err: error, attempt, of: MONGO_CONNECT.attempts },
        'MongoDB not reachable yet; retrying',
      ),
  });
  const model = await loadModelOrNull();
  const kafkaProbe = createStatusProbe();
  const app = createApp({ model, kafkaProbe });
  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT }, 'Flight delay API listening');
  });

  const shutdown = (): void => {
    server.close(() => {
      Promise.all([
        closeMongo().catch((error: unknown) =>
          logger.error({ err: error }, 'Error closing MongoDB'),
        ),
        model
          ?.close()
          .catch((error: unknown) => logger.error({ err: error }, 'Error closing model')),
        kafkaProbe.close(),
      ]).finally(() => process.exit(0));
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch(async (error: unknown) => {
  logger.fatal({ err: error }, 'Unable to start server');
  await closeMongo().catch(() => undefined);
  process.exit(1);
});
