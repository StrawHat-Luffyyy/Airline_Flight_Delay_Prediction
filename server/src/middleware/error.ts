import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ErrorResponse } from '@flight-delay/shared';
import { logger } from '../logger.js';

function errorBody(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = 'status' in error ? error.status : undefined;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

export const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json(errorBody('NOT_FOUND', 'Route not found'));
};

// Express identifies error middleware by its four parameters, so `_next` must stay.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  const status = clientErrorStatus(error);
  if (status !== undefined) {
    // Body-parser errors (malformed JSON, payload too large) carry a 4xx status.
    response.status(status).json(errorBody('BAD_REQUEST', 'Malformed request'));
    return;
  }

  logger.error({ err: error }, 'Unhandled request error');
  response.status(500).json(errorBody('INTERNAL_SERVER_ERROR', 'Internal server error'));
};
