import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { HttpError } from './httpError.js';

const accessTokenSecret = new TextEncoder().encode(env.JWT_SECRET);

export async function createAccessToken(user) {
  const nowInSeconds = Math.floor(Date.now() / 1000);

  return new SignJWT({
    email: user.email,
    type: 'access'
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuedAt(nowInSeconds)
    .setExpirationTime(nowInSeconds + env.JWT_ACCESS_TOKEN_TTL_SECONDS)
    .sign(accessTokenSecret);
}

export async function verifyAccessToken(token) {
  if (typeof token !== 'string') {
    throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
  }

  try {
    const { payload } = await jwtVerify(token, accessTokenSecret, {
      algorithms: ['HS256']
    });

    if (payload?.type !== 'access' || typeof payload?.sub !== 'string') {
      throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
    }

    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      type: payload.type,
      iat: payload.iat,
      exp: payload.exp
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error instanceof joseErrors.JWTExpired) {
      throw new HttpError(401, 'AUTH_TOKEN_EXPIRED', 'Access token expired.');
    }

    throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
  }
}
