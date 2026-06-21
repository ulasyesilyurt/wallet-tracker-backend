import crypto from 'crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../utils/httpError.js';

const webhookSignatureLogger = logger.child({ module: 'alchemy-webhook-signature' });
const ALCHEMY_SIGNATURE_HEADER = 'x-alchemy-signature';

function normalizeSignature(signature) {
  if (typeof signature !== 'string') {
    return null;
  }

  const trimmed = signature.trim();

  if (trimmed === '') {
    return null;
  }

  if (trimmed.startsWith('sha256=')) {
    return trimmed.slice('sha256='.length).toLowerCase();
  }

  return trimmed.toLowerCase();
}

function computeAlchemySignature(rawBody, signingSecret) {
  return crypto
    .createHmac('sha256', signingSecret)
    .update(rawBody)
    .digest('hex');
}

function isDevelopmentSkipAllowed() {
  return env.NODE_ENV === 'development' && !env.ALCHEMY_WEBHOOK_SIGNING_SECRET;
}

export function verifyAlchemyWebhookSignature(req, res, next) {
  if (isDevelopmentSkipAllowed()) {
    webhookSignatureLogger.warn(
      {
        path: req.originalUrl,
        nodeEnv: env.NODE_ENV
      },
      'Alchemy webhook signature verification skipped in development because secret is unset'
    );
    return next();
  }

  if (!env.ALCHEMY_WEBHOOK_SIGNING_SECRET) {
    return next(
      new HttpError(
        500,
        'WEBHOOK_SIGNATURE_NOT_CONFIGURED',
        'Alchemy webhook signing secret is not configured.',
        { expose: false }
      )
    );
  }

  const providedSignature = normalizeSignature(req.get(ALCHEMY_SIGNATURE_HEADER));

  if (!providedSignature) {
    webhookSignatureLogger.warn(
      {
        path: req.originalUrl,
        hasRawBody: typeof req.rawBody === 'string' && req.rawBody.length > 0
      },
      'Alchemy webhook signature missing'
    );
    return next(new HttpError(401, 'WEBHOOK_SIGNATURE_MISSING', 'Missing Alchemy webhook signature.'));
  }

  if (typeof req.rawBody !== 'string') {
    webhookSignatureLogger.error(
      { path: req.originalUrl },
      'Alchemy webhook signature verification failed because raw body was unavailable'
    );
    return next(
      new HttpError(
        500,
        'WEBHOOK_RAW_BODY_UNAVAILABLE',
        'Webhook request body could not be verified.',
        { expose: false }
      )
    );
  }

  const expectedSignature = computeAlchemySignature(
    req.rawBody,
    env.ALCHEMY_WEBHOOK_SIGNING_SECRET
  );
  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const isValid =
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);

  if (!isValid) {
    webhookSignatureLogger.warn(
      {
        path: req.originalUrl,
        signatureLength: providedSignature.length
      },
      'Alchemy webhook signature invalid'
    );
    return next(new HttpError(403, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid Alchemy webhook signature.'));
  }

  webhookSignatureLogger.info(
    {
      path: req.originalUrl
    },
    'Alchemy webhook signature verified'
  );

  return next();
}
