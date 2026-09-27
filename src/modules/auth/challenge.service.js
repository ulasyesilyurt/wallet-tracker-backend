import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../utils/httpError.js';
import { safeErrorDetails } from '../../utils/safeError.js';
import { hashPassword } from '../../utils/password.js';
import { findUserByEmail, findUserById } from './auth.repository.js';
import { consumeChallenge, invalidateChallenge, issueChallenge } from './challenge.repository.js';

const EXPIRY_SECONDS = 10 * 60;
const NEUTRAL_RESET_RESPONSE = { message: 'If an account exists for that email, a reset code has been sent.' };

function digestFor(userId, purpose, challengeId, code) {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`ChainBell auth challenge:${userId}:${purpose}:${challengeId}:${code}`)
    .digest('hex');
}

function matchesCode(userId, purpose, code, challenge) {
  const candidate = Buffer.from(digestFor(userId, purpose, challenge.id, code), 'hex');
  const stored = Buffer.from(challenge.code_digest, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

async function createAndSend(user, purpose, emailService) {
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const id = randomUUID();
  const issued = await issueChallenge({
    id,
    userId: user.id,
    purpose,
    digest: digestFor(user.id, purpose, id, code),
    expiresInSeconds: EXPIRY_SECONDS
  });
  if (!issued?.issued) return false;

  try {
    if (purpose === 'verify_email') {
      await emailService.sendVerificationCode(user.email, code);
    } else {
      await emailService.sendPasswordResetCode(user.email, code);
    }
    return true;
  } catch (error) {
    logger.error({ operation: purpose, ...safeErrorDetails(error) }, 'Authentication email delivery failed');
    try {
      await invalidateChallenge(id);
    } catch (invalidationError) {
      logger.error({ operation: purpose, ...safeErrorDetails(invalidationError) }, 'Could not invalidate undelivered authentication challenge');
    }
    throw new HttpError(503, 'AUTH_EMAIL_UNAVAILABLE', 'Email delivery is temporarily unavailable. Please try again later.');
  }
}

export async function requestEmailVerification(user, emailService) {
  if (!user.email || user.emailVerifiedAt) return { message: 'If verification is needed, a code has been sent.' };
  const issued = await createAndSend(user, 'verify_email', emailService);
  if (!issued) throw new HttpError(429, 'AUTH_CODE_REQUEST_LIMITED', 'Please wait before requesting another code.');
  return { message: 'If verification is needed, a code has been sent.' };
}

export async function verifyEmailCode(user, code) {
  if (user.emailVerifiedAt) {
    throw new HttpError(400, 'AUTH_INVALID_CODE', 'Invalid or expired code.');
  }
  const valid = await consumeChallenge({
    userId: user.id,
    purpose: 'verify_email',
    matches: (challenge) => matchesCode(user.id, 'verify_email', code, challenge)
  });
  if (!valid) throw new HttpError(400, 'AUTH_INVALID_CODE', 'Invalid or expired code.');
  return findUserById(user.id);
}

export async function requestPasswordReset(email, emailService) {
  const startedAt = Date.now();
  try {
    const user = await findUserByEmail(email);
    if (user?.passwordHash) await createAndSend(user, 'reset_password', emailService);
  } catch (error) {
    // Preserve the same public response for unknown accounts and delivery failures.
    if (error?.code !== 'AUTH_EMAIL_UNAVAILABLE') {
      logger.error({ operation: 'reset_password', ...safeErrorDetails(error) }, 'Password reset request failed');
    }
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 300 - (Date.now() - startedAt))));
  return NEUTRAL_RESET_RESPONSE;
}

export async function resetPassword({ email, code, newPassword }) {
  // Hash before the lookup so unknown and known accounts do similar local work.
  const passwordHash = await hashPassword(newPassword);
  const user = await findUserByEmail(email);
  const valid = user?.passwordHash && await consumeChallenge({
    userId: user.id,
    purpose: 'reset_password',
    passwordHash,
    matches: (challenge) => matchesCode(user.id, 'reset_password', code, challenge)
  });
  if (!valid) throw new HttpError(400, 'AUTH_INVALID_CODE', 'Invalid or expired code.');
  return { message: 'Password updated.' };
}
