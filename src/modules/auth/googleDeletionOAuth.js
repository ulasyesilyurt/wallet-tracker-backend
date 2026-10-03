import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { HttpError } from '../../utils/httpError.js';
import { invalidProviderToken, officialJwks, verifyProviderJwt } from './providerJwt.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const googleKeys = officialJwks('google');

export function googleDeletionOAuthConfigIsComplete(config) {
  if (!config?.GOOGLE_DELETION_OAUTH_CLIENT_ID?.trim() ||
      !config?.GOOGLE_DELETION_OAUTH_CLIENT_SECRET?.trim() ||
      !config?.GOOGLE_DELETION_OAUTH_REDIRECT_URI?.trim()) return false;
  try {
    const redirect = new URL(config.GOOGLE_DELETION_OAUTH_REDIRECT_URI);
    return redirect.protocol === 'https:' &&
      redirect.pathname === '/api/v1/auth/account/reauth/google/callback' &&
      !redirect.search && !redirect.hash && !redirect.username && !redirect.password;
  } catch {
    return false;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

export function createGoogleDeletionIdTokenVerifier({ config = env, keyResolver = googleKeys } = {}) {
  return async function verifyGoogleDeletionIdToken(token, { expectedNonceDigest, issuedAfter, clientId } = {}) {
    if (!googleDeletionOAuthConfigIsComplete(config) ||
        clientId !== config.GOOGLE_DELETION_OAUTH_CLIENT_ID ||
        !Buffer.isBuffer(expectedNonceDigest) || expectedNonceDigest.length !== 32 ||
        !(issuedAfter instanceof Date) || !Number.isFinite(issuedAfter.getTime())) {
      throw invalidProviderToken();
    }
    const payload = await verifyProviderJwt(token, keyResolver, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: [clientId]
    });
    if (payload.azp !== undefined && payload.azp !== clientId) throw invalidProviderToken();
    // Google receives the raw nonce and signs that same raw value into the ID
    // token. Apple deletion sign-in instead sends its nonce digest to Apple.
    if (typeof payload.nonce !== 'string' || !payload.nonce || payload.nonce.length > 512 ||
        !timingSafeEqual(sha256(payload.nonce), expectedNonceDigest)) {
      throw invalidProviderToken();
    }
    const earliest = Math.floor(issuedAfter.getTime() / 1000) - 60;
    const latest = Math.floor(Date.now() / 1000) + 60;
    if (!Number.isSafeInteger(payload.iat) || payload.iat < earliest || payload.iat > latest) {
      throw invalidProviderToken();
    }
    return { provider: 'google', subject: payload.sub };
  };
}

export const verifyGoogleDeletionIdToken = createGoogleDeletionIdTokenVerifier();

export function createGoogleCodeExchanger({ fetchImpl = fetch, timeoutMs = env.PROVIDER_REQUEST_TIMEOUT_MS } = {}) {
  return async function exchangeGoogleAuthorizationCode({ code, clientId, clientSecret, redirectUri, codeVerifier }) {
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          grant_type: 'authorization_code'
        }),
        redirect: 'error',
        signal
      });
    } catch {
      throw new HttpError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Authentication provider is unavailable.');
    }
    if (!response.ok) {
      throw new HttpError(response.status >= 500 ? 503 : 401,
        response.status >= 500 ? 'AUTH_PROVIDER_UNAVAILABLE' : 'AUTH_REAUTH_FAILED',
        'Google account proof could not be verified.');
    }
    let tokens;
    try {
      tokens = await response.json();
    } catch {
      throw new HttpError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Authentication provider is unavailable.');
    }
    if (typeof tokens?.id_token !== 'string' || !tokens.id_token || tokens.id_token.length > 16_384) {
      throw new HttpError(401, 'AUTH_REAUTH_FAILED', 'Google account proof could not be verified.');
    }
    return tokens.id_token;
  };
}

export const exchangeGoogleAuthorizationCode = createGoogleCodeExchanger();
