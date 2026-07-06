import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

function buildRateLimitHandler(message) {
  return (_req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message
      }
    });
  };
}

function createRateLimiter({
  windowMs,
  limit,
  message,
  skip
}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    handler: buildRateLimitHandler(message)
  });
}

export const authLoginRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_LOGIN_RATE_LIMIT_MAX,
  message: 'Too many login attempts. Please try again later.'
});

export const authRegisterRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_REGISTER_RATE_LIMIT_MAX,
  message: 'Too many registration attempts. Please try again later.'
});

export const globalApiRateLimiter = env.GLOBAL_API_RATE_LIMIT_MAX > 0
  ? createRateLimiter({
    windowMs: env.GLOBAL_API_RATE_LIMIT_WINDOW_MS,
    limit: env.GLOBAL_API_RATE_LIMIT_MAX,
    message: 'Too many requests. Please try again later.',
    skip: (req) => req.originalUrl?.startsWith('/api/v1/webhooks/alchemy') || req.originalUrl === '/api/v1/health'
  })
  : null;
