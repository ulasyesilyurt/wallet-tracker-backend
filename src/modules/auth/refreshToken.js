import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function digestRefreshToken(token) {
  if (typeof token !== 'string' || !REFRESH_TOKEN_PATTERN.test(token)) return null;
  return createHash('sha256').update(token, 'utf8').digest();
}

export function createRefreshCredential() {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, digest: digestRefreshToken(token) };
}

export function matchesRefreshDigest(storedDigest, candidateDigest) {
  return Buffer.isBuffer(storedDigest) && Buffer.isBuffer(candidateDigest) &&
    storedDigest.length === 32 && candidateDigest.length === 32 &&
    timingSafeEqual(storedDigest, candidateDigest);
}
