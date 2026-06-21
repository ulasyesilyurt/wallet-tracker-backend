import { findUserById } from '../modules/auth/auth.repository.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { HttpError } from '../utils/httpError.js';

export async function authenticate(req, res, next) {
  try {
    const authorizationHeader = req.headers.authorization;

    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
      throw new HttpError(401, 'AUTH_MISSING_TOKEN', 'Authorization token is required.');
    }

    const token = authorizationHeader.slice('Bearer '.length).trim();
    const payload = verifyAccessToken(token);
    const user = await findUserById(payload.sub);

    if (!user) {
      throw new HttpError(401, 'AUTH_USER_NOT_FOUND', 'Authenticated user no longer exists.');
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
