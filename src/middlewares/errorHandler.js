import { ZodError } from 'zod';
import { logger } from '../config/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found`
    }
  });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.flatten()
      }
    });
  }

  logger.error({ err: error, path: req.originalUrl }, 'Unhandled request error');

  return res.status(error.statusCode || 500).json({
    error: {
      code: error.code || 'INTERNAL_SERVER_ERROR',
      message: error.expose ? error.message : 'An unexpected error occurred'
    }
  });
}
