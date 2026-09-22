import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ethereumWebhookId = 'wh_test_ethereum';
const baseWebhookId = 'wh_test_base';
const ethereumSecret = 'test-ethereum-signing-secret';
const baseSecret = 'test-base-signing-secret';

process.env.NODE_ENV = 'production';
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/wallet_tracker_webhook_test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_webhook_checks';
process.env.LOG_LEVEL = 'silent';
process.env.ALCHEMY_NOTIFY_API_KEY = 'test-notify-key';
process.env.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET = ethereumWebhookId;
process.env.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET = baseWebhookId;
process.env.ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET = ethereumSecret;
process.env.ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET = baseSecret;
process.env.ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV = 'false';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { getOperationalSignalState } = await import('../src/modules/operations/operationalState.js');
const app = createApp();

function webhookBody(webhookId, network) {
  return JSON.stringify({
    webhookId,
    id: 'evt_test_signature',
    type: 'ADDRESS_ACTIVITY',
    event: { network, activity: [] }
  });
}

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function postWebhook(body, signature) {
  const req = request(app)
    .post('/api/v1/webhooks/alchemy')
    .set('Content-Type', 'application/json');

  if (signature) {
    req.set('X-Alchemy-Signature', signature);
  }

  return req.send(body);
}

test('valid Ethereum webhook signature is accepted with the existing response shape', async () => {
  const body = webhookBody(ethereumWebhookId, 'ETH_MAINNET');
  const response = await postWebhook(body, sign(body, ethereumSecret));

  assert.equal(response.status, 202);
  assert.deepEqual(response.body, {
    data: {
      accepted: true,
      chainId: 'ethereum-mainnet',
      receivedActivities: 0,
      normalizedEvents: 0,
      insertedEvents: 0
    }
  });
});

test('valid Base webhook signature is accepted', async () => {
  const body = webhookBody(baseWebhookId, 'BASE_MAINNET');
  const response = await postWebhook(body, `sha256=${sign(body, baseSecret)}`);

  assert.equal(response.status, 202);
  assert.equal(response.body.data.chainId, 'base-mainnet');
  assert.equal(response.body.data.accepted, true);
});

test('missing signature is rejected in production', async () => {
  const before = getOperationalSignalState().webhook.rejectionCount;
  const response = await postWebhook(webhookBody(ethereumWebhookId, 'ETH_MAINNET'));
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'WEBHOOK_SIGNATURE_MISSING');
  const webhookStatus = getOperationalSignalState().webhook;
  assert.equal(webhookStatus.rejectionCount, before + 1);
  assert.equal(webhookStatus.lastFailure.errorCode, 'WEBHOOK_SIGNATURE_MISSING');
});

for (const [chain, webhookId, network, secret, otherSecret] of [
  ['Ethereum', ethereumWebhookId, 'ETH_MAINNET', ethereumSecret, baseSecret],
  ['Base', baseWebhookId, 'BASE_MAINNET', baseSecret, ethereumSecret]
]) {
  test(`invalid ${chain} signature is rejected`, async () => {
    const body = webhookBody(webhookId, network);
    const response = await postWebhook(body, sign(body, `${secret}-invalid`));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'WEBHOOK_SIGNATURE_INVALID');
  });

  test(`${chain} webhook rejects the other chain's signing secret`, async () => {
    const body = webhookBody(webhookId, network);
    const response = await postWebhook(body, sign(body, otherSecret));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'WEBHOOK_SIGNATURE_INVALID');
  });
}

test('signed webhook rejects a mismatched network and webhook ID', async () => {
  const body = webhookBody(baseWebhookId, 'ETH_MAINNET');
  const response = await postWebhook(body, sign(body, baseSecret));
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'WEBHOOK_NETWORK_MISMATCH');
});

test('unconfigured webhook ID is rejected', async () => {
  const body = webhookBody('wh_unknown', 'ETH_MAINNET');
  const response = await postWebhook(body, sign(body, ethereumSecret));
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'WEBHOOK_ID_INVALID');
});

test('production configuration requires both webhook IDs, both secrets, and the Notify key', () => {
  const baseEnv = {
    ...process.env,
    NODE_ENV: 'production',
    ALCHEMY_NOTIFY_API_KEY: 'test-notify-key',
    ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV: 'false',
    ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET: ethereumWebhookId,
    ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET: baseWebhookId,
    ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET: ethereumSecret,
    ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET: baseSecret
  };

  function checkStartup(overrides) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/app.js';"], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...baseEnv, ...overrides }
    });
  }

  assert.equal(checkStartup({}).status, 0);

  for (const key of [
    'ALCHEMY_NOTIFY_API_KEY',
    'ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET',
    'ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET',
    'ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET',
    'ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET'
  ]) {
    const result = checkStartup({ [key]: '' });
    assert.notEqual(result.status, 0, `${key} must be required in production`);
    assert.match(result.stderr, new RegExp(key));
  }

  assert.notEqual(checkStartup({ ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV: 'true' }).status, 0);
  assert.notEqual(checkStartup({ ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET: ethereumSecret }).status, 0);
  assert.notEqual(checkStartup({ ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET: ethereumWebhookId }).status, 0);
});
