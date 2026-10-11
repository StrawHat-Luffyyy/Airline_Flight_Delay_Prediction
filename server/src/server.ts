import { createApp } from './app.js';
import { closeMongo, connectToMongo } from './db/client.js';
import { env } from './config/env.js';
import { logger } from './logger.js';

const app = createApp();

async function start(): Promise<void> {
  await connectToMongo();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Flight delay API listening');
  });

  const shutdown = (): void => {
    server.close(() => {
      closeMongo()
        .catch((error: unknown) => logger.error({ err: error }, 'Error closing MongoDB'))
        .finally(() => process.exit(0));
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
