import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { HttpError } from '../../utils/httpError.js';

const JWKS_OPTIONS = {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60_000
};

export function officialJwks(provider) {
  const endpoints = {
    google: 'https://www.googleapis.com/oauth2/v3/certs',
    apple: 'https://appleid.apple.com/auth/keys'
  };
  const url = endpoints[provider];
  if (!url) throw new TypeError('Unsupported identity provider.');
  return createRemoteJWKSet(new URL(url), JWKS_OPTIONS);
}

export function providerUnavailable() {
  return new HttpError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Authentication provider is unavailable.');
}

export function invalidProviderToken() {
  return new HttpError(401, 'AUTH_INVALID_PROVIDER_TOKEN', 'Invalid provider identity token.');
}

export function requireProviderConfig(enabled, clientIds) {
  if (enabled !== true || !Array.isArray(clientIds) || clientIds.length === 0 ||
      clientIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw providerUnavailable();
  }
}

export async function verifyProviderJwt(token, keyResolver, { issuer, audience }) {
  if (typeof token !== 'string' || token.trim() === '') throw invalidProviderToken();
  try {
    const { payload } = await jwtVerify(token, keyResolver, {
      algorithms: ['RS256'],
      issuer,
      audience,
      requiredClaims: ['exp', 'sub']
    });
    if (typeof payload.aud !== 'string' || !audience.includes(payload.aud) ||
        typeof payload.sub !== 'string' || payload.sub.trim() === '') {
      throw invalidProviderToken();
    }
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof joseErrors.JWKSTimeout) throw providerUnavailable();
    if (error instanceof joseErrors.JOSEError) throw invalidProviderToken();
    throw providerUnavailable();
  }
}

export function optionalClaimString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function claimIsTrue(value) {
  return value === true || value === 'true';
}
