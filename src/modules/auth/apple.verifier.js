import { timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import {
  claimIsTrue, invalidProviderToken, officialJwks, optionalClaimString,
  requireProviderConfig, verifyProviderJwt
} from './providerJwt.js';

const appleKeys = officialJwks('apple');

function nonceMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected === '') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createAppleIdTokenVerifier({ config = env, keyResolver = appleKeys } = {}) {
  // expectedNonce is the exact value placed in Apple's signed nonce claim. If the
  // client hashes a raw nonce before authorization, pass that hash here.
  return async function verifyAppleIdToken(token, { expectedNonce, issuedAfter } = {}) {
    const clientIds = config.APPLE_CLIENT_IDS;
    requireProviderConfig(config.APPLE_AUTH_ENABLED, clientIds);
    if (typeof expectedNonce !== 'string' || expectedNonce === '') throw invalidProviderToken();
    const payload = await verifyProviderJwt(token, keyResolver, {
      issuer: 'https://appleid.apple.com',
      audience: clientIds
    });
    if (!nonceMatches(payload.nonce, expectedNonce)) throw invalidProviderToken();
    if (issuedAfter !== undefined) {
      // Deletion reauth uses a server-issued nonce. Check that Apple's signed
      // token was also issued around this short-lived challenge.
      const earliest = Math.floor(issuedAfter.getTime() / 1000) - 60;
      const latest = Math.floor(Date.now() / 1000) + 60;
      if (!Number.isSafeInteger(payload.iat) || payload.iat < earliest || payload.iat > latest) {
        throw invalidProviderToken();
      }
    }
    return {
      provider: 'apple',
      subject: payload.sub,
      email: optionalClaimString(payload.email),
      emailVerified: claimIsTrue(payload.email_verified),
      isPrivateEmail: claimIsTrue(payload.is_private_email)
    };
  };
}

export const verifyAppleIdToken = createAppleIdTokenVerifier();
