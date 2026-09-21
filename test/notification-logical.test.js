import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'dev_jwt_secret_that_is_long_enough_for_local_checks';
process.env.ENABLE_PUSH_NOTIFICATIONS = 'false';
process.env.ENABLE_ETHEREUM_TRACKER = 'false';
process.env.ENABLE_PORTFOLIO_SNAPSHOT_JOB = 'false';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const supertest = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { createAccessToken } = await import('../src/utils/jwt.js');
const {
  processNotificationOutboxBatch,
  processNotificationOutboxJob
} = await import('../src/modules/notifications/notifications.service.js');
const {
  ensureNotificationForWalletEvent,
  upsertNotificationDelivery
} = await import('../src/modules/notifications/notifications.repository.js');

const request = supertest(createApp());
const ownerId = randomUUID();
const otherId = randomUUID();
const walletId = randomUUID();
const ownerToken = await createAccessToken({ id: ownerId });
const otherToken = await createAccessToken({ id: otherId });

async function seedOutboxJob(deviceCount) {
  await query('DELETE FROM wallet_events WHERE wallet_id = $1', [walletId]);
  await query('UPDATE device_tokens SET is_active = FALSE WHERE user_id = $1', [ownerId]);

  for (let index = 0; index < deviceCount; index += 1) {
    await query(
      `INSERT INTO device_tokens (user_id, fcm_token, platform)
       VALUES ($1, $2, 'ios')`,
      [ownerId, `logical-alert-${randomUUID()}`]
    );
  }

  const walletEventId = randomUUID();
  const outboxId = randomUUID();
  const transactionHash = `0x${randomUUID().replaceAll('-', '').padEnd(64, '0')}`;

  await query(
    `INSERT INTO wallet_events (
      id, wallet_id, chain_id, transaction_hash, event_type, asset_type,
      asset_symbol, asset_name, amount, direction, from_address, to_address,
      usd_value, usd_value_status, occurred_at, explorer_url, raw_payload
    ) VALUES (
      $1, $2, 'ethereum-mainnet', $3, 'native_transfer', 'coin',
      'ETH', 'Ethereum', 1, 'incoming', $4, $5,
      250, 'priced_native_eth', NOW(), $6, '{}'::jsonb
    )`,
    [walletEventId, walletId, transactionHash,
      '0x2222222222222222222222222222222222222222',
      '0x1111111111111111111111111111111111111111',
      `https://etherscan.io/tx/${transactionHash}`]
  );
  await query(
    'INSERT INTO notification_outbox (id, wallet_event_id) VALUES ($1, $2)',
    [outboxId, walletEventId]
  );

  return { id: outboxId, walletEventId, attemptCount: 1 };
}

async function getAlertAndDeliveryCounts(walletEventId) {
  const result = await query(
    `SELECT
      (SELECT COUNT(*)::int FROM notifications WHERE wallet_event_id = $1) AS alerts,
      (SELECT COUNT(*)::int FROM notification_deliveries WHERE wallet_event_id = $1) AS deliveries`,
    [walletEventId]
  );
  return result.rows[0];
}

async function activeDeviceTokens() {
  const result = await query(
    'SELECT id, fcm_token FROM device_tokens WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at, id',
    [ownerId]
  );
  return result.rows;
}

async function deliveryRows(walletEventId) {
  const result = await query(
    'SELECT device_token_id, status, retryable FROM notification_deliveries WHERE wallet_event_id = $1 ORDER BY device_token_id',
    [walletEventId]
  );
  return result.rows;
}

async function outboxRow(outboxId) {
  const result = await query(
    'SELECT status, attempt_count, next_attempt_at FROM notification_outbox WHERE id = $1',
    [outboxId]
  );
  return result.rows[0];
}

async function makeRetryDue(outboxId) {
  await query('UPDATE notification_outbox SET next_attempt_at = NOW() WHERE id = $1', [outboxId]);
}

before(async () => {
  await query(
    `INSERT INTO app_users (id, email, name)
     VALUES ($1, $2, 'Owner'), ($3, $4, 'Other')`,
    [ownerId, `logical-owner-${ownerId}@example.com`, otherId, `logical-other-${otherId}@example.com`]
  );
  await query(
    `INSERT INTO tracked_wallets (id, user_id, chain_id, address, label)
     VALUES ($1, $2, 'ethereum-mainnet', $3, 'Logical alert test')`,
    [walletId, ownerId, '0x1111111111111111111111111111111111111111']
  );
});

after(async () => {
  await query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [[ownerId, otherId]]);
  await pool.end();
});

describe('logical alert history and delivery', () => {
  test('zero device tokens still create one unread history item', async () => {
    const job = await seedOutboxJob(0);
    await processNotificationOutboxJob(job);

    assert.deepEqual(await getAlertAndDeliveryCounts(job.walletEventId), { alerts: 1, deliveries: 0 });
    const history = await request.get('/api/v1/notifications').set('Authorization', `Bearer ${ownerToken}`);
    const count = await request.get('/api/v1/notifications/unread-count').set('Authorization', `Bearer ${ownerToken}`);

    assert.equal(history.status, 200);
    assert.equal(history.body.data.items.length, 1);
    assert.equal(history.body.data.items[0].relatedEventId, job.walletEventId);
    assert.equal(history.body.data.items[0].isRead, false);
    assert.equal(history.body.data.items[0].status, 'failed');
    assert.equal(history.body.data.items[0].providerMessageId, null);
    assert.equal(history.body.data.items[0].sentAt, null);
    assert.equal(count.body.data.unreadCount, 1);
  });

  test('one device creates one alert and one delivery; replay is idempotent', async () => {
    const job = await seedOutboxJob(1);
    await processNotificationOutboxJob(job);
    await processNotificationOutboxJob(job);

    assert.deepEqual(await getAlertAndDeliveryCounts(job.walletEventId), { alerts: 1, deliveries: 1 });
    const history = await request.get('/api/v1/notifications').set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(history.body.data.items.length, 1);
    assert.deepEqual(Object.keys(history.body.data.items[0]).sort(), [
      'body', 'category', 'chainId', 'createdAt', 'errorMessage', 'id', 'isRead',
      'providerMessageId', 'readAt', 'relatedEventId', 'sentAt', 'severity',
      'status', 'title', 'transactionHash', 'type', 'walletEvent', 'walletId'
    ].sort());
  });

  test('two devices yield one unread alert, one history row, and one read operation', async () => {
    const job = await seedOutboxJob(2);
    await processNotificationOutboxJob(job);

    assert.deepEqual(await getAlertAndDeliveryCounts(job.walletEventId), { alerts: 1, deliveries: 2 });
    const firstPage = await request.get('/api/v1/notifications?limit=1&offset=0')
      .set('Authorization', `Bearer ${ownerToken}`);
    const secondPage = await request.get('/api/v1/notifications?limit=1&offset=1')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(firstPage.body.data.items.length, 1);
    assert.equal(secondPage.body.data.items.length, 0);

    const alertId = firstPage.body.data.items[0].id;
    const countBefore = await request.get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(countBefore.body.data.unreadCount, 1);

    const denied = await request.patch(`/api/v1/notifications/${alertId}/read`)
      .set('Authorization', `Bearer ${otherToken}`);
    const otherHistory = await request.get('/api/v1/notifications')
      .set('Authorization', `Bearer ${otherToken}`);
    assert.equal(denied.status, 404);
    assert.deepEqual(otherHistory.body.data.items, []);

    const legacyDelivery = await query(
      'SELECT id FROM notification_deliveries WHERE wallet_event_id = $1 ORDER BY id DESC LIMIT 1',
      [job.walletEventId]
    );
    const read = await request.patch(`/api/v1/notifications/${legacyDelivery.rows[0].id}/read`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const repeated = await request.patch(`/api/v1/notifications/${alertId}/read`)
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, alertId);
    assert.equal(repeated.body.data.readAt, read.body.data.readAt);
    const countAfter = await request.get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(countAfter.body.data.unreadCount, 0);
  });

  test('mark-all updates logical alerts only for their owner', async () => {
    const first = await seedOutboxJob(0);
    await processNotificationOutboxJob(first);

    const denied = await request.patch('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${otherToken}`);
    assert.equal(denied.body.data.updatedCount, 0);
    const applied = await request.patch('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(applied.body.data.updatedCount, 1);
    const count = await request.get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(count.body.data.unreadCount, 0);
  });

  test('transient FCM failure is retried with backoff and then delivered', async () => {
    const job = await seedOutboxJob(1);
    const first = await processNotificationOutboxBatch({
      outboxId: job.id,
      sendPush: async () => { throw Object.assign(new Error('temporary outage'), { code: 'messaging/server-unavailable' }); }
    });

    assert.equal(first.retryScheduledCount, 1);
    assert.equal((await outboxRow(job.id)).status, 'pending');
    assert.equal((await outboxRow(job.id)).attempt_count, 1);
    assert.equal((await outboxRow(job.id)).next_attempt_at > new Date(), true);
    assert.deepEqual(await getAlertAndDeliveryCounts(job.walletEventId), { alerts: 1, deliveries: 1 });
    assert.equal((await deliveryRows(job.walletEventId))[0].retryable, true);

    await makeRetryDue(job.id);
    const second = await processNotificationOutboxBatch({
      outboxId: job.id,
      sendPush: async () => ({ delivered: true, providerMessageId: 'test-success' })
    });

    assert.equal(second.sentCount, 1);
    assert.equal((await outboxRow(job.id)).status, 'sent');
    assert.equal((await outboxRow(job.id)).attempt_count, 2);
    assert.equal((await deliveryRows(job.walletEventId))[0].status, 'delivered');
    assert.deepEqual(await getAlertAndDeliveryCounts(job.walletEventId), { alerts: 1, deliveries: 1 });
  });

  test('mixed success and transient failure retries only the failed device after restart', async () => {
    const job = await seedOutboxJob(2);
    const devices = await activeDeviceTokens();
    const firstCalls = [];
    const first = await processNotificationOutboxBatch({
      outboxId: job.id,
      sendPush: async (message) => {
        firstCalls.push(message.token);
        if (message.token === devices[1].fcm_token) {
          throw Object.assign(new Error('temporary outage'), { code: 'messaging/server-unavailable' });
        }
        return { delivered: true, providerMessageId: 'first-device-success' };
      }
    });

    assert.equal(first.retryScheduledCount, 1);
    assert.deepEqual(firstCalls, devices.map((device) => device.fcm_token));
    const firstRows = await deliveryRows(job.walletEventId);
    assert.equal(firstRows.filter((row) => row.status === 'delivered').length, 1);
    assert.equal(firstRows.filter((row) => row.status === 'failed' && row.retryable).length, 1);

    await makeRetryDue(job.id);
    const restartedWorkerCalls = [];
    const second = await processNotificationOutboxBatch({
      outboxId: job.id,
      sendPush: async (message) => {
        restartedWorkerCalls.push(message.token);
        return { delivered: true, providerMessageId: 'second-device-success' };
      }
    });

    assert.equal(second.sentCount, 1);
    assert.deepEqual(restartedWorkerCalls, [devices[1].fcm_token]);
    assert.equal((await deliveryRows(job.walletEventId)).filter((row) => row.status === 'delivered').length, 2);
    assert.deepEqual(await getAlertAndDeliveryCounts(job.walletEventId), { alerts: 1, deliveries: 2 });
    const history = await request.get('/api/v1/notifications').set('Authorization', `Bearer ${ownerToken}`);
    const unread = await request.get('/api/v1/notifications/unread-count').set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(history.body.data.items.length, 1);
    assert.equal(unread.body.data.unreadCount, 1);
  });

  test('mixed success and invalid token deactivates only the invalid device', async () => {
    const job = await seedOutboxJob(2);
    const devices = await activeDeviceTokens();
    const result = await processNotificationOutboxBatch({
      outboxId: job.id,
      sendPush: async (message) => {
        if (message.token === devices[1].fcm_token) {
          throw Object.assign(new Error('not registered'), { code: 'messaging/registration-token-not-registered' });
        }
        return { delivered: true, providerMessageId: 'valid-device-success' };
      }
    });

    assert.equal(result.sentCount, 1);
    assert.equal((await outboxRow(job.id)).status, 'sent');
    assert.deepEqual((await activeDeviceTokens()).map((device) => device.id), [devices[0].id]);
    const rows = await deliveryRows(job.walletEventId);
    assert.equal(rows.filter((row) => row.status === 'delivered').length, 1);
    assert.equal(rows.filter((row) => row.status === 'failed' && !row.retryable).length, 1);
    assert.deepEqual(await getAlertAndDeliveryCounts(job.walletEventId), { alerts: 1, deliveries: 2 });

    await processNotificationOutboxJob(job, {
      sendPush: async () => { throw new Error('already handled device was resent'); }
    });
    assert.equal((await deliveryRows(job.walletEventId)).filter((row) => row.status === 'delivered').length, 1);
  });

  test('generic invalid argument is terminal but does not deactivate the token', async () => {
    const job = await seedOutboxJob(1);
    const result = await processNotificationOutboxBatch({
      outboxId: job.id,
      sendPush: async () => { throw Object.assign(new Error('Invalid data payload'), { code: 'messaging/invalid-argument' }); }
    });

    assert.equal(result.sentCount, 1);
    assert.equal((await activeDeviceTokens()).length, 1);
    assert.equal((await deliveryRows(job.walletEventId))[0].retryable, false);
  });

  test('invalid-token cleanup does not deactivate a newer registration', async () => {
    const job = await seedOutboxJob(1);
    const [device] = await activeDeviceTokens();
    const result = await processNotificationOutboxBatch({
      outboxId: job.id,
      sendPush: async () => {
        await query(
          "UPDATE device_tokens SET updated_at = NOW() + INTERVAL '1 second' WHERE id = $1",
          [device.id]
        );
        throw Object.assign(new Error('no longer registered'), {
          code: 'messaging/registration-token-not-registered'
        });
      }
    });

    assert.equal(result.sentCount, 1);
    assert.equal((await activeDeviceTokens()).length, 1);
    assert.equal((await deliveryRows(job.walletEventId))[0].retryable, false);
  });

  test('stale processing after a crash preserves a successful device delivery', async () => {
    const job = await seedOutboxJob(2);
    const devices = await activeDeviceTokens();
    const notificationId = await ensureNotificationForWalletEvent(job.walletEventId);
    await upsertNotificationDelivery({
      notificationId, walletEventId: job.walletEventId, deviceTokenId: devices[0].id,
      status: 'delivered', providerMessageId: 'recorded-before-crash'
    });
    await upsertNotificationDelivery({
      notificationId, walletEventId: job.walletEventId, deviceTokenId: devices[1].id,
      status: 'pending', retryable: true
    });
    await query(
      `UPDATE notification_outbox
       SET status = 'processing', attempt_count = 1, locked_at = NOW() - INTERVAL '10 minutes'
       WHERE id = $1`,
      [job.id]
    );

    const calls = [];
    const result = await processNotificationOutboxBatch({
      outboxId: job.id,
      sendPush: async (message) => {
        calls.push(message.token);
        return { delivered: true, providerMessageId: 'after-restart' };
      }
    });

    assert.equal(result.sentCount, 1);
    assert.deepEqual(calls, [devices[1].fcm_token]);
    assert.equal((await outboxRow(job.id)).attempt_count, 2);
    assert.deepEqual(await getAlertAndDeliveryCounts(job.walletEventId), { alerts: 1, deliveries: 2 });
  });

  test('transient failures stop after the configured attempt limit while history remains', async () => {
    const job = await seedOutboxJob(1);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await makeRetryDue(job.id);
      const result = await processNotificationOutboxBatch({
        outboxId: job.id,
        sendPush: async () => { throw Object.assign(new Error('temporary outage'), { code: 'messaging/server-unavailable' }); }
      });
      assert.equal(result.retryScheduledCount, attempt < 3 ? 1 : 0);
      assert.equal(result.failedCount, attempt === 3 ? 1 : 0);
    }
    assert.equal((await outboxRow(job.id)).status, 'failed');
    assert.equal((await outboxRow(job.id)).attempt_count, 3);
    assert.deepEqual(await getAlertAndDeliveryCounts(job.walletEventId), { alerts: 1, deliveries: 1 });
  });

  test('migration combines legacy deliveries and restores no-device outbox history', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TEMP TABLE wallet_events (id UUID PRIMARY KEY) ON COMMIT DROP');
      await client.query('CREATE TEMP TABLE notification_outbox (id UUID PRIMARY KEY, wallet_event_id UUID, created_at TIMESTAMPTZ) ON COMMIT DROP');
      await client.query('CREATE TEMP TABLE notification_deliveries (id UUID PRIMARY KEY, wallet_event_id UUID, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ) ON COMMIT DROP');
      const twoDeviceEventId = randomUUID();
      const noDeviceEventId = randomUUID();
      const firstDeliveryId = randomUUID();
      const secondDeliveryId = randomUUID();
      const noDeviceOutboxId = randomUUID();
      await client.query('INSERT INTO wallet_events (id) VALUES ($1), ($2)', [twoDeviceEventId, noDeviceEventId]);
      await client.query(
        `INSERT INTO notification_outbox (id, wallet_event_id, created_at)
         VALUES ($1, $2, NOW()), ($3, $4, NOW())`,
        [randomUUID(), twoDeviceEventId, noDeviceOutboxId, noDeviceEventId]
      );
      await client.query(
        `INSERT INTO notification_deliveries (id, wallet_event_id, read_at, created_at)
         VALUES ($1, $3, NOW(), NOW() - INTERVAL '2 minutes'),
                ($2, $3, NULL, NOW() - INTERVAL '1 minute')`,
        [firstDeliveryId, secondDeliveryId, twoDeviceEventId]
      );
      await client.query('SET LOCAL search_path TO pg_temp, public');
      const migration = await fs.readFile(new URL('../src/db/migrations/015_logical_notifications.sql', import.meta.url), 'utf8');
      await client.query(migration);
      const result = await client.query(
        'SELECT id, wallet_event_id, read_at FROM notifications ORDER BY wallet_event_id'
      );
      assert.equal(result.rowCount, 2);
      assert.equal(result.rows.find((row) => row.wallet_event_id === twoDeviceEventId).id, firstDeliveryId);
      assert.equal(result.rows.find((row) => row.wallet_event_id === twoDeviceEventId).read_at, null);
      assert.equal(result.rows.find((row) => row.wallet_event_id === noDeviceEventId).id, noDeviceOutboxId);
      const links = await client.query('SELECT DISTINCT notification_id FROM notification_deliveries');
      assert.deepEqual(links.rows.map((row) => row.notification_id), [firstDeliveryId]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('retryability migration protects existing successful deliveries', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TEMP TABLE notification_deliveries (status TEXT) ON COMMIT DROP');
      await client.query(
        "INSERT INTO notification_deliveries (status) VALUES ('delivered'), ('failed'), ('pending')"
      );
      await client.query('SET LOCAL search_path TO pg_temp, public');
      const migration = await fs.readFile(
        new URL('../src/db/migrations/016_notification_delivery_retryability.sql', import.meta.url),
        'utf8'
      );
      await client.query(migration);
      const result = await client.query(
        'SELECT status, retryable FROM notification_deliveries ORDER BY status'
      );
      assert.deepEqual(result.rows, [
        { status: 'delivered', retryable: false },
        { status: 'failed', retryable: true },
        { status: 'pending', retryable: true }
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
