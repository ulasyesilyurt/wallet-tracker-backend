import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_account_deletion';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '1000';
process.env.AUTH_IDENTITY_MANAGEMENT_RATE_LIMIT_MAX = '1000';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import('jose');
const { createApp } = await import('../src/app.js');
const { createAppleIdTokenVerifier } = await import('../src/modules/auth/apple.verifier.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { verifyAccessToken } = await import('../src/utils/jwt.js');
const { createWalletWithPreferences } = await import('../src/modules/wallets/wallets.repository.js');
const { createWallet } = await import('../src/modules/wallets/wallets.service.js');
const { registerDeviceToken } = await import('../src/modules/deviceTokens/deviceTokens.service.js');
const { isAlchemyAddressDesired, withAlchemyAddressPairLock } =
  await import('../src/modules/webhooks/alchemyAddressReconciliation.repository.js');
const { processNotificationOutboxJob } = await import('../src/modules/notifications/notifications.service.js');

const ethereum = 'ethereum-mainnet';
const base = 'base-mainnet';
const password = 'account-deletion-password-123';
const users = new Set();
const addresses = new Set();
const keys = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(keys.publicKey), kid: 'account-delete-test', alg: 'RS256', use: 'sig' };
const appleVerifier = createAppleIdTokenVerifier({
  config: { APPLE_AUTH_ENABLED: true, APPLE_CLIENT_IDS: ['account-delete-test-client'] },
  keyResolver: createLocalJWKSet({ keys: [publicJwk] })
});
const resetCodes = [];
const app = createApp({
  authAppleVerifier: appleVerifier,
  authGoogleVerifier: async (idToken) => ({
    subject: idToken,
    email: `${idToken}@gmail.com`,
    emailVerified: true
  }),
  authEmailService: {
    async sendPasswordResetCode(to, code) { resetCodes.push({ to, code }); },
    async sendVerificationCode() {}
  }
});

after(async () => {
  try {
    await query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [[...users]]);
    await query('DELETE FROM alchemy_address_reconciliation WHERE normalized_address = ANY($1::text[])',
      [[...addresses]]);
  } finally {
    await pool.end();
  }
});

function address() {
  const value = `0x${randomBytes(20).toString('hex')}`;
  addresses.add(value);
  return value;
}

async function register({ verified = true, refresh = false } = {}) {
  const email = `account-delete-${randomUUID()}@example.test`;
  const response = await request(app).post('/api/v1/auth/register')
    .set('x-auth-refresh', String(refresh)).send({ email, password });
  assert.equal(response.status, 201);
  const account = response.body.data;
  users.add(account.user.id);
  if (verified) await query('UPDATE app_users SET email_verified_at = NOW() WHERE id = $1', [account.user.id]);
  return account;
}

async function appleToken({ subject, email, nonce }) {
  return new SignJWT({ nonce, email, email_verified: 'true' })
    .setProtectedHeader({ alg: 'RS256', kid: 'account-delete-test' })
    .setIssuer('https://appleid.apple.com')
    .setAudience('account-delete-test-client')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}

async function appleAccount() {
  const subject = `apple-${randomUUID()}`;
  const email = `account-delete-apple-${randomUUID()}@example.test`;
  const signed = await appleToken({ subject, email, nonce: 'normal-signin-nonce' });
  const response = await request(app).post('/api/v1/auth/apple')
    .send({ identityToken: signed, expectedNonce: 'normal-signin-nonce' });
  assert.equal(response.status, 200);
  users.add(response.body.data.user.id);
  return { ...response.body.data, subject, email };
}

function deletion(accessToken, deletionAuthorization) {
  return request(app).delete('/api/v1/auth/account')
    .set('Authorization', `Bearer ${accessToken}`).send({ deletionAuthorization });
}

async function grant(account, method = 'password') {
  const challenge = await request(app).post('/api/v1/auth/account/reauth/challenge')
    .set('Authorization', `Bearer ${account.accessToken}`).send({ method });
  assert.equal(challenge.status, 201);
  const body = method === 'password'
    ? { challengeId: challenge.body.data.challengeId, method, currentPassword: password }
    : {
        challengeId: challenge.body.data.challengeId,
        method,
        identityToken: await appleToken({
          subject: account.subject,
          email: account.email,
          nonce: createHash('sha256').update(challenge.body.data.nonce).digest('hex')
        })
      };
  const verified = await request(app).post('/api/v1/auth/account/reauth/verify')
    .set('Authorization', `Bearer ${account.accessToken}`).send(body);
  assert.equal(verified.status, 200);
  return verified.body.data.deletionAuthorization;
}

async function wallet(userId, walletAddress, enabledChains = [ethereum], primaryChain = enabledChains[0]) {
  return createWalletWithPreferences({
    userId, chainId: primaryChain, address: walletAddress,
    label: null, trackTypes: ['native_transfer'], enabledChains
  });
}

async function pairState(walletAddress) {
  const result = await query(`
    SELECT chain_id, generation FROM alchemy_address_reconciliation
    WHERE normalized_address = $1 ORDER BY chain_id
  `, [walletAddress]);
  return Object.fromEntries(result.rows.map((row) => [row.chain_id, Number(row.generation)]));
}

async function seedWalletData(userId) {
  const walletAddress = address();
  const tracked = await wallet(userId, walletAddress, [ethereum, base]);
  const token = (await query(`
    INSERT INTO device_tokens (user_id, fcm_token, platform)
    VALUES ($1, $2, 'ios') RETURNING id
  `, [userId, `deletion-device-${randomUUID()}`])).rows[0].id;
  const event = (await query(`
    INSERT INTO wallet_events
      (wallet_id, chain_id, transaction_hash, event_type, asset_type, occurred_at, explorer_url)
    VALUES ($1, $2, $3, 'native_transfer', 'coin', NOW(), 'https://example.test/tx')
    RETURNING id
  `, [tracked.id, ethereum, randomUUID()])).rows[0].id;
  const notification = (await query('INSERT INTO notifications (wallet_event_id) VALUES ($1) RETURNING id',
    [event])).rows[0].id;
  await query('INSERT INTO notification_outbox (wallet_event_id) VALUES ($1)', [event]);
  await query(`
    INSERT INTO notification_deliveries (notification_id, wallet_event_id, device_token_id)
    VALUES ($1, $2, $3)
  `, [notification, event, token]);
  await query('INSERT INTO wallet_alert_settings (wallet_id) VALUES ($1)', [tracked.id]);
  await query(`
    INSERT INTO wallet_portfolio_snapshots
      (wallet_id, chain_id, total_usd, holdings_usd, positions_usd, captured_at)
    VALUES ($1, $2, 0, 0, 0, NOW())
  `, [tracked.id, ethereum]);
  await query(`
    INSERT INTO wallet_chain_holdings_cache
      (wallet_id, wallet_address, chain_id, payload, captured_at)
    VALUES ($1, $2, $3, '{}'::jsonb, NOW())
  `, [tracked.id, walletAddress, ethereum]);
  await query(`
    INSERT INTO wallet_chain_positions_cache
      (wallet_id, wallet_address, chain_id, positions, captured_at)
    VALUES ($1, $2, $3, '[]'::jsonb, NOW())
  `, [tracked.id, walletAddress, ethereum]);
  return { tracked, walletAddress, event };
}

test('password deletion is permanent, cascades all user rows, and leaves only chain/address markers', async () => {
  const account = await register({ refresh: true });
  const otherSession = await request(app).post('/api/v1/auth/login')
    .send({ email: account.user.email, password });
  assert.equal(otherSession.status, 200);
  const { tracked, walletAddress, event } = await seedWalletData(account.user.id);
  await query(`
    INSERT INTO auth_challenges (id, user_id, purpose, code_digest, expires_at)
    VALUES ($1, $2, 'verify_email', $3, NOW() + INTERVAL '10 minutes')
  `, [randomUUID(), account.user.id, '0'.repeat(64)]);
  const authorization = await grant(account);
  const before = await pairState(walletAddress);

  const response = await deletion(account.accessToken, authorization);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { data: { deleted: true } });

  for (const table of [
    'auth_sessions', 'auth_identities', 'auth_challenges',
    'account_deletion_reauth_challenges', 'account_deletion_authorizations',
    'device_tokens', 'tracked_wallets'
  ]) {
    assert.equal((await query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [account.user.id])).rowCount,
      0, table);
  }
  assert.equal((await query('SELECT 1 FROM app_users WHERE id = $1', [account.user.id])).rowCount, 0);
  for (const table of [
    'wallet_track_preferences', 'wallet_chains', 'wallet_alert_settings',
    'wallet_events', 'wallet_portfolio_snapshots', 'wallet_chain_holdings_cache',
    'wallet_chain_positions_cache'
  ]) {
    assert.equal((await query(`SELECT 1 FROM ${table} WHERE wallet_id = $1`, [tracked.id])).rowCount,
      0, table);
  }
  for (const table of ['notifications', 'notification_outbox', 'notification_deliveries']) {
    assert.equal((await query(`SELECT 1 FROM ${table} WHERE wallet_event_id = $1`, [event])).rowCount,
      0, table);
  }
  const afterPairs = await pairState(walletAddress);
  assert.equal(afterPairs[ethereum], before[ethereum] + 1);
  assert.equal(afterPairs[base], before[base] + 1);
  assert.equal(await isAlchemyAddressDesired(ethereum, walletAddress), false);
  assert.equal((await deletion(account.accessToken, authorization)).status, 401);
  assert.equal((await request(app).get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${otherSession.body.data.accessToken}`)).status, 401);
  assert.equal((await request(app).post('/api/v1/auth/refresh')
    .send({ refreshToken: account.refreshToken })).status, 401);
  assert.equal((await request(app).post('/api/v1/auth/login')
    .send({ email: account.user.email, password })).status, 401);
});

test('Apple account deletion removes old identity; a later sign-in creates a different account', async () => {
  const account = await appleAccount();
  const authorization = await grant(account, 'apple');
  assert.deepEqual((await deletion(account.accessToken, authorization)).body, { data: { deleted: true } });
  assert.equal((await query('SELECT 1 FROM auth_identities WHERE user_id = $1', [account.user.id])).rowCount, 0);
  const signed = await appleToken({ subject: account.subject, email: account.email, nonce: 'new-signin-nonce' });
  const newSignIn = await request(app).post('/api/v1/auth/apple')
    .send({ identityToken: signed, expectedNonce: 'new-signin-nonce' });
  assert.equal(newSignIn.status, 200);
  assert.notEqual(newSignIn.body.data.user.id, account.user.id);
  users.add(newSignIn.body.data.user.id);
});

test('unverified account may delete, but sessionless and malformed requests cannot', async () => {
  const account = await register({ verified: false });
  const authorization = await grant(account);
  const legacy = await new SignJWT({ type: 'access', email: account.user.email })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(account.user.id)
    .setIssuedAt().setExpirationTime('5m')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  assert.equal((await deletion(legacy, authorization)).body.error.code, 'AUTH_INVALID_TOKEN');
  assert.equal((await request(app).delete('/api/v1/auth/account')
    .set('Authorization', `Bearer ${account.accessToken}`).send({})).body.error.code,
  'VALIDATION_ERROR');
  assert.equal((await deletion(account.accessToken, 'malformed')).body.error.code, 'AUTH_REAUTH_INVALID');
  assert.equal((await request(app).delete('/api/v1/auth/account')
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ deletionAuthorization: authorization, password })).body.error.code,
  'VALIDATION_ERROR');
  assert.deepEqual((await deletion(account.accessToken, authorization)).body, { data: { deleted: true } });
});

test('grant expiry, session binding, consumption, and revocation fail safely', async () => {
  const account = await register();
  const second = await request(app).post('/api/v1/auth/login')
    .send({ email: account.user.email, password });
  const authorization = await grant(account);
  assert.equal((await deletion(second.body.data.accessToken, authorization)).body.error.code,
    'AUTH_REAUTH_INVALID');
  await query(`
    UPDATE account_deletion_authorizations SET expires_at = clock_timestamp() - INTERVAL '1 second'
    WHERE authorization_digest = $1
  `, [createHash('sha256').update(authorization).digest()]);
  assert.equal((await deletion(account.accessToken, authorization)).body.error.code,
    'AUTH_REAUTH_EXPIRED');
  const fresh = await grant(account);
  await query('UPDATE account_deletion_authorizations SET consumed_at = NOW() WHERE authorization_digest = $1',
    [createHash('sha256').update(fresh).digest()]);
  assert.equal((await deletion(account.accessToken, fresh)).body.error.code, 'AUTH_REAUTH_INVALID');
  const revoked = await grant(account);
  await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal((await deletion(account.accessToken, revoked)).status, 401);
  assert.equal((await query('SELECT 1 FROM app_users WHERE id = $1', [account.user.id])).rowCount, 1);
});

test('a removed password method cannot authorize deletion from an old grant', async () => {
  const account = await register();
  const authorization = await grant(account);
  await query('UPDATE app_users SET password_hash = NULL WHERE id = $1', [account.user.id]);
  assert.equal((await deletion(account.accessToken, authorization)).body.error.code,
    'AUTH_REAUTH_METHOD_UNAVAILABLE');
  assert.equal((await query('SELECT 1 FROM app_users WHERE id = $1', [account.user.id])).rowCount, 1);
});

test('Google-only account has no deletion reauth bypass', async () => {
  const subject = `delete-google-${randomUUID()}`;
  const signedIn = await request(app).post('/api/v1/auth/google').send({ idToken: subject });
  assert.equal(signedIn.status, 200);
  const account = signedIn.body.data;
  users.add(account.user.id);
  for (const method of ['google', 'password', 'apple']) {
    const challenge = await request(app).post('/api/v1/auth/account/reauth/challenge')
      .set('Authorization', `Bearer ${account.accessToken}`).send({ method });
    assert.equal(challenge.body.error.code, 'AUTH_REAUTH_METHOD_UNAVAILABLE');
  }
  assert.equal((await deletion(account.accessToken, 'a'.repeat(43))).body.error.code,
    'AUTH_REAUTH_INVALID');
  assert.equal((await query('SELECT 1 FROM app_users WHERE id = $1', [account.user.id])).rowCount, 1);
});

test('pair markers deduplicate wallets and preserve another user’s desired watch', async () => {
  const owner = await register();
  const other = await register();
  const shared = address();
  const ownerWallet = await wallet(owner.user.id, shared, [ethereum, base], ethereum);
  await wallet(owner.user.id, shared, [base], base);
  await wallet(other.user.id, shared, [ethereum]);
  const pausedAddress = address();
  const paused = await wallet(owner.user.id, pausedAddress);
  await query("UPDATE tracked_wallets SET status = 'paused' WHERE id = $1", [paused.id]);
  const disabledAddress = address();
  const disabled = await wallet(owner.user.id, disabledAddress);
  await query('UPDATE wallet_chains SET enabled = FALSE WHERE wallet_id = $1', [disabled.id]);
  const before = await pairState(shared);
  const pausedBefore = await pairState(pausedAddress);
  const disabledBefore = await pairState(disabledAddress);
  const authorization = await grant(owner);
  assert.equal((await deletion(owner.accessToken, authorization)).status, 200);
  const afterPairs = await pairState(shared);
  assert.equal(afterPairs[ethereum], before[ethereum] + 1);
  assert.equal(afterPairs[base], before[base] + 1);
  assert.equal(await isAlchemyAddressDesired(ethereum, shared), true);
  assert.equal(await isAlchemyAddressDesired(base, shared), false);
  assert.deepEqual(await pairState(pausedAddress), pausedBefore);
  assert.deepEqual(await pairState(disabledAddress), disabledBefore);
  assert.equal((await query('SELECT 1 FROM tracked_wallets WHERE id = $1', [ownerWallet.id])).rowCount, 0);
});

test('marker failure rolls back user deletion and grant consumption', async () => {
  const account = await register();
  const walletAddress = address();
  await wallet(account.user.id, walletAddress, [base, ethereum]);
  const authorization = await grant(account);
  const before = await pairState(walletAddress);
  await query(`
    UPDATE alchemy_address_reconciliation SET generation = $3
    WHERE chain_id = $1 AND normalized_address = $2
  `, [ethereum, walletAddress, '9223372036854775807']);
  assert.equal((await deletion(account.accessToken, authorization)).status, 500);
  assert.equal((await query('SELECT 1 FROM app_users WHERE id = $1', [account.user.id])).rowCount, 1);
  assert.equal((await query('SELECT 1 FROM tracked_wallets WHERE user_id = $1', [account.user.id])).rowCount, 1);
  assert.equal((await query('SELECT consumed_at FROM account_deletion_authorizations WHERE authorization_digest = $1',
    [createHash('sha256').update(authorization).digest()])).rows[0].consumed_at, null);
  const rolledBack = await pairState(walletAddress);
  assert.equal(rolledBack[base], before[base]);
  assert.equal((await query(`
    SELECT generation FROM alchemy_address_reconciliation
    WHERE chain_id = $1 AND normalized_address = $2
  `, [ethereum, walletAddress])).rows[0].generation, '9223372036854775807');
  await query(`
    UPDATE alchemy_address_reconciliation SET generation = 1
    WHERE chain_id = $1 AND normalized_address = $2
  `, [ethereum, walletAddress]);
  assert.equal((await deletion(account.accessToken, authorization)).status, 200);
});

test('password reset revokes the session bound to an already-issued deletion grant', async () => {
  const account = await register();
  const authorization = await grant(account);
  const requested = await request(app).post('/api/v1/auth/forgot-password')
    .send({ email: account.user.email });
  assert.equal(requested.status, 202);
  const code = resetCodes.at(-1).code;
  const reset = await request(app).post('/api/v1/auth/reset-password')
    .send({ email: account.user.email, code, newPassword: 'account-deletion-new-password-123' });
  assert.equal(reset.status, 200);
  assert.equal((await deletion(account.accessToken, authorization)).status, 401);
  const sessionId = (await verifyAccessToken(account.accessToken)).sid;
  assert.ok((await query('SELECT revoked_at FROM auth_sessions WHERE id = $1',
    [sessionId])).rows[0].revoked_at);
  assert.equal((await query('SELECT 1 FROM app_users WHERE id = $1', [account.user.id])).rowCount, 1);
});

test('concurrent deletes have one winner and in-flight wallet/device writes leave no user data', async () => {
  const account = await register();
  const authorization = await grant(account);
  const walletAddress = address();
  const results = await Promise.allSettled([
    deletion(account.accessToken, authorization),
    deletion(account.accessToken, authorization),
    createWallet({
      userId: account.user.id, chainId: ethereum, address: walletAddress,
      enabledChains: [ethereum], trackTypes: ['native_transfer']
    }),
    registerDeviceToken({
      userId: account.user.id, fcmToken: `deletion-device-${randomUUID()}`, platform: 'ios'
    })
  ]);
  const statuses = results.slice(0, 2).map((entry) => entry.status === 'fulfilled' ? entry.value.status : 500);
  assert.deepEqual(statuses.sort(), [200, 401]);
  assert.equal((await query('SELECT 1 FROM app_users WHERE id = $1', [account.user.id])).rowCount, 0);
  assert.equal((await query('SELECT 1 FROM tracked_wallets WHERE user_id = $1', [account.user.id])).rowCount, 0);
  assert.equal((await query('SELECT 1 FROM device_tokens WHERE user_id = $1', [account.user.id])).rowCount, 0);
});

test('refresh and identity link racing with deletion cannot retain the old account', async () => {
  const account = await register({ refresh: true });
  const authorization = await grant(account);
  const subject = `apple-${randomUUID()}`;
  const token = await appleToken({ subject, email: account.user.email, nonce: 'link-nonce' });
  const [deleted, refreshed, linked] = await Promise.all([
    deletion(account.accessToken, authorization),
    request(app).post('/api/v1/auth/refresh').send({ refreshToken: account.refreshToken }),
    request(app).post('/api/v1/auth/identities/link')
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ provider: 'apple', identityToken: token,
        expectedNonce: 'link-nonce', currentPassword: password })
  ]);
  assert.equal(deleted.status, 200);
  assert.ok([200, 401].includes(refreshed.status));
  assert.ok([200, 401].includes(linked.status));
  assert.equal((await query('SELECT 1 FROM app_users WHERE id = $1', [account.user.id])).rowCount, 0);
  assert.equal((await query('SELECT 1 FROM auth_sessions WHERE user_id = $1', [account.user.id])).rowCount, 0);
  assert.equal((await query('SELECT 1 FROM auth_identities WHERE user_id = $1', [account.user.id])).rowCount, 0);
  if (refreshed.status === 200) {
    assert.equal((await request(app).get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)).status, 401);
  }
});

test('identity unlink racing with deletion cannot retain a linked identity', async () => {
  const account = await register();
  const subject = `apple-${randomUUID()}`;
  const token = await appleToken({ subject, email: account.user.email, nonce: 'link-nonce' });
  const linked = await request(app).post('/api/v1/auth/identities/link')
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ provider: 'apple', identityToken: token,
      expectedNonce: 'link-nonce', currentPassword: password });
  assert.equal(linked.status, 200);
  const authorization = await grant(account);
  const [deleted, unlinked] = await Promise.all([
    deletion(account.accessToken, authorization),
    request(app).delete('/api/v1/auth/identities/apple')
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ currentPassword: password })
  ]);
  assert.equal(deleted.status, 200);
  assert.ok([200, 401].includes(unlinked.status));
  assert.equal((await query('SELECT 1 FROM app_users WHERE id = $1', [account.user.id])).rowCount, 0);
  assert.equal((await query('SELECT 1 FROM auth_identities WHERE user_id = $1', [account.user.id])).rowCount, 0);
});

test('in-flight notification job cannot persist retry work after deletion', async () => {
  const account = await register();
  const { event } = await seedWalletData(account.user.id);
  const job = (await query('SELECT id, wallet_event_id FROM notification_outbox WHERE wallet_event_id = $1',
    [event])).rows[0];
  const authorization = await grant(account);
  assert.equal((await deletion(account.accessToken, authorization)).status, 200);
  const result = await processNotificationOutboxJob({ id: job.id, walletEventId: job.wallet_event_id });
  assert.equal(result.status, 'failed');
  assert.equal((await query('SELECT 1 FROM notification_outbox WHERE id = $1', [job.id])).rowCount, 0);
  assert.equal((await query('SELECT 1 FROM notifications WHERE wallet_event_id = $1', [event])).rowCount, 0);
});

test('deletion waits for the worker pair lock and then records the new generation', async () => {
  const account = await register();
  const walletAddress = address();
  await wallet(account.user.id, walletAddress);
  const authorization = await grant(account);
  const before = (await pairState(walletAddress))[ethereum];
  let releaseWorker;
  let workerEntered;
  const entered = new Promise((resolve) => { workerEntered = resolve; });
  const hold = new Promise((resolve) => { releaseWorker = resolve; });
  const worker = withAlchemyAddressPairLock({ chainId: ethereum, address: walletAddress }, async () => {
    workerEntered();
    await hold;
  });
  await entered;
  let completed = false;
  const pending = deletion(account.accessToken, authorization).then((response) => {
    completed = true;
    return response;
  });
  try {
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (Date.now() < deadline) {
      const locks = await query(`
        SELECT 1 FROM pg_stat_activity
        WHERE query LIKE 'SELECT pg_advisory_xact_lock(%'
          AND wait_event_type = 'Lock' LIMIT 1
      `);
      if (locks.rowCount) { waiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true);
    assert.equal(completed, false);
  } finally {
    releaseWorker();
  }
  await worker;
  assert.equal((await pending).status, 200);
  assert.equal((await pairState(walletAddress))[ethereum], before + 1);
});
