import { HttpError } from '../../utils/httpError.js';
import { verifyPassword } from '../../utils/password.js';
import { findUserById } from './auth.repository.js';
import { identityUniqueConflict } from './identity.repository.js';
import { linkProviderIdentity, unlinkProviderIdentity } from './identityManagement.repository.js';
import { verifyGoogleIdToken } from './google.verifier.js';
import { verifyAppleIdToken } from './apple.verifier.js';

function reauthRequired() {
  return new HttpError(401, 'AUTH_REAUTH_REQUIRED', 'Current password is required.');
}

function reauthFailed() {
  return new HttpError(401, 'AUTH_REAUTH_FAILED', 'Current account proof is invalid.');
}

function reauthUnavailable() {
  return new HttpError(403, 'AUTH_REAUTH_METHOD_UNAVAILABLE', 'Fresh account proof is unavailable for this account.');
}

function managedSessionId(auth) {
  if (!auth.payload.sid) {
    throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'A session-backed access token is required.');
  }
  return auth.payload.sid;
}

async function verifyCurrentPassword(userId, currentPassword) {
  const user = await findUserById(userId);
  if (!user?.passwordHash) throw reauthUnavailable();
  if (typeof currentPassword !== 'string' || currentPassword.length === 0) throw reauthRequired();
  if (!await verifyPassword(currentPassword, user.passwordHash)) throw reauthFailed();
  return user.passwordHash;
}

export function createIdentityManagement({
  googleVerifier = verifyGoogleIdToken,
  appleVerifier = verifyAppleIdToken
} = {}) {
  return {
    async link(auth, request) {
      const sessionId = managedSessionId(auth);
      const expectedPasswordHash = await verifyCurrentPassword(auth.user.id, request.currentPassword);
      // The current account is freshly proved before checking the new provider.
      const identity = request.provider === 'google'
        ? await googleVerifier(request.idToken)
        : await appleVerifier(request.identityToken, { expectedNonce: request.expectedNonce });
      try {
        return await linkProviderIdentity({
          userId: auth.user.id,
          sessionId,
          expectedPasswordHash,
          provider: request.provider,
          subject: identity.subject
        });
      } catch (error) {
        const conflict = identityUniqueConflict(error);
        if (conflict === 'subject_taken') {
          throw new HttpError(409, 'AUTH_IDENTITY_LINKED_ELSEWHERE', 'Provider identity is unavailable.');
        }
        if (conflict === 'provider_already_linked') {
          throw new HttpError(409, 'AUTH_IDENTITY_ALREADY_LINKED', 'This account already has that provider.');
        }
        throw error;
      }
    },

    async unlink(auth, { provider, currentPassword }) {
      const sessionId = managedSessionId(auth);
      const user = await findUserById(auth.user.id);
      const expectedPasswordHash = user?.passwordHash
        ? await verifyCurrentPassword(auth.user.id, currentPassword)
        : null;
      return unlinkProviderIdentity({
        userId: auth.user.id,
        sessionId,
        expectedPasswordHash,
        provider
      });
    }
  };
}
