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
  removeAddressFromAlchemyWebhookSync,
  syncAlchemyWebhookAddressOnWalletCreate,
  syncAlchemyWebhookAddressOnWalletUpdate
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

async function cleanupUser(userId) {
  await query('DELETE FROM tracked_wallets WHERE user_id = $1', [userId]);
  await query('DELETE FROM app_users WHERE id = $1', [userId]);
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

test('wallet create keeps its API success shape when both chains sync', async () => {
  const calls = captureUpdates();
  const userId = randomUUID();
  const token = await createAccessToken({ id: userId });
  const address = randomAddress();

  try {
    await query('INSERT INTO app_users (id) VALUES ($1)', [userId]);
    const response = await request(app)
      .post(`/api/v1/users/${userId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ address, enabledChains: [ethereum, base], trackTypes: ['native_transfer'] });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.address, address);
    assert.deepEqual(response.body.data.enabledChains, [base, ethereum]);
    assert.deepEqual(calls.map((call) => call.webhook_id).sort(), [webhookIds[ethereum], webhookIds[base]].sort());
  } finally {
    await cleanupUser(userId);
  }
});

for (const failedChain of [ethereum, base]) {
  test(`${failedChain} sync failure returns an explicit error after wallet persistence`, async () => {
    const calls = captureUpdates({ failFor: webhookIds[failedChain] });
    const userId = randomUUID();
    const token = await createAccessToken({ id: userId });
    const address = randomAddress();

    try {
      await query('INSERT INTO app_users (id) VALUES ($1)', [userId]);
      const response = await request(app)
        .post(`/api/v1/users/${userId}/wallets`)
        .set('Authorization', `Bearer ${token}`)
        .send({ address, enabledChains: [ethereum, base], trackTypes: ['native_transfer'] });

      assert.equal(response.status, 503);
      assert.equal(response.body.error.code, 'ALCHEMY_WEBHOOK_SYNC_FAILED');
      assert.match(response.body.error.message, /saved/);
      const persisted = await query('SELECT id FROM tracked_wallets WHERE user_id = $1 AND address = $2', [userId, address]);
      assert.equal(persisted.rowCount, 1);
      assert.deepEqual(calls.map((call) => call.webhook_id).sort(), [webhookIds[ethereum], webhookIds[base]].sort());
    } finally {
      await cleanupUser(userId);
    }
  });
}

test('wallet update reports Base sync failure after persisting the chain change', async () => {
  captureUpdates();
  const userId = randomUUID();
  const token = await createAccessToken({ id: userId });
  const address = randomAddress();

  try {
    await query('INSERT INTO app_users (id) VALUES ($1)', [userId]);
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

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'ALCHEMY_WEBHOOK_SYNC_FAILED');
    const persisted = await query('SELECT chain_id FROM wallet_chains WHERE wallet_id = $1 AND enabled = TRUE', [created.body.data.id]);
    assert.deepEqual(persisted.rows.map((row) => row.chain_id).sort(), [ethereum, base].sort());
  } finally {
    await cleanupUser(userId);
  }
});

test('wallet delete reports sync failure after deleting the wallet', async () => {
  captureUpdates();
  const userId = randomUUID();
  const token = await createAccessToken({ id: userId });
  const address = randomAddress();

  try {
    await query('INSERT INTO app_users (id) VALUES ($1)', [userId]);
    const created = await request(app)
      .post(`/api/v1/users/${userId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ address, enabledChains: [ethereum], trackTypes: ['native_transfer'] });
    assert.equal(created.status, 201);

    captureUpdates({ failFor: webhookIds[ethereum] });
    const response = await request(app)
      .delete(`/api/v1/users/${userId}/wallets/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'ALCHEMY_WEBHOOK_SYNC_FAILED');
    const persisted = await query('SELECT id FROM tracked_wallets WHERE id = $1', [created.body.data.id]);
    assert.equal(persisted.rowCount, 0);
  } finally {
    await cleanupUser(userId);
  }
});

test('wallet update adds new subscriptions and removes old addresses per chain', async () => {
  const calls = captureUpdates();
  const previousAddress = randomAddress();
  const nextAddress = randomAddress();

  await syncAlchemyWebhookAddressOnWalletUpdate(
    { id: randomUUID(), address: previousAddress, enabledChains: [ethereum, base] },
    { id: randomUUID(), address: nextAddress, enabledChains: [base] }
  );

  assert.deepEqual(calls, [
    { webhook_id: webhookIds[base], addresses_to_add: [nextAddress], addresses_to_remove: [] },
    { webhook_id: webhookIds[ethereum], addresses_to_add: [], addresses_to_remove: [previousAddress] },
    { webhook_id: webhookIds[base], addresses_to_add: [], addresses_to_remove: [previousAddress] }
  ]);
});

test('removal rechecks the database and keeps addresses still used by a wallet', async () => {
  const calls = captureUpdates();
  const userId = randomUUID();
  const walletId = randomUUID();
  const address = randomAddress();

  await query('INSERT INTO app_users (id) VALUES ($1)', [userId]);
  await query(
    "INSERT INTO tracked_wallets (id, user_id, chain_id, address, status) VALUES ($1, $2, $3, $4, 'active')",
    [walletId, userId, ethereum, address]
  );
  await query('INSERT INTO wallet_chains (wallet_id, chain_id, enabled) VALUES ($1, $2, TRUE)', [walletId, ethereum]);

  try {
    assert.equal(await removeAddressFromAlchemyWebhookSync({ chainId: ethereum, address }), false);
    assert.deepEqual(calls, []);
  } finally {
    await cleanupUser(userId);
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

test('reconciliation adds missing addresses on each chain and is idempotent', async () => {
  const ethereumAddress = randomAddress();
  const baseAddress = randomAddress();
  const expected = { [ethereum]: [ethereumAddress], [base]: [baseAddress] };
  const watched = { [ethereum]: new Set(), [base]: new Set() };
  const calls = [];
  const options = {
    listDbAddresses: async (chainId) => expected[chainId],
    listWatchedAddresses: async (chainId) => [...watched[chainId]],
    addAddress: async ({ chainId, address }) => {
      calls.push({ chainId, address });
      watched[chainId].add(address);
      return true;
    },
    removeAddress: async () => { throw new Error('No removal expected'); }
  };

  const first = await reconcileAlchemyWebhookAddresses(options);
  assert.deepEqual(first.map((report) => report.addedCount), [1, 1]);
  assert.deepEqual(calls, [
    { chainId: ethereum, address: ethereumAddress },
    { chainId: base, address: baseAddress }
  ]);

  const second = await reconcileAlchemyWebhookAddresses(options);
  assert.deepEqual(second.map((report) => report.addedCount), [0, 0]);
  assert.equal(calls.length, 2);
});

test('reconciliation removes stale addresses only from their own chain', async () => {
  const ethereumAddress = randomAddress();
  const baseAddress = randomAddress();
  const staleEthereum = randomAddress();
  const staleBase = randomAddress();
  const watched = { [ethereum]: [ethereumAddress, staleEthereum], [base]: [baseAddress, staleBase] };
  const removed = [];

  const reports = await reconcileAlchemyWebhookAddresses({
    listDbAddresses: async (chainId) => chainId === ethereum ? [ethereumAddress] : [baseAddress],
    listWatchedAddresses: async (chainId) => watched[chainId],
    addAddress: async () => { throw new Error('No add expected'); },
    removeAddress: async ({ chainId, address }) => {
      removed.push({ chainId, address });
      return true;
    }
  });

  assert.deepEqual(removed, [
    { chainId: ethereum, address: staleEthereum },
    { chainId: base, address: staleBase }
  ]);
  assert.deepEqual(reports.map((report) => report.removedCount), [1, 1]);
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
