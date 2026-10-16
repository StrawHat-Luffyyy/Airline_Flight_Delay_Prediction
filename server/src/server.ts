import { createApp } from './app.js';
import { closeMongo, connectToMongo } from './db/client.js';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { DEFAULT_ARTIFACTS_DIR, loadModel, type DelayModel } from './ml/model.js';

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

async function start(): Promise<void> {
  await connectToMongo();
  const model = await loadModelOrNull();
  const app = createApp({ model });
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
