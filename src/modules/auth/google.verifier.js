import { env } from '../../config/env.js';
import {
  claimIsTrue, invalidProviderToken, officialJwks, optionalClaimString,
  requireProviderConfig, verifyProviderJwt
} from './providerJwt.js';

const googleKeys = officialJwks('google');

export function createGoogleIdTokenVerifier({ config = env, keyResolver = googleKeys } = {}) {
  return async function verifyGoogleIdToken(token) {
    const clientIds = config.GOOGLE_CLIENT_IDS;
    requireProviderConfig(config.GOOGLE_AUTH_ENABLED, clientIds);
    const payload = await verifyProviderJwt(token, keyResolver, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientIds
    });
    if (payload.azp !== undefined &&
        (typeof payload.azp !== 'string' || !clientIds.includes(payload.azp))) {
      throw invalidProviderToken();
    }
    return {
      provider: 'google',
      subject: payload.sub,
      email: optionalClaimString(payload.email),
      emailVerified: claimIsTrue(payload.email_verified),
      hostedDomain: optionalClaimString(payload.hd)
    };
  };
}

export const verifyGoogleIdToken = createGoogleIdTokenVerifier();
