import { HttpError } from '../../utils/httpError.js';
import { buildAuthResponse } from './auth.service.js';
import { emailSchema } from './auth.schemas.js';
import { verifyAppleIdToken } from './apple.verifier.js';
import { createRefreshCredential } from './refreshToken.js';
import { identityUniqueConflict } from './identity.repository.js';
import { createAppleAccountWithSession, createSessionForAppleSubject } from './apple.repository.js';

const EMAIL_UNIQUE_CONSTRAINTS = new Set([
  'app_users_email_key',
  'idx_app_users_email_normalized_unique'
]);

function linkRequired() {
  return new HttpError(409, 'AUTH_LINK_REQUIRED', 'Sign in to your existing account to link Apple.');
}

function emailRequired() {
  return new HttpError(422, 'AUTH_EMAIL_REQUIRED', 'A usable email address is required to create an account.');
}

export function createAppleSignIn({ verifyToken = verifyAppleIdToken } = {}) {
  return async function signInApple(identityToken, expectedNonce, { issueRefreshToken = false } = {}) {
    // Apple signature, claims, and nonce are checked before any database access.
    const identity = await verifyToken(identityToken, { expectedNonce });
    const refreshCredential = issueRefreshToken ? createRefreshCredential() : null;
    let account = await createSessionForAppleSubject(identity.subject, refreshCredential);
    if (account) return buildAuthResponse(account.user, account.sessionId, refreshCredential);

    const parsedEmail = emailSchema.safeParse(identity.email);
    if (!parsedEmail.success) throw emailRequired();
    const email = parsedEmail.data.toLowerCase();
    try {
      account = await createAppleAccountWithSession({
        email,
        subject: identity.subject,
        // Apple email_verified describes the signed address, including a relay.
        emailVerified: identity.emailVerified,
        refreshCredential
      });
    } catch (error) {
      const emailConflict = error?.code === '23505' && EMAIL_UNIQUE_CONSTRAINTS.has(error.constraint);
      const subjectConflict = identityUniqueConflict(error) === 'subject_taken';
      if (!emailConflict && !subjectConflict) throw error;

      // Retry only the same Apple subject after a concurrent first sign-in.
      // A matching email never authorizes an account link.
      account = await createSessionForAppleSubject(identity.subject, refreshCredential);
      if (!account) throw linkRequired();
    }
    return buildAuthResponse(account.user, account.sessionId, refreshCredential);
  };
}
