import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { HealthResponseSchema, type HealthResponse } from '@flight-delay/shared';
import { pingMongo } from './db/client.js';

export interface AppOptions {
  pingMongo?: () => Promise<boolean>;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const checkMongo = options.pingMongo ?? pingMongo;

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(pinoHttp());

  app.get('/api/health', async (_request, response) => {
    const mongoIsUp = await checkMongo();
    const body: HealthResponse = HealthResponseSchema.parse({
      status: 'ok',
      mongo: mongoIsUp ? 'up' : 'down',
      modelLoaded: false,
    });
    response.status(200).json(body);
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    void _next;
    const message = error instanceof Error ? error.message : 'Internal server error';
    response.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message },
    });
  };

  app.use(errorHandler);
  return app;
}
