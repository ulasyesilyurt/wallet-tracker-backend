import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_operations';
process.env.LOG_LEVEL = 'silent';
process.env.ENABLE_PUSH_NOTIFICATIONS = 'false';
process.env.ENABLE_PORTFOLIO_SNAPSHOT_JOB = 'false';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { parseEnvironment } = await import('../src/config/env.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { NotificationOutboxWorker } = await import('../src/modules/notifications/notificationOutbox.worker.js');
const { PortfolioSnapshotJob } = await import('../src/modules/performance/performance.job.js');
const { getNotificationOutboxOperationalSummary } = await import('../src/modules/operations/operations.repository.js');
const { buildOperationalStatus } = await import('../src/modules/operations/operations.service.js');
const {
  getOperationalSignalState,
  recordAlchemySyncFailure,
  recordWebhookFailure,
  resetOperationalSignalStateForTests
} = await import('../src/modules/operations/operationalState.js');

const userId = randomUUID();
const walletId = randomUUID();
const operationsToken = 'test_operations_token_that_is_at_least_32_chars';

before(async () => {
  await query('INSERT INTO app_users (id, email) VALUES ($1, $2)', [userId, `ops-${userId}@example.test`]);
  await query(
    `INSERT INTO tracked_wallets (id, user_id, chain_id, address, status)
     VALUES ($1, $2, 'ethereum-mainnet', $3, 'active')`,
    [walletId, userId, `0x${randomUUID().replaceAll('-', '').slice(0, 40)}`]
  );

  for (let index = 0; index < 5; index += 1) {
    const eventId = randomUUID();
    await query(
      `INSERT INTO wallet_events (
         id, wallet_id, chain_id, transaction_hash, event_type, asset_type,
         occurred_at, explorer_url, raw_payload
       ) VALUES ($1, $2, 'ethereum-mainnet', $3, 'native_transfer', 'coin', NOW(), $4, '{}'::jsonb)`,
      [eventId, walletId, `0x${String(index + 1).padStart(64, '0')}`, `https://example.test/${index}`]
    );
    const status = ['pending', 'pending', 'processing', 'failed', 'sent'][index];
    await query(
      `INSERT INTO notification_outbox (
         wallet_event_id, status, attempt_count, next_attempt_at, locked_at, created_at
       ) VALUES (
         $1, $2, $3, NOW(),
         CASE WHEN $2 = 'processing' THEN NOW() - INTERVAL '10 minutes' ELSE NULL END,
         NOW() - ($4::int * INTERVAL '1 minute')
       )`,
      [eventId, status, index === 1 ? 2 : 0, index === 0 ? 12 : 5]
    );
  }
});

after(async () => {
  await query('DELETE FROM app_users WHERE id = $1', [userId]);
  await pool.end();
});

describe('operations diagnostics', () => {
  test('operations token configuration rejects short secrets', () => {
    assert.throws(() => parseEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/test',
      JWT_SECRET: 'test_jwt_secret_that_is_long_enough_for_operations',
      OPERATIONS_DIAGNOSTICS_TOKEN: 'too-short'
    }), /OPERATIONS_DIAGNOSTICS_TOKEN/);
  });

  test('outbox monitoring uses aggregate SQL and reports queue age and stale processing', async () => {
    const summary = await getNotificationOutboxOperationalSummary();

    assert.deepEqual(
      {
        pendingCount: summary.pendingCount,
        retryingCount: summary.retryingCount,
        processingCount: summary.processingCount,
        staleProcessingCount: summary.staleProcessingCount,
        failedCount: summary.failedCount
      },
      { pendingCount: 2, retryingCount: 1, processingCount: 1, staleProcessingCount: 1, failedCount: 1 }
    );
    assert.ok(summary.oldestPendingAt);
    assert.ok(summary.oldestPendingAgeSeconds >= 11 * 60);

    let capturedSql = '';
    await getNotificationOutboxOperationalSummary({
      dbQuery: async (sql) => {
        capturedSql = sql;
        return { rows: [{}] };
      }
    });
    assert.match(capturedSql, /COUNT\(\*\) FILTER/);
    assert.match(capturedSql, /MIN\(created_at\) FILTER/);
    assert.doesNotMatch(capturedSql, /SELECT\s+\*/i);
  });

  test('operations endpoint is disabled without a token and rejects missing or invalid tokens', async () => {
    const status = async () => ({ status: 'ok' });
    const disabled = request(createApp({ getOperationalStatus: status }));
    const enabled = request(createApp({ operationsToken, getOperationalStatus: status }));

    assert.equal((await disabled.get('/api/v1/operations/status')).status, 404);
    assert.equal((await disabled.get('/api/v1/operations/status').set('Authorization', 'Bearer ordinary-user-token')).status, 404);
    assert.equal((await enabled.get('/api/v1/operations/status')).status, 401);
    assert.equal((await enabled.get('/api/v1/operations/status').set('X-Operations-Token', 'wrong-token')).status, 401);
  });

  test('authorized diagnostics are aggregate-only and omit tokens and raw errors', async () => {
    const rawSecret = 'postgresql://user:password@example.test/private';
    resetOperationalSignalStateForTests();
    const failure = new Error(rawSecret);
    failure.code = rawSecret;
    recordWebhookFailure(failure);
    recordAlchemySyncFailure(failure);

    const getOperationalStatus = () => buildOperationalStatus({
      checkDatabase: async () => true,
      getOutboxSummary: async () => ({ pendingCount: 3, retryingCount: 1, processingCount: 0, staleProcessingCount: 0, failedCount: 0, oldestPendingAt: null, oldestPendingAgeSeconds: null }),
      getWorkerStatus: () => ({ started: true, running: false }),
      getSnapshotStatus: () => ({ enabled: false }),
      getProcessInfo: () => ({ appVersion: '1.0.0', nodeEnv: 'test', startedAt: '2026-09-22T00:00:00.000Z', uptimeSeconds: 10, shuttingDown: false })
    });
    const response = await request(createApp({ operationsToken, getOperationalStatus }))
      .get('/api/v1/operations/status')
      .set('X-Operations-Token', operationsToken);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'ok');
    assert.equal(response.body.data.notificationOutbox.pendingCount, 3);
    assert.equal(response.body.data.webhook.failureCount, 1);
    assert.equal(response.body.data.alchemySync.failureCount, 1);
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes(operationsToken), false);
    assert.equal(serialized.includes(rawSecret), false);
    assert.equal(serialized.includes('stack'), false);
    assert.equal(serialized.includes('address'), false);
  });

  test('database or outbox failure degrades diagnostics without exposing the error', async () => {
    const status = await buildOperationalStatus({
      checkDatabase: async () => true,
      getOutboxSummary: async () => { throw new Error('database password leaked'); },
      getWorkerStatus: () => ({ started: true }),
      getSnapshotStatus: () => ({ enabled: false })
    });
    assert.equal(status.status, 'degraded');
    assert.deepEqual(status.database, { available: true });
    assert.deepEqual(status.notificationOutbox, { available: false });
    assert.equal(JSON.stringify(status).includes('database password'), false);
  });
});

describe('background job heartbeats', () => {
  test('notification worker tracks successful cycles and safe errors', async () => {
    let shouldFail = false;
    const worker = new NotificationOutboxWorker({
      intervalMs: 60_000,
      processBatch: async () => {
        if (shouldFail) {
          const error = new Error('token=secret-device-token');
          error.code = 'secret-device-token';
          throw error;
        }
        return { claimedCount: 2, sentCount: 1, retryScheduledCount: 1, failedCount: 0 };
      }
    });

    await worker.start();
    assert.equal(worker.getStatus().started, true);
    assert.equal(worker.getStatus().lastResult.claimedCount, 2);
    assert.ok(worker.getStatus().lastCycleCompletedAt);
    shouldFail = true;
    await worker.runCycle();
    const failed = worker.getStatus();
    assert.ok(failed.lastErrorAt);
    assert.equal(failed.lastError.errorCode, null);
    assert.equal(JSON.stringify(failed).includes('secret-device-token'), false);
    await worker.stop();
    assert.equal(worker.getStatus().started, false);
  });

  test('snapshot job records partial failure, success, and thrown failure timestamps', async () => {
    let mode = 'partial';
    const job = new PortfolioSnapshotJob({
      intervalMs: 60_000,
      captureSnapshots: async () => {
        if (mode === 'throw') {
          throw new Error('provider-key-in-message');
        }
        return { totalWallets: 2, insertedCount: mode === 'success' ? 2 : 1, skippedCount: 0, failedCount: mode === 'partial' ? 1 : 0 };
      }
    });

    await job.runCycle();
    assert.ok(job.getStatus().lastRunFailedAt);
    assert.equal(job.getStatus().lastError.errorCode, 'SNAPSHOT_ITEMS_FAILED');
    mode = 'success';
    await job.runCycle();
    assert.ok(job.getStatus().lastRunSucceededAt);
    mode = 'throw';
    await job.runCycle();
    const status = job.getStatus();
    assert.ok(status.lastRunStartedAt);
    assert.ok(status.lastRunCompletedAt);
    assert.equal(JSON.stringify(status).includes('provider-key-in-message'), false);
  });
});
