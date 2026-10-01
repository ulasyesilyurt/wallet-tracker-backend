import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_user_resurrection';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '1000';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';
process.env.ALCHEMY_NOTIFY_API_KEY = 'test-notify-key';
process.env.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET = 'wh_user_resurrection_test';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { createWallet } = await import('../src/modules/wallets/wallets.service.js');
const { registerDeviceToken } = await import('../src/modules/deviceTokens/deviceTokens.service.js');

const app = createApp();
const userIds = new Set();
const originalFetch = global.fetch;

after(async () => {
  global.fetch = originalFetch;
  try {
    await query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [[...userIds]]);
  } finally {
    await pool.end();
  }
});

function randomAddress() {
  return `0x${randomBytes(20).toString('hex')}`;
}

function walletFor(userId) {
  return {
    userId,
    chainId: 'ethereum-mainnet',
    enabledChains: ['ethereum-mainnet'],
    address: randomAddress(),
    trackTypes: ['native_transfer']
  };
}

function isMissingUser(error) {
  return error.statusCode === 401 && error.code === 'AUTH_USER_NOT_FOUND';
}

async function registerVerifiedUser() {
  const response = await request(app).post('/api/v1/auth/register').send({
    email: `resurrection-${randomUUID()}@example.test`,
    password: 'resurrection-password-123'
  });
  assert.equal(response.status, 201);
  const userId = response.body.data.user.id;
  userIds.add(userId);
  await query('UPDATE app_users SET email_verified_at = NOW() WHERE id = $1', [userId]);
  return { userId, accessToken: response.body.data.accessToken };
}

test('registration still creates a user and existing-user wallet and device writes succeed', async () => {
  const { userId, accessToken } = await registerVerifiedUser();
  const wallet = walletFor(userId);
  const fcmToken = `resurrection-device-${randomUUID()}`;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });

  const createdWallet = await request(app).post(`/api/v1/users/${userId}/wallets`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ address: wallet.address, enabledChains: wallet.enabledChains, trackTypes: wallet.trackTypes });
  assert.equal(createdWallet.status, 201);
  const createdDevice = await request(app).post(`/api/v1/users/${userId}/device-tokens`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ token: fcmToken, platform: 'ios' });
  assert.equal(createdDevice.status, 201);
  assert.equal((await query('SELECT id FROM app_users WHERE id = $1', [userId])).rowCount, 1);
  assert.equal((await query('SELECT id FROM tracked_wallets WHERE user_id = $1', [userId])).rowCount, 1);
  assert.equal((await query('SELECT id FROM device_tokens WHERE user_id = $1', [userId])).rowCount, 1);
});

test('captured authenticated user ID cannot recreate an account after deletion', async () => {
  const { userId, accessToken } = await registerVerifiedUser();
  assert.equal((await request(app).get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${accessToken}`)).status, 200);
  await query('DELETE FROM app_users WHERE id = $1', [userId]);

  const wallet = walletFor(userId);
  const fcmToken = `resurrection-device-${randomUUID()}`;
  await assert.rejects(createWallet(wallet), isMissingUser);
  await assert.rejects(registerDeviceToken({ userId, fcmToken, platform: 'ios' }), isMissingUser);

  const rejectedWallet = await request(app).post(`/api/v1/users/${userId}/wallets`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ address: wallet.address, enabledChains: wallet.enabledChains, trackTypes: wallet.trackTypes });
  assert.equal(rejectedWallet.status, 401);
  assert.equal(rejectedWallet.body.error.code, 'AUTH_USER_NOT_FOUND');
  const rejectedDevice = await request(app).post(`/api/v1/users/${userId}/device-tokens`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ token: fcmToken, platform: 'ios' });
  assert.equal(rejectedDevice.status, 401);
  assert.equal(rejectedDevice.body.error.code, 'AUTH_USER_NOT_FOUND');

  assert.equal((await query('SELECT id FROM app_users WHERE id = $1', [userId])).rowCount, 0);
  assert.equal((await query('SELECT id FROM tracked_wallets WHERE user_id = $1', [userId])).rowCount, 0);
  assert.equal((await query('SELECT id FROM device_tokens WHERE user_id = $1', [userId])).rowCount, 0);
});

test('a missing user cannot claim an existing device token from another account', async () => {
  const owner = await registerVerifiedUser();
  const removed = await registerVerifiedUser();
  const fcmToken = `resurrection-device-${randomUUID()}`;
  await registerDeviceToken({ userId: owner.userId, fcmToken, platform: 'ios' });
  await query('DELETE FROM app_users WHERE id = $1', [removed.userId]);

  await assert.rejects(
    registerDeviceToken({ userId: removed.userId, fcmToken, platform: 'ios' }),
    isMissingUser
  );
  const token = await query('SELECT user_id FROM device_tokens WHERE fcm_token = $1', [fcmToken]);
  assert.equal(token.rows[0].user_id, owner.userId);
  assert.equal((await query('SELECT id FROM app_users WHERE id = $1', [removed.userId])).rowCount, 0);
});

test('wallet and device writes fail when their user is deleted during the write', async () => {
  const { userId } = await registerVerifiedUser();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM app_users WHERE id = $1', [userId]);
    const walletFailure = assert.rejects(createWallet(walletFor(userId)), isMissingUser);
    const deviceFailure = assert.rejects(registerDeviceToken({
      userId, fcmToken: `resurrection-device-${randomUUID()}`, platform: 'ios'
    }), isMissingUser);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await client.query('COMMIT');
    committed = true;
    await Promise.all([walletFailure, deviceFailure]);
  } finally {
    if (!committed) await client.query('ROLLBACK');
    client.release();
  }
  assert.equal((await query('SELECT id FROM app_users WHERE id = $1', [userId])).rowCount, 0);
  assert.equal((await query('SELECT id FROM tracked_wallets WHERE user_id = $1', [userId])).rowCount, 0);
  assert.equal((await query('SELECT id FROM device_tokens WHERE user_id = $1', [userId])).rowCount, 0);
});
