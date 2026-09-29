import { findUserById } from '../modules/auth/auth.repository.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { HttpError } from '../utils/httpError.js';
import { findSessionById } from '../modules/auth/session.repository.js';

async function authenticateRequest(req, res, next, { allowUnverified = false, allowRevoked = false } = {}) {
  try {
    const authorizationHeader = req.headers.authorization;

    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
      throw new HttpError(401, 'AUTH_MISSING_TOKEN', 'Authorization token is required.');
    }

    const token = authorizationHeader.slice('Bearer '.length).trim();
    const payload = await verifyAccessToken(token);
    const user = await findUserById(payload.sub);

    if (!user) {
      throw new HttpError(401, 'AUTH_USER_NOT_FOUND', 'Authenticated user no longer exists.');
    }

    if (payload.sid) {
      const session = await findSessionById(payload.sid);
      if (!session || session.user_id !== user.id || (session.revoked_at && !allowRevoked)) {
        throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
      }
    } else if (user.legacyAccessRevokedAt && !allowRevoked &&
        payload.iat <= Math.floor(user.legacyAccessRevokedAt.getTime() / 1000)) {
      throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
    }

    if (!allowUnverified && !user.emailVerifiedAt) {
      throw new HttpError(403, 'AUTH_EMAIL_VERIFICATION_REQUIRED', 'Verify your email before accessing this resource.');
    }

    req.auth = {
      token,
      user,
      payload
    };

    next();
  } catch (error) {
    next(error);
  }
}

export function authenticate(req, res, next) {
  return authenticateRequest(req, res, next);
}

export function authenticateAllowUnverified(req, res, next) {
  return authenticateRequest(req, res, next, { allowUnverified: true });
}

export function authenticateForLogout(req, res, next) {
  return authenticateRequest(req, res, next, { allowUnverified: true, allowRevoked: true });
}
