import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import {
  HealthResponseSchema,
  type ErrorResponse,
  type HealthResponse,
} from '@flight-delay/shared';
import { env } from './config/env.js';
import type { Db } from 'mongodb';
import { getDb, pingMongo } from './db/client.js';
import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import type { DelayModel } from './ml/model.js';
import { mongoReferenceData, type ReferenceData } from './ml/predict.js';
import { apiRouter } from './routes/api.js';
import { modelRouter } from './routes/model.js';

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

export interface AppOptions {
  pingMongo?: () => Promise<boolean>;
  corsOrigin?: string;
  /** Database accessor for the API routes (tests inject a seeded test database). */
  getDb?: () => Db;
  /** TTL of the in-memory response cache; 0 disables it. Default 10 minutes. */
  cacheTtlMs?: number;
  /** The deployed model (loaded once at startup); null or absent = /predict answers 503. */
  model?: DelayModel | null;
  /** What /predict reads from MongoDB; defaults to the collections behind getDb. */
  referenceData?: ReferenceData;
  /** Per-IP limit on POST /api/predict; defaults to PREDICT_RATE_LIMIT_PER_MIN per minute. */
  predictRateLimit?: { limit: number; windowMs: number };
}

/** Bodies are tiny (/predict sends five fields, about 100 bytes); anything larger is refused. */
const JSON_LIMIT = '10kb';

export function createApp(options: AppOptions = {}) {
  const app = express();
  const checkMongo = options.pingMongo ?? pingMongo;
  const db = options.getDb ?? getDb;
  const model = options.model ?? null;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(cors({ origin: options.corsOrigin ?? env.CORS_ORIGIN }));
  // Rate-limit the one CPU-bound endpoint (6 ONNX rows + 4 DB reads per call), before body parsing so
  // oversized or malformed bodies count too. In memory is enough for one local process (§9: no
  // Redis). `trust proxy` is deliberately unset: the API is not behind a proxy, so the key is the
  // socket address; behind one, every client would share a key.
  const predictLimit = options.predictRateLimit ?? {
    limit: env.PREDICT_RATE_LIMIT_PER_MIN,
    windowMs: 60_000,
  };
  app.post(
    '/api/predict',
    rateLimit({
      ...predictLimit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_request, response, _next, limiterOptions) => {
        // express-rate-limit has already set Retry-After to the time left in the window.
        const body: ErrorResponse = {
          error: {
            code: 'RATE_LIMITED',
            message: `Too many predictions: at most ${limiterOptions.limit} per ${Math.round(limiterOptions.windowMs / 1000)} s. Try again shortly.`,
          },
        };
        response.status(429).json(body);
      },
    }),
  );

  app.use(express.json({ limit: JSON_LIMIT }));

  app.get('/api/health', async (_request, response) => {
    const mongoIsUp = await checkMongo();
    const body: HealthResponse = HealthResponseSchema.parse({
      status: mongoIsUp ? 'ok' : 'degraded',
      mongo: mongoIsUp ? 'up' : 'down',
      modelLoaded: model !== null,
    });
    response.status(mongoIsUp ? 200 : 503).json(body);
  });

  app.use('/api', apiRouter({ getDb: db, cacheTtlMs }));
  app.use(
    '/api',
    modelRouter({
      getDb: db,
      model,
      referenceData: options.referenceData ?? mongoReferenceData(db),
      cacheTtlMs,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
