import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { createTrustProxy, parseAllowedOrigins } from './config/network.js';
import { globalApiRateLimiter } from './middlewares/rateLimit.js';
import { createApiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';

function shouldCaptureRawBody(req) {
  return req.originalUrl?.startsWith('/api/v1/webhooks/alchemy');
}

export function createApp(runtimeOptions = {}, networkConfig = env) {
  const app = express();
  app.set('trust proxy', createTrustProxy(networkConfig));

  const production = networkConfig.NODE_ENV === 'production';
  const allowedOrigins = parseAllowedOrigins(networkConfig.CORS_ALLOWED_ORIGINS, networkConfig.NODE_ENV);

  app.use(helmet());
  if (production) {
    const allowed = new Set(allowedOrigins);
    app.use((req, res, next) => {
      const origin = req.get('Origin');
      if (origin && !allowed.has(origin)) {
        return res.status(403).json({
          error: { code: 'CORS_ORIGIN_DENIED', message: 'Origin is not allowed.' }
        });
      }
      return next();
    });
  }
  app.use(cors(production ? { origin: allowedOrigins } : undefined));
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

  app.use('/api/v1', createApiRouter({
    ...runtimeOptions,
    operationsToken: runtimeOptions.operationsToken ?? networkConfig.OPERATIONS_DIAGNOSTICS_TOKEN
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
