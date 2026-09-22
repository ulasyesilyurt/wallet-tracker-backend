import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requestScript = `
  import assert from 'node:assert/strict';
  import request from 'supertest';
  import { createApp } from './src/app.js';
  import { logger } from './src/config/logger.js';

  const response = await request(createApp())
    .get('/api/v1/health')
    .set('AuThOrIzAtIoN', 'Bearer test-secret-token')
    .set('Proxy-Authorization', 'Basic test-proxy-secret')
    .set('Cookie', 'session=test-cookie-secret')
    .set('X-Api-Key', 'test-api-key-secret')
    .set('X-Operations-Token', 'test-operations-secret')
    .set('X-Alchemy-Token', 'test-alchemy-secret')
    .set('X-Alchemy-Signature', 'test-signature-secret')
    .set('X-Request-Id', 'safe-request-marker');

  assert.equal(response.status, 200);
  logger.info({
    res: {
      statusCode: 200,
      headers: {
        'set-cookie': 'session=test-response-cookie-secret',
        'x-request-id': 'safe-response-marker'
      }
    }
  }, 'Response header redaction check');
`;

for (const nodeEnv of ['development', 'production']) {
  test(`HTTP logs redact credential headers in ${nodeEnv}`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', requestScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: nodeEnv,
        DATABASE_URL: 'postgresql://localhost:5432/wallet_tracker_logging_test',
        JWT_SECRET: 'test_jwt_secret_that_is_long_enough_for_logging_checks',
        LOG_LEVEL: 'info',
        GLOBAL_API_RATE_LIMIT_MAX: '1000',
        ALCHEMY_NOTIFY_API_KEY: 'test-notify-key',
        ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET: 'wh_logging_ethereum',
        ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET: 'wh_logging_base',
        ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET: 'test-logging-ethereum-secret',
        ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET: 'test-logging-base-secret',
        ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV: 'false'
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const logs = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    const httpLog = logs.find((entry) => entry.req?.url === '/api/v1/health');
    const responseLog = logs.find((entry) => entry.msg === 'Response header redaction check');

    assert.ok(httpLog);
    assert.ok(responseLog);
    assert.equal(httpLog.req.method, 'GET');
    assert.equal(httpLog.res.statusCode, 200);
    assert.equal(httpLog.req.headers.authorization, '[Redacted]');
    assert.equal(httpLog.req.headers['proxy-authorization'], '[Redacted]');
    assert.equal(httpLog.req.headers.cookie, '[Redacted]');
    assert.equal(httpLog.req.headers['x-api-key'], '[Redacted]');
    assert.equal(httpLog.req.headers['x-operations-token'], '[Redacted]');
    assert.equal(httpLog.req.headers['x-alchemy-token'], '[Redacted]');
    assert.equal(httpLog.req.headers['x-alchemy-signature'], '[Redacted]');
    assert.equal(responseLog.res.headers['set-cookie'], '[Redacted]');
    assert.equal(httpLog.req.headers['x-request-id'], 'safe-request-marker');
    assert.equal(responseLog.res.headers['x-request-id'], 'safe-response-marker');

    for (const secret of [
      'test-secret-token',
      'test-proxy-secret',
      'test-cookie-secret',
      'test-api-key-secret',
      'test-operations-secret',
      'test-alchemy-secret',
      'test-signature-secret',
      'test-response-cookie-secret'
    ]) {
      assert.equal(result.stdout.includes(secret), false);
    }
  });
}
