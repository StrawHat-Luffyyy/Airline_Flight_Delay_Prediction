import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ErrorResponse } from '@flight-delay/shared';
import { InvalidCursorError } from '../analytics/flights.js';
import { logger } from '../logger.js';
import { RequestValidationError } from './validate.js';

const DEFAULT_CLIENT_ERROR: [string, string] = ['BAD_REQUEST', 'Malformed request'];

const CLIENT_ERRORS: Record<number, [string, string]> = {
  400: DEFAULT_CLIENT_ERROR,
  413: ['PAYLOAD_TOO_LARGE', 'Request body too large'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported request encoding'],
};

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
  if (error instanceof RequestValidationError) {
    const body: ErrorResponse = {
      error: { code: 'VALIDATION_ERROR', message: error.message, details: error.details },
    };
    response.status(400).json(body);
    return;
  }
  if (error instanceof InvalidCursorError) {
    response.status(400).json(errorBody('VALIDATION_ERROR', error.message));
    return;
  }
  const status = clientErrorStatus(error);
  if (status !== undefined) {
    // Body-parser errors (malformed JSON, payload too large, bad charset) carry a 4xx status.
    const [code, message] = CLIENT_ERRORS[status] ?? DEFAULT_CLIENT_ERROR;
    response.status(status).json(errorBody(code, message));
    return;
  }

  logger.error({ err: error }, 'Unhandled request error');
  response.status(500).json(errorBody('INTERNAL_SERVER_ERROR', 'Internal server error'));
};
