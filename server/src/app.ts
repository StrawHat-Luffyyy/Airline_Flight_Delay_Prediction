import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { HealthResponseSchema, type HealthResponse } from '@flight-delay/shared';
import { pingMongo } from './db/client.js';
import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

export interface AppOptions {
  pingMongo?: () => Promise<boolean>;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const checkMongo = options.pingMongo ?? pingMongo;

  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', async (_request, response) => {
    const mongoIsUp = await checkMongo();
    const body: HealthResponse = HealthResponseSchema.parse({
      status: 'ok',
      mongo: mongoIsUp ? 'up' : 'down',
      modelLoaded: false,
    });
    response.status(200).json(body);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
