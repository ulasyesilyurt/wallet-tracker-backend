import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { logger } from './config/logger.js';
import { globalApiRateLimiter } from './middlewares/rateLimit.js';
import { createApiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';

function shouldCaptureRawBody(req) {
  return req.originalUrl?.startsWith('/api/v1/webhooks/alchemy');
}

export function createApp(readinessOptions = {}) {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, res, buffer) => {
        if (shouldCaptureRawBody(req)) {
          req.rawBody = buffer.toString('utf8');
        }
      }
    })
  );
  app.use(
    pinoHttp({
      logger
    })
  );

  if (globalApiRateLimiter) {
    app.use('/api/v1', globalApiRateLimiter);
  }

  app.use('/api/v1', createApiRouter(readinessOptions));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
