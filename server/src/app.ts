import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { HealthResponseSchema, type HealthResponse } from '@flight-delay/shared';
import { env } from './config/env.js';
import type { Db } from 'mongodb';
import { getDb, pingMongo } from './db/client.js';
import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiRouter } from './routes/api.js';

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

export interface AppOptions {
  pingMongo?: () => Promise<boolean>;
  corsOrigin?: string;
  /** Database accessor for the API routes (tests inject a seeded test database). */
  getDb?: () => Db;
  /** TTL of the in-memory response cache; 0 disables it. Default 10 minutes. */
  cacheTtlMs?: number;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const checkMongo = options.pingMongo ?? pingMongo;

  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(cors({ origin: options.corsOrigin ?? env.CORS_ORIGIN }));
  app.use(express.json());

  app.get('/api/health', async (_request, response) => {
    const mongoIsUp = await checkMongo();
    const body: HealthResponse = HealthResponseSchema.parse({
      status: mongoIsUp ? 'ok' : 'degraded',
      mongo: mongoIsUp ? 'up' : 'down',
      modelLoaded: false,
    });
    response.status(mongoIsUp ? 200 : 503).json(body);
  });

  app.use(
    '/api',
    apiRouter({
      getDb: options.getDb ?? getDb,
      cacheTtlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
