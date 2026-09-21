import crypto from 'crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../utils/httpError.js';
import {
  BASE_MAINNET_CHAIN_ID,
  ETHEREUM_MAINNET_CHAIN_ID,
  resolveChainIdFromAlchemyWebhookNetwork
} from '../chains/chains.config.js';
import { getAlchemyAddressActivityWebhookIdForChain } from './alchemyAddressSync.service.js';

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

function getSigningSecretForChain(chainId) {
  if (chainId === ETHEREUM_MAINNET_CHAIN_ID) {
    return env.ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET ?? env.ALCHEMY_WEBHOOK_SIGNING_SECRET;
  }

  if (chainId === BASE_MAINNET_CHAIN_ID) {
    return env.ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET;
  }

  return null;
}

function getConfiguredWebhook(req) {
  const webhookId = req.body?.webhookId;

  if (typeof webhookId !== 'string') {
    return null;
  }

  // The unverified ID only selects from configured webhook identities; the HMAC
  // and signed network must both match before the request reaches the handler.
  const matches = [ETHEREUM_MAINNET_CHAIN_ID, BASE_MAINNET_CHAIN_ID]
    .filter((chainId) => getAlchemyAddressActivityWebhookIdForChain(chainId) === webhookId);

  if (matches.length !== 1) {
    return null;
  }

  const chainId = matches[0];
  const signingSecret = getSigningSecretForChain(chainId);

  return signingSecret?.trim() ? { chainId, signingSecret } : null;
}

export function verifyAlchemyWebhookSignature(req, res, next) {
  if (env.NODE_ENV !== 'production' && env.ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV) {
    webhookSignatureLogger.warn(
      {
        path: req.originalUrl,
        nodeEnv: env.NODE_ENV
      },
      'Alchemy webhook signature verification explicitly skipped for local testing'
    );
    return next();
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

  const configuredWebhook = getConfiguredWebhook(req);

  if (!configuredWebhook) {
    webhookSignatureLogger.warn({ path: req.originalUrl }, 'Alchemy webhook ID is not configured');
    return next(new HttpError(403, 'WEBHOOK_ID_INVALID', 'Unknown Alchemy webhook.'));
  }

  const expectedSignature = computeAlchemySignature(
    req.rawBody,
    configuredWebhook.signingSecret
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

  if (resolveChainIdFromAlchemyWebhookNetwork(req.body?.event?.network) !== configuredWebhook.chainId) {
    webhookSignatureLogger.warn({ path: req.originalUrl }, 'Alchemy webhook network does not match its ID');
    return next(new HttpError(403, 'WEBHOOK_NETWORK_MISMATCH', 'Alchemy webhook network does not match its ID.'));
  }

  webhookSignatureLogger.info(
    {
      path: req.originalUrl,
      chainId: configuredWebhook.chainId
    },
    'Alchemy webhook signature verified'
  );

  return next();
}
