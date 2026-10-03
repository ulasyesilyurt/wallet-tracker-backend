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
  skip,
  handler = buildRateLimitHandler(message)
}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    handler
  });
}

export const authLoginRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_LOGIN_RATE_LIMIT_MAX,
  message: 'Too many login attempts. Please try again later.'
});

export const authGoogleRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_GOOGLE_RATE_LIMIT_MAX,
  message: 'Too many Google sign-in attempts. Please try again later.'
});

export const authGoogleDeletionCallbackRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_GOOGLE_DELETION_CALLBACK_RATE_LIMIT_MAX,
  message: 'Too many Google verification attempts. Please try again later.',
  handler: (_req, res) => res.status(429).set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer').type('html')
    .send('<!doctype html><html><body><p>Verification could not be completed.</p><p>Return to ChainBell and try again.</p></body></html>')
});

export const authAppleRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_APPLE_RATE_LIMIT_MAX,
  message: 'Too many Apple sign-in attempts. Please try again later.'
});

export const authIdentityManagementRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_IDENTITY_MANAGEMENT_RATE_LIMIT_MAX,
  message: 'Too many identity changes. Please try again later.'
});

export const authRegisterRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_REGISTER_RATE_LIMIT_MAX,
  message: 'Too many registration attempts. Please try again later.'
});

export const authRefreshRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_REFRESH_RATE_LIMIT_MAX,
  message: 'Too many refresh attempts. Please try again later.'
});

export const authCodeRequestRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_REGISTER_RATE_LIMIT_MAX,
  message: 'Too many code requests. Please try again later.'
});

export const authCodeVerifyRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_LOGIN_RATE_LIMIT_MAX,
  message: 'Too many code attempts. Please try again later.'
});

export const globalApiRateLimiter = env.GLOBAL_API_RATE_LIMIT_MAX > 0
  ? createRateLimiter({
    windowMs: env.GLOBAL_API_RATE_LIMIT_WINDOW_MS,
    limit: env.GLOBAL_API_RATE_LIMIT_MAX,
    message: 'Too many requests. Please try again later.',
    skip: (req) => req.originalUrl?.startsWith('/api/v1/webhooks/alchemy') ||
      req.originalUrl === '/api/v1/health' || req.originalUrl === '/api/v1/ready'
  })
  : null;
