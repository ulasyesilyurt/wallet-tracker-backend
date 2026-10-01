import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_sync_checks';
process.env.ALCHEMY_NOTIFY_API_KEY = 'test-notify-key';
process.env.ALCHEMY_NOTIFY_REQUEST_TIMEOUT_MS = '30';
process.env.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET = 'wh_sync_ethereum';
process.env.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET = 'wh_sync_base';
process.env.LOG_LEVEL = 'silent';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { createAccessToken } = await import('../src/utils/jwt.js');
const {
  addAddressToAlchemyWebhookSync,
  listAlchemyWebhookWatchedAddresses,
  removeAddressFromAlchemyWebhookSync
} = await import('../src/modules/webhooks/alchemyAddressSync.service.js');
const { reconcileAlchemyWebhookAddresses } = await import('../src/modules/webhooks/alchemyReconciliation.service.js');

const ethereum = 'ethereum-mainnet';
const base = 'base-mainnet';
const webhookIds = { [ethereum]: 'wh_sync_ethereum', [base]: 'wh_sync_base' };
const originalFetch = global.fetch;
const app = createApp();

after(async () => {
  global.fetch = originalFetch;
  await pool.end();
});

function randomAddress() {
  return `0x${randomBytes(20).toString('hex')}`;
}

function okResponse() {
  return { ok: true, status: 200, text: async () => '{}' };
}

function captureUpdates({ failFor = null, status = 503 } = {}) {
  const calls = [];
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://dashboard.alchemy.com/api/update-webhook-addresses');
    assert.equal(options.method, 'PATCH');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    calls.push(body);

    if (body.webhook_id === failFor) {
      return { ok: false, status, text: async () => 'not found' };
    }

    return okResponse();
  };
  return calls;
}

async function cleanupUser(userId, address) {
  await query('DELETE FROM tracked_wallets WHERE user_id = $1', [userId]);
  await query('DELETE FROM app_users WHERE id = $1', [userId]);
  await query('DELETE FROM alchemy_address_reconciliation WHERE normalized_address = $1', [address]);
}

for (const chainId of [ethereum, base]) {
  test(`${chainId} add targets its own Alchemy webhook`, async () => {
    const calls = captureUpdates();
    const address = randomAddress();

    assert.equal(await addAddressToAlchemyWebhookSync({ chainId, address }), true);
    assert.deepEqual(calls, [{
      webhook_id: webhookIds[chainId],
      addresses_to_add: [address],
      addresses_to_remove: []
    }]);
  });

  test(`${chainId} management failure is propagated`, async () => {
    captureUpdates({ failFor: webhookIds[chainId], status: 404 });
    await assert.rejects(
      addAddressToAlchemyWebhookSync({ chainId, address: randomAddress() }),
      (error) => error.status === 404
    );
  });
}

test('wallet create keeps its API success shape and queues both chains', async () => {
  const calls = captureUpdates();
  const userId = randomUUID();
  const token = await createAccessToken({ id: userId });
  const address = randomAddress();

  try {
    await query('INSERT INTO app_users (id, email_verified_at) VALUES ($1, NOW())', [userId]);
    const response = await request(app)
      .post(`/api/v1/users/${userId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ address, enabledChains: [ethereum, base], trackTypes: ['native_transfer'] });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.address, address);
    assert.deepEqual(response.body.data.enabledChains, [base, ethereum]);
    assert.deepEqual(calls, []);
    const pending = await query('SELECT chain_id FROM alchemy_address_reconciliation WHERE normalized_address = $1', [address]);
    assert.deepEqual(pending.rows.map((row) => row.chain_id).sort(), [ethereum, base].sort());
  } finally {
    await cleanupUser(userId, address);
  }
});

for (const failedChain of [ethereum, base]) {
  test(`${failedChain} provider unavailability does not change wallet create response`, async () => {
    const calls = captureUpdates({ failFor: webhookIds[failedChain] });
    const userId = randomUUID();
    const token = await createAccessToken({ id: userId });
    const address = randomAddress();

    try {
      await query('INSERT INTO app_users (id, email_verified_at) VALUES ($1, NOW())', [userId]);
      const response = await request(app)
        .post(`/api/v1/users/${userId}/wallets`)
        .set('Authorization', `Bearer ${token}`)
        .send({ address, enabledChains: [ethereum, base], trackTypes: ['native_transfer'] });

      assert.equal(response.status, 201);
      const persisted = await query('SELECT id FROM tracked_wallets WHERE user_id = $1 AND address = $2', [userId, address]);
      assert.equal(persisted.rowCount, 1);
      assert.deepEqual(calls, []);
    } finally {
      await cleanupUser(userId, address);
    }
  });
}

test('wallet update queues Base without calling its unavailable provider', async () => {
  captureUpdates();
  const userId = randomUUID();
  const token = await createAccessToken({ id: userId });
  const address = randomAddress();

  try {
    await query('INSERT INTO app_users (id, email_verified_at) VALUES ($1, NOW())', [userId]);
    const created = await request(app)
      .post(`/api/v1/users/${userId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ address, enabledChains: [ethereum], trackTypes: ['native_transfer'] });
    assert.equal(created.status, 201);

    captureUpdates({ failFor: webhookIds[base] });
    const response = await request(app)
      .patch(`/api/v1/users/${userId}/wallets/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enabledChains: [ethereum, base] });

    assert.equal(response.status, 200);
    const persisted = await query('SELECT chain_id FROM wallet_chains WHERE wallet_id = $1 AND enabled = TRUE', [created.body.data.id]);
    assert.deepEqual(persisted.rows.map((row) => row.chain_id).sort(), [ethereum, base].sort());
  } finally {
    await cleanupUser(userId, address);
  }
});

test('wallet delete queues cleanup without calling its unavailable provider', async () => {
  captureUpdates();
  const userId = randomUUID();
  const token = await createAccessToken({ id: userId });
  const address = randomAddress();

  try {
    await query('INSERT INTO app_users (id, email_verified_at) VALUES ($1, NOW())', [userId]);
    const created = await request(app)
      .post(`/api/v1/users/${userId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ address, enabledChains: [ethereum], trackTypes: ['native_transfer'] });
    assert.equal(created.status, 201);

    captureUpdates({ failFor: webhookIds[ethereum] });
    const response = await request(app)
      .delete(`/api/v1/users/${userId}/wallets/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    const persisted = await query('SELECT id FROM tracked_wallets WHERE id = $1', [created.body.data.id]);
    assert.equal(persisted.rowCount, 0);
  } finally {
    await cleanupUser(userId, address);
  }
});

test('removal rechecks the database and keeps addresses still used by a wallet', async () => {
  const calls = captureUpdates();
  const userId = randomUUID();
  const walletId = randomUUID();
  const address = randomAddress();

  await query('INSERT INTO app_users (id, email_verified_at) VALUES ($1, NOW())', [userId]);
  await query(
    "INSERT INTO tracked_wallets (id, user_id, chain_id, address, status) VALUES ($1, $2, $3, $4, 'active')",
    [walletId, userId, ethereum, address]
  );
  await query('INSERT INTO wallet_chains (wallet_id, chain_id, enabled) VALUES ($1, $2, TRUE)', [walletId, ethereum]);

  try {
    assert.equal(await removeAddressFromAlchemyWebhookSync({ chainId: ethereum, address }), false);
    assert.deepEqual(calls, []);
  } finally {
    await cleanupUser(userId, address);
  }

  assert.equal(await removeAddressFromAlchemyWebhookSync({ chainId: ethereum, address }), true);
  assert.deepEqual(calls[0].addresses_to_remove, [address]);
});

test('watched-address listing follows pagination and uses the selected webhook ID', async () => {
  const addressA = randomAddress();
  const addressB = randomAddress();
  const requested = [];
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    requested.push(parsed);
    assert.ok(options.signal instanceof AbortSignal);
    return {
      ok: true,
      status: 200,
      json: async () => parsed.searchParams.has('after')
        ? { data: [addressB], pagination: { cursors: {}, total_count: 2 } }
        : { data: [addressA], pagination: { cursors: { after: 'page-2' }, total_count: 2 } }
    };
  };

  assert.deepEqual(await listAlchemyWebhookWatchedAddresses(base), [addressA, addressB].sort());
  assert.equal(requested.length, 2);
  assert.ok(requested.every((url) => url.searchParams.get('webhook_id') === webhookIds[base]));
  assert.equal(requested[1].searchParams.get('after'), 'page-2');
});

test('incomplete watched-address listing fails before stale removal can be planned', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [], pagination: { cursors: {}, total_count: 1 } })
  });
  await assert.rejects(listAlchemyWebhookWatchedAddresses(ethereum), /incomplete/);
});

test('watched-address listing stops at its finite page and item limits', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [`0x${calls.toString(16).padStart(40, '0')}`],
        pagination: { cursors: { after: `page-${calls}` }, total_count: 100 }
      })
    };
  };
  await assert.rejects(
    listAlchemyWebhookWatchedAddresses(ethereum),
    (error) => error.code === 'PROVIDER_PAGE_LIMIT'
  );
  assert.equal(calls, 100);

  calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [], pagination: { cursors: {}, total_count: 10_001 } })
    };
  };
  await assert.rejects(
    listAlchemyWebhookWatchedAddresses(ethereum),
    (error) => error.code === 'PROVIDER_PAGE_LIMIT'
  );
  assert.equal(calls, 1);
});

test('full reconciliation queues missing addresses on each chain', async () => {
  const ethereumAddress = randomAddress();
  const baseAddress = randomAddress();
  const expected = { [ethereum]: [ethereumAddress], [base]: [baseAddress] };
  const calls = [];
  const options = {
    listDbAddresses: async (chainId) => expected[chainId],
    listWatchedAddresses: async () => [],
    enqueuePairs: async (pairs) => { calls.push(pairs); }
  };

  const first = await reconcileAlchemyWebhookAddresses(options);
  assert.deepEqual(first.map((report) => report.queuedCount), [1, 1]);
  assert.deepEqual(calls, [
    [{ chainId: ethereum, address: ethereumAddress }],
    [{ chainId: base, address: baseAddress }]
  ]);

  const dryRun = await reconcileAlchemyWebhookAddresses({ ...options, dryRun: true });
  assert.deepEqual(dryRun.map((report) => report.queuedCount), [0, 0]);
  assert.equal(calls.length, 2);
});

test('full reconciliation queues stale addresses only on their own chain', async () => {
  const ethereumAddress = randomAddress();
  const baseAddress = randomAddress();
  const staleEthereum = randomAddress();
  const staleBase = randomAddress();
  const watched = { [ethereum]: [ethereumAddress, staleEthereum], [base]: [baseAddress, staleBase] };
  const queued = [];

  const reports = await reconcileAlchemyWebhookAddresses({
    listDbAddresses: async (chainId) => chainId === ethereum ? [ethereumAddress] : [baseAddress],
    listWatchedAddresses: async (chainId) => watched[chainId],
    enqueuePairs: async (pairs) => { queued.push(pairs); }
  });

  assert.deepEqual(queued, [
    [{ chainId: ethereum, address: staleEthereum }],
    [{ chainId: base, address: staleBase }]
  ]);
  assert.deepEqual(reports.map((report) => report.queuedCount), [1, 1]);
});

test('management request times out and propagates failure', async () => {
  global.fetch = (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });

  await assert.rejects(
    addAddressToAlchemyWebhookSync({ chainId: ethereum, address: randomAddress() }),
    (error) => error.name === 'TimeoutError'
  );
});
