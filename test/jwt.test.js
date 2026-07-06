import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'dev_jwt_secret_that_is_long_enough_for_local_checks';
process.env.JWT_ACCESS_TOKEN_TTL_SECONDS ??= '604800';

const { createAccessToken, verifyAccessToken } = await import('../src/utils/jwt.js');
const { HttpError } = await import('../src/utils/httpError.js');

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function buildLegacyHs256Token(payload) {
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const unsignedToken = `${header}.${encodedPayload}`;
  const signature = createHmac('sha256', process.env.JWT_SECRET)
    .update(unsignedToken)
    .digest('base64url');

  return `${unsignedToken}.${signature}`;
}

async function expectHttpError(promise, expectedCode) {
  await assert.rejects(
    promise,
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, expectedCode);
      return true;
    }
  );
}

describe('JWT verification', () => {
  test('accepts a valid access token', async () => {
    const user = {
      id: '54b2cc03-64b5-4a9d-9770-9d9a960f7f7a',
      email: 'valid@example.com'
    };

    const token = await createAccessToken(user);
    const payload = await verifyAccessToken(token);

    assert.equal(payload.sub, user.id);
    assert.equal(payload.email, user.email);
    assert.equal(payload.type, 'access');
    assert.equal(typeof payload.iat, 'number');
    assert.equal(typeof payload.exp, 'number');
  });

  test('rejects an expired token', async () => {
    const expiredToken = buildLegacyHs256Token({
      sub: '85d90da4-2f1d-4423-95d2-4b067c27dc80',
      email: 'expired@example.com',
      type: 'access',
      iat: Math.floor(Date.now() / 1000) - 120,
      exp: Math.floor(Date.now() / 1000) - 60
    });

    await expectHttpError(verifyAccessToken(expiredToken), 'AUTH_TOKEN_EXPIRED');
  });

  test('rejects an invalid token signature', async () => {
    const validToken = await createAccessToken({
      id: '834a523f-1dd5-4406-b929-5d318e5fa71e',
      email: 'invalid@example.com'
    });
    const invalidToken = `${validToken.slice(0, -1)}x`;

    await expectHttpError(verifyAccessToken(invalidToken), 'AUTH_INVALID_TOKEN');
  });

  test('rejects a wrong token type', async () => {
    const wrongTypeToken = buildLegacyHs256Token({
      sub: '7cc78e0b-db00-4b57-bdfe-46a416ae9d40',
      email: 'wrong-type@example.com',
      type: 'refresh',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    await expectHttpError(verifyAccessToken(wrongTypeToken), 'AUTH_INVALID_TOKEN');
  });

  test('accepts a legacy custom HS256 token', async () => {
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const legacyToken = buildLegacyHs256Token({
      sub: '7e0c3fca-e5a4-43c8-81ef-61f2578ca0da',
      email: 'legacy@example.com',
      type: 'access',
      iat: nowInSeconds,
      exp: nowInSeconds + 3600
    });

    const payload = await verifyAccessToken(legacyToken);

    assert.equal(payload.sub, '7e0c3fca-e5a4-43c8-81ef-61f2578ca0da');
    assert.equal(payload.email, 'legacy@example.com');
    assert.equal(payload.type, 'access');
  });
});
