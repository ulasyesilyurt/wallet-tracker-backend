import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://localhost/provider_verifier_test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_provider_verifiers';

const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import('jose');
const { createGoogleIdTokenVerifier } = await import('../src/modules/auth/google.verifier.js');
const { createAppleIdTokenVerifier } = await import('../src/modules/auth/apple.verifier.js');
const { parseEnvironment } = await import('../src/config/env.js');

async function testKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'offline-test-key', alg: 'RS256', use: 'sig' };
  return { privateKey, keyResolver: createLocalJWKSet({ keys: [jwk] }) };
}

const trusted = await testKeys();
const untrusted = await testKeys();
const googleConfig = { GOOGLE_AUTH_ENABLED: true, GOOGLE_CLIENT_IDS: ['google-ios', 'google-web'] };
const appleConfig = { APPLE_AUTH_ENABLED: true, APPLE_CLIENT_IDS: ['apple-bundle', 'apple-service'] };
const verifyGoogle = createGoogleIdTokenVerifier({ config: googleConfig, keyResolver: trusted.keyResolver });
const verifyApple = createAppleIdTokenVerifier({ config: appleConfig, keyResolver: trusted.keyResolver });

async function signToken(privateKey, { issuer, audience, subject, expiresIn = 3600, claims = {} }) {
  let jwt = new SignJWT(typeof subject === 'number' ? { ...claims, sub: subject } : claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'offline-test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt();
  if (expiresIn !== null) jwt = jwt.setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn);
  if (typeof subject === 'string') jwt = jwt.setSubject(subject);
  return jwt.sign(privateKey);
}

const googleToken = (overrides = {}) => signToken(overrides.privateKey ?? trusted.privateKey, {
  issuer: overrides.issuer ?? 'https://accounts.google.com',
  audience: overrides.audience ?? 'google-ios',
  subject: Object.hasOwn(overrides, 'subject') ? overrides.subject : 'google-subject',
  expiresIn: Object.hasOwn(overrides, 'expiresIn') ? overrides.expiresIn : 3600,
  claims: overrides.claims ?? { email: 'person@gmail.com', email_verified: true, hd: 'example.com' }
});

const appleToken = (overrides = {}) => signToken(overrides.privateKey ?? trusted.privateKey, {
  issuer: overrides.issuer ?? 'https://appleid.apple.com',
  audience: overrides.audience ?? 'apple-bundle',
  subject: Object.hasOwn(overrides, 'subject') ? overrides.subject : 'apple-subject',
  expiresIn: Object.hasOwn(overrides, 'expiresIn') ? overrides.expiresIn : 3600,
  claims: overrides.claims ?? { nonce: 'expected-hash', email: 'relay@privaterelay.appleid.com', email_verified: 'true', is_private_email: 'true' }
});

async function invalid(action) {
  await assert.rejects(action, (error) => error?.statusCode === 401 && error.code === 'AUTH_INVALID_PROVIDER_TOKEN');
}

test('Google accepts a valid token and either configured audience and issuer', async () => {
  assert.deepEqual(await verifyGoogle(await googleToken()), {
    provider: 'google', subject: 'google-subject', email: 'person@gmail.com',
    emailVerified: true, hostedDomain: 'example.com'
  });
  const second = await verifyGoogle(await googleToken({ issuer: 'accounts.google.com', audience: 'google-web' }));
  assert.equal(second.subject, 'google-subject');
});

test('Google rejects invalid signature, issuer, audience, expiry and subject', async () => {
  await invalid(async () => verifyGoogle(await googleToken({ privateKey: untrusted.privateKey })));
  await invalid(async () => verifyGoogle(await googleToken({ issuer: 'https://attacker.example' })));
  await invalid(async () => verifyGoogle(await googleToken({ audience: 'attacker-client' })));
  await invalid(async () => verifyGoogle(await googleToken({ expiresIn: -10 })));
  await invalid(async () => verifyGoogle(await googleToken({ expiresIn: null })));
  await invalid(async () => verifyGoogle(await googleToken({ audience: ['google-ios', 'google-web'] })));
  await invalid(async () => verifyGoogle(await googleToken({ subject: undefined })));
  await invalid(async () => verifyGoogle(await googleToken({ subject: '   ' })));
  await invalid(async () => verifyGoogle(await googleToken({ subject: 42 })));
});

test('Google validates azp and returns email claims without account decisions', async () => {
  await invalid(async () => verifyGoogle(await googleToken({ claims: { azp: 'attacker-client' } })));
  const verified = await verifyGoogle(await googleToken({ claims: {
    azp: 'google-web', email: 'person@third-party.test', email_verified: 'true'
  } }));
  assert.equal(verified.emailVerified, true);
  assert.equal(verified.email, 'person@third-party.test');
  const unverified = await verifyGoogle(await googleToken({ claims: { email: 'person@example.test', email_verified: false } }));
  assert.equal(unverified.emailVerified, false);
  assert.equal(unverified.hostedDomain, null);
});

test('Apple accepts verified token, alternate audience and private relay claims', async () => {
  assert.deepEqual(await verifyApple(await appleToken(), { expectedNonce: 'expected-hash' }), {
    provider: 'apple', subject: 'apple-subject', email: 'relay@privaterelay.appleid.com',
    emailVerified: true, isPrivateEmail: true
  });
  const second = await verifyApple(await appleToken({ audience: 'apple-service' }), { expectedNonce: 'expected-hash' });
  assert.equal(second.subject, 'apple-subject');
});

test('Apple rejects invalid signature, issuer, audience, expiry and subject', async () => {
  const nonce = { expectedNonce: 'expected-hash' };
  await invalid(async () => verifyApple(await appleToken({ privateKey: untrusted.privateKey }), nonce));
  await invalid(async () => verifyApple(await appleToken({ issuer: 'https://attacker.example' }), nonce));
  await invalid(async () => verifyApple(await appleToken({ audience: 'attacker-client' }), nonce));
  await invalid(async () => verifyApple(await appleToken({ expiresIn: -10 }), nonce));
  await invalid(async () => verifyApple(await appleToken({ expiresIn: null }), nonce));
  await invalid(async () => verifyApple(await appleToken({ audience: ['apple-bundle', 'apple-service'] }), nonce));
  await invalid(async () => verifyApple(await appleToken({ subject: undefined }), nonce));
  await invalid(async () => verifyApple(await appleToken({ subject: '' }), nonce));
});

test('Apple requires an exact nonce and tolerates absent email', async () => {
  const token = await appleToken({ claims: { nonce: 'expected-hash' } });
  const result = await verifyApple(token, { expectedNonce: 'expected-hash' });
  assert.equal(result.email, null);
  assert.equal(result.emailVerified, false);
  assert.equal(result.isPrivateEmail, false);
  await invalid(() => verifyApple(token, { expectedNonce: 'different-hash' }));
  await invalid(() => verifyApple(token));
  await invalid(async () => verifyApple(await appleToken({ claims: {} }), { expectedNonce: 'expected-hash' }));
});

test('disabled or misconfigured providers fail closed before token verification', async () => {
  for (const config of [
    { GOOGLE_AUTH_ENABLED: false, GOOGLE_CLIENT_IDS: ['google-ios'] },
    { GOOGLE_AUTH_ENABLED: true, GOOGLE_CLIENT_IDS: [] }
  ]) {
    const verify = createGoogleIdTokenVerifier({ config, keyResolver: trusted.keyResolver });
    await assert.rejects(() => verify('token'), (error) => error?.statusCode === 503 && error.code === 'AUTH_PROVIDER_UNAVAILABLE');
  }
  for (const config of [
    { APPLE_AUTH_ENABLED: false, APPLE_CLIENT_IDS: ['apple-bundle'] },
    { APPLE_AUTH_ENABLED: true, APPLE_CLIENT_IDS: [] }
  ]) {
    const verify = createAppleIdTokenVerifier({ config, keyResolver: trusted.keyResolver });
    await assert.rejects(() => verify('token', { expectedNonce: 'nonce' }), (error) => error?.statusCode === 503 && error.code === 'AUTH_PROVIDER_UNAVAILABLE');
  }
});

test('unsupported signing algorithms and JWKS failures fail safely', async () => {
  const weakToken = await new SignJWT({ sub: 'subject', nonce: 'expected-hash' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://appleid.apple.com')
    .setAudience('apple-bundle')
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode('local-test-secret-that-is-not-a-provider-key'));
  await invalid(() => verifyApple(weakToken, { expectedNonce: 'expected-hash' }));
  const unavailable = createGoogleIdTokenVerifier({
    config: googleConfig,
    keyResolver: async () => { throw new Error('offline JWKS failure'); }
  });
  await assert.rejects(async () => unavailable(await googleToken()), (error) =>
    error?.statusCode === 503 && error.code === 'AUTH_PROVIDER_UNAVAILABLE');
});

test('provider client-ID env lists require exact, distinct IDs when enabled', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/test', JWT_SECRET: 'x'.repeat(32) };
  const parsed = parseEnvironment({ ...base, GOOGLE_AUTH_ENABLED: 'true', GOOGLE_CLIENT_IDS: ' google-ios, google-web ', APPLE_AUTH_ENABLED: 'true', APPLE_CLIENT_IDS: 'apple-bundle,apple-service' });
  assert.deepEqual(parsed.GOOGLE_CLIENT_IDS, ['google-ios', 'google-web']);
  assert.deepEqual(parsed.APPLE_CLIENT_IDS, ['apple-bundle', 'apple-service']);
  assert.throws(() => parseEnvironment({ ...base, GOOGLE_AUTH_ENABLED: 'true' }), /GOOGLE_CLIENT_IDS/);
  assert.throws(() => parseEnvironment({ ...base, APPLE_AUTH_ENABLED: 'true' }), /APPLE_CLIENT_IDS/);
  assert.throws(() => parseEnvironment({ ...base, GOOGLE_CLIENT_IDS: 'one,,two' }), /GOOGLE_CLIENT_IDS/);
  assert.throws(() => parseEnvironment({ ...base, APPLE_CLIENT_IDS: 'one,one' }), /APPLE_CLIENT_IDS/);
});
