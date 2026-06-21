import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';
import { HttpError } from './httpError.js';

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));

  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function sign(unsignedToken) {
  return createHmac('sha256', env.JWT_SECRET).update(unsignedToken).digest('base64url');
}

export function createAccessToken(user) {
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = encodeBase64Url(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      type: 'access',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + env.JWT_ACCESS_TOKEN_TTL_SECONDS
    })
  );
  const unsignedToken = `${header}.${payload}`;
  const signature = sign(unsignedToken);

  return `${unsignedToken}.${signature}`;
}

export function verifyAccessToken(token) {
  if (typeof token !== 'string') {
    throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
  }

  const parts = token.split('.');

  if (parts.length !== 3) {
    throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
  }

  const [header, payload, signature] = parts;
  const unsignedToken = `${header}.${payload}`;
  const expectedSignature = sign(unsignedToken);

  if (signature !== expectedSignature) {
    throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
  }

  let parsedPayload;

  try {
    parsedPayload = JSON.parse(decodeBase64Url(payload));
  } catch {
    throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
  }

  if (parsedPayload?.type !== 'access' || typeof parsedPayload?.sub !== 'string') {
    throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
  }

  if (typeof parsedPayload?.exp !== 'number' || parsedPayload.exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, 'AUTH_TOKEN_EXPIRED', 'Access token expired.');
  }

  return parsedPayload;
}
