import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from '../../utils/httpError.js';
import { verifyPassword } from '../../utils/password.js';
import { verifyAppleIdToken } from './apple.verifier.js';
import {
  completeAccountDeletionReauth, issueAccountDeletionChallenge,
  readAccountDeletionChallenge, recordFailedAccountDeletionProof
} from './accountDeletionReauth.repository.js';

function managedSessionId(auth) {
  if (!auth.payload.sid) {
    throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'A session-backed access token is required.');
  }
  return auth.payload.sid;
}

function methodUnavailable() {
  return new HttpError(403, 'AUTH_REAUTH_METHOD_UNAVAILABLE', 'Fresh account proof is unavailable for this account.');
}

function invalidChallenge() {
  return new HttpError(400, 'AUTH_REAUTH_INVALID', 'Invalid account reauthentication challenge.');
}

function reauthFailed() {
  return new HttpError(401, 'AUTH_REAUTH_FAILED', 'Current account proof is invalid.');
}

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

export function createAccountDeletionReauth({
  appleVerifier = verifyAppleIdToken,
  passwordVerifier = verifyPassword
} = {}) {
  return {
    async challenge(auth, { method }) {
      const sessionId = managedSessionId(auth);
      if (method === 'google') throw methodUnavailable();

      const nonce = method === 'apple' ? randomBytes(32).toString('hex') : null;
      const id = randomUUID();
      const stored = await issueAccountDeletionChallenge({
        id,
        userId: auth.user.id,
        sessionId,
        method,
        nonceDigest: nonce ? sha256(nonce) : null
      });
      return {
        challengeId: id,
        method,
        expiresAt: stored.expires_at.toISOString(),
        ...(nonce ? { nonce } : {})
      };
    },

    async verify(auth, request) {
      const sessionId = managedSessionId(auth);
      if (request.method === 'google') throw methodUnavailable();
      const context = {
        id: request.challengeId,
        userId: auth.user.id,
        sessionId
      };
      const challenge = await readAccountDeletionChallenge(context);
      if (!challenge || challenge.method !== request.method ||
          challenge.consumed_at || challenge.attempts >= 5) throw invalidChallenge();
      if (challenge.revoked_at) {
        throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
      }
      if (challenge.expired) {
        throw new HttpError(400, 'AUTH_REAUTH_EXPIRED', 'Account reauthentication challenge expired.');
      }

      let expectedPasswordHash = null;
      let expectedNonceDigest = null;
      let providerSubject = null;
      if (request.method === 'password') {
        expectedPasswordHash = challenge.password_hash;
        if (!expectedPasswordHash) throw methodUnavailable();
        if (!await passwordVerifier(request.currentPassword, expectedPasswordHash)) {
          await recordFailedAccountDeletionProof(context);
          throw reauthFailed();
        }
      } else {
        expectedNonceDigest = challenge.nonce_digest;
        if (!expectedNonceDigest) throw invalidChallenge();
        let identity;
        try {
          identity = await appleVerifier(request.identityToken, {
            expectedNonce: expectedNonceDigest.toString('hex'),
            issuedAfter: challenge.created_at
          });
        } catch (error) {
          if (error?.code !== 'AUTH_INVALID_PROVIDER_TOKEN') throw error;
          await recordFailedAccountDeletionProof(context);
          throw reauthFailed();
        }
        providerSubject = identity.subject;
      }

      const authorization = randomBytes(32).toString('base64url');
      let grant;
      try {
        grant = await completeAccountDeletionReauth({
          ...context,
          method: request.method,
          expectedPasswordHash,
          expectedNonceDigest,
          providerSubject,
          authorizationDigest: sha256(authorization)
        });
      } catch (error) {
        if (error?.code === 'AUTH_REAUTH_FAILED') await recordFailedAccountDeletionProof(context);
        throw error;
      }
      return { deletionAuthorization: authorization, expiresAt: grant.expires_at.toISOString() };
    }
  };
}
