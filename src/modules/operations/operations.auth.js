import crypto from 'node:crypto';
import { HttpError } from '../../utils/httpError.js';

function tokenDigest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

export function createOperationsAuth(configuredToken) {
  return function authorizeOperations(req, res, next) {
    if (!configuredToken) {
      return next(new HttpError(404, 'NOT_FOUND', 'Route not found.'));
    }

    const providedToken = req.get('x-operations-token');
    if (typeof providedToken !== 'string' || providedToken.length === 0 ||
        !crypto.timingSafeEqual(tokenDigest(providedToken), tokenDigest(configuredToken))) {
      return next(new HttpError(401, 'OPERATIONS_AUTH_REQUIRED', 'Operations authorization is required.'));
    }

    return next();
  };
}
