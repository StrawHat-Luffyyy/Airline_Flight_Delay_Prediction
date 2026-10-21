import { Router } from 'express';
import type { StreamStatus } from '../stream/status/service.js';

/**
 * GET /api/stream/status (PROJECT_OVERVIEW §15.8). Always 200: Kafka, the consumer or MongoDB being
 * down is reported as `state: "degraded"` with a reason. The body is live, so it is never cached by
 * the browser (the service caches its MongoDB counts for a few seconds).
 */
export function streamRouter({ status }: { status: StreamStatus }): Router {
  const router = Router();
  router.get('/stream/status', async (_request, response) => {
    response.set('Cache-Control', 'no-store').json(await status.get());
  });
  return router;
}
