import { findUserById } from '../modules/auth/auth.repository.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { HttpError } from '../utils/httpError.js';

async function authenticateRequest(req, res, next, allowUnverified) {
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

    if (!allowUnverified && !user.emailVerifiedAt) {
      throw new HttpError(403, 'AUTH_EMAIL_VERIFICATION_REQUIRED', 'Verify your email before accessing this resource.');
    }

    req.auth = {
      token,
      user
    };

    next();
  } catch (error) {
    next(error);
  }
}

export function authenticate(req, res, next) {
  return authenticateRequest(req, res, next, false);
}

export function authenticateAllowUnverified(req, res, next) {
  return authenticateRequest(req, res, next, true);
}
