import { createApp } from './app.js';
import { closeMongo, connectToMongo } from './db/client.js';
import { env } from './config/env.js';

const app = createApp();

async function start(): Promise<void> {
  await connectToMongo();
  const server = app.listen(env.PORT, () => {
    console.info(`Flight delay API listening on port ${env.PORT}`);
  });

  const shutdown = (): void => {
    server.close(() => {
      void closeMongo().then(() => process.exit(0));
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error(`Unable to start server: ${message}`);
  await closeMongo();
  process.exitCode = 1;
});
