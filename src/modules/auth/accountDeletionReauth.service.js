import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from '../../utils/httpError.js';
import { verifyPassword } from '../../utils/password.js';
import { verifyAppleIdToken } from './apple.verifier.js';
import { env } from '../../config/env.js';
import {
  exchangeGoogleAuthorizationCode, googleDeletionOAuthConfigIsComplete,
  verifyGoogleDeletionIdToken
} from './googleDeletionOAuth.js';
import {
  claimGoogleDeletionCallback, completeAccountDeletionReauth, completeGoogleDeletionCallback,
  failGoogleDeletionCallback, issueAccountDeletionChallenge, readAccountDeletionChallenge,
  recordFailedAccountDeletionProof
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
  passwordVerifier = verifyPassword,
  googleOAuthConfig = env,
  googleCodeExchange = exchangeGoogleAuthorizationCode,
  googleTokenVerifier = verifyGoogleDeletionIdToken
} = {}) {
  return {
    async challenge(auth, { method }) {
      const sessionId = managedSessionId(auth);
      if (method === 'google' && !googleDeletionOAuthConfigIsComplete(googleOAuthConfig)) {
        throw methodUnavailable();
      }

      const nonce = method === 'apple' ? randomBytes(32).toString('hex')
        : method === 'google' ? randomBytes(32).toString('base64url') : null;
      const state = method === 'google' ? randomBytes(32).toString('base64url') : null;
      const codeVerifier = method === 'google' ? randomBytes(32).toString('base64url') : null;
      const id = randomUUID();
      const stored = await issueAccountDeletionChallenge({
        id,
        userId: auth.user.id,
        sessionId,
        method,
        nonceDigest: nonce ? sha256(nonce) : null,
        googleOAuth: method === 'google' ? {
          stateDigest: sha256(state), codeVerifier,
          clientId: googleOAuthConfig.GOOGLE_DELETION_OAUTH_CLIENT_ID,
          redirectUri: googleOAuthConfig.GOOGLE_DELETION_OAUTH_REDIRECT_URI
        } : null
      });
      if (method === 'google') {
        const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authorizationUrl.search = new URLSearchParams({
          response_type: 'code',
          client_id: googleOAuthConfig.GOOGLE_DELETION_OAUTH_CLIENT_ID,
          redirect_uri: googleOAuthConfig.GOOGLE_DELETION_OAUTH_REDIRECT_URI,
          scope: 'openid email',
          state,
          nonce,
          code_challenge: sha256(codeVerifier).toString('base64url'),
          code_challenge_method: 'S256',
          prompt: 'select_account'
        }).toString();
        return { challengeId: id, method, expiresAt: stored.expires_at.toISOString(),
          authorizationUrl: authorizationUrl.toString() };
      }
      return {
        challengeId: id,
        method,
        expiresAt: stored.expires_at.toISOString(),
        ...(nonce ? { nonce } : {})
      };
    },

    async verify(auth, request) {
      const sessionId = managedSessionId(auth);
      if (request.method === 'google' && !googleDeletionOAuthConfigIsComplete(googleOAuthConfig)) {
        throw methodUnavailable();
      }
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
      } else if (request.method === 'apple') {
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
      } else {
        if (challenge.google_callback_status !== 'verified' ||
            !challenge.google_verified_subject) throw invalidChallenge();
        expectedNonceDigest = challenge.nonce_digest;
        providerSubject = challenge.google_verified_subject;
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
    },

    async googleCallback({ state, code, error } = {}) {
      if (!googleDeletionOAuthConfigIsComplete(googleOAuthConfig) ||
          typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) return false;
      let claimed;
      try {
        claimed = await claimGoogleDeletionCallback(sha256(state));
      } catch {
        return false;
      }
      if (!claimed) return false;
      try {
        if (error !== undefined || typeof code !== 'string' ||
            !code || code.length > 16_384 ||
            claimed.google_oauth_client_id !== googleOAuthConfig.GOOGLE_DELETION_OAUTH_CLIENT_ID ||
            claimed.google_oauth_redirect_uri !== googleOAuthConfig.GOOGLE_DELETION_OAUTH_REDIRECT_URI) {
          throw reauthFailed();
        }
        const idToken = await googleCodeExchange({
          code,
          clientId: claimed.google_oauth_client_id,
          clientSecret: googleOAuthConfig.GOOGLE_DELETION_OAUTH_CLIENT_SECRET,
          redirectUri: claimed.google_oauth_redirect_uri,
          codeVerifier: claimed.google_pkce_verifier
        });
        const identity = await googleTokenVerifier(idToken, {
          expectedNonceDigest: claimed.nonce_digest,
          issuedAfter: claimed.created_at,
          clientId: claimed.google_oauth_client_id
        });
        await completeGoogleDeletionCallback({
          id: claimed.id, userId: claimed.user_id, sessionId: claimed.session_id,
          subject: identity.subject, expectedNonceDigest: claimed.nonce_digest
        });
        return true;
      } catch {
        // A code may have been redeemed even if the exchange timed out. This
        // callback is terminal: never retry the same code or challenge.
        try { await failGoogleDeletionCallback(claimed.id); } catch { /* fail closed */ }
        return false;
      }
    }
  };
}
