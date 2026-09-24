import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_positions_checks';
process.env.LOG_LEVEL = 'silent';
process.env.ZERION_API_KEY = 'test-zerion-key';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { createAccessToken } = await import('../src/utils/jwt.js');
const { getWalletPositions, getCachedWalletPositions } = await import('../src/modules/positions/positions.service.js');

const app = createApp();
const originalFetch = global.fetch;
const ownerId = randomUUID();
const otherUserId = randomUUID();
const walletId = randomUUID();
const emptyWalletId = randomUUID();
const staleWalletId = randomUUID();
const chainId = 'ethereum-mainnet';
const walletAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const emptyWalletAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const staleWalletAddress = '0xcccccccccccccccccccccccccccccccccccccccc';
let ownerToken;
let otherToken;

function zerionPositions(valueUsd) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ id: 'position-1', attributes: { name: 'Staked ETH', value: valueUsd } }],
      included: [],
      links: {}
    })
  };
}

async function seedHoldingsCache(id, address) {
  const payload = {
    walletId: id,
    chainId,
    enabledChains: [chainId],
    totalBalanceUsd: 100,
    holdings: [{ chainId, symbol: 'ETH', balance: '1', balanceUsd: 100 }],
    tokenBalancesAvailable: true,
    tokenBalancesReason: null,
    isPartial: false,
    partialReasons: []
  };
  await query(
    `
      INSERT INTO wallet_chain_holdings_cache (
        wallet_id, wallet_address, chain_id, payload, holdings_count,
        total_balance_usd, token_balances_available, is_partial, captured_at
      ) VALUES ($1, LOWER($2), $3, $4::jsonb, 1, 100, TRUE, FALSE, NOW())
    `,
    [id, address, chainId, JSON.stringify(payload)]
  );
}

before(async () => {
  await query('INSERT INTO app_users (id, email) VALUES ($1, $2), ($3, $4)', [
    ownerId, `positions-owner-${ownerId}@example.test`,
    otherUserId, `positions-other-${otherUserId}@example.test`
  ]);
  await query(
    `INSERT INTO tracked_wallets (id, user_id, chain_id, address, status)
     VALUES ($1, $2, $3, $4, 'active'), ($5, $2, $3, $6, 'active'),
       ($7, $2, $3, $8, 'active')`,
    [walletId, ownerId, chainId, walletAddress, emptyWalletId, emptyWalletAddress,
      staleWalletId, staleWalletAddress]
  );
  await seedHoldingsCache(walletId, walletAddress);
  await seedHoldingsCache(emptyWalletId, emptyWalletAddress);
  await seedHoldingsCache(staleWalletId, staleWalletAddress);
  await query(
    `INSERT INTO wallet_chain_positions_cache (
       wallet_id, wallet_address, chain_id, positions, captured_at, updated_at
     ) VALUES ($1, LOWER($2), $3, $4::jsonb, NOW() - INTERVAL '25 hours', NOW())`,
    [staleWalletId, staleWalletAddress, chainId, JSON.stringify([{ valueUsd: 900, assetName: 'Old asset' }])]
  );
  ownerToken = await createAccessToken({ id: ownerId });
  otherToken = await createAccessToken({ id: otherUserId });
});

after(async () => {
  global.fetch = originalFetch;
  await query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [[ownerId, otherUserId]]);
  await pool.end();
});

test('positions captured within 24 hours survive a cold cache without a list-mode provider call', async () => {
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    return zerionPositions(50);
  };
  const fresh = await getWalletPositions(walletId, { userId: ownerId });
  assert.equal(fresh.isPartial, false);
  assert.equal(fresh.positions[0].valueUsd, 50);
  assert.equal(providerCalls, 1);

  const stored = await query(
    'SELECT positions, captured_at FROM wallet_chain_positions_cache WHERE wallet_id = $1 AND chain_id = $2',
    [walletId, chainId]
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].positions[0].valueUsd, 50);
  assert.ok(stored.rows[0].captured_at);

  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    global.fetch = () => {
      providerCalls += 1;
      throw new Error('List mode must not fetch Zerion');
    };
    const list = await request(app)
      .get(`/api/v1/wallets/${walletId}/portfolio-summary?includePositions=false`)
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.positionsTotalUsd, 50);
    assert.equal(list.body.data.totalPortfolioUsd, 150);
    assert.equal(list.body.data.reason, `PERSISTED_POSITIONS_CACHE:${chainId}`);
    assert.equal(list.body.data.isPartial, true);
    assert.equal(providerCalls, 1);

    global.fetch = async () => {
      providerCalls += 1;
      return zerionPositions(75);
    };
    const detail = await request(app)
      .get(`/api/v1/wallets/${walletId}/portfolio-summary?includePositions=true`)
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.positionsTotalUsd, 75);
    assert.equal(detail.body.data.totalPortfolioUsd, 175);
    assert.equal(detail.body.data.positionsValuationAvailable, true);
    assert.notEqual(detail.body.data.reason, `PERSISTED_POSITIONS_CACHE:${chainId}`);
    assert.equal(providerCalls, 2);
    const updated = await query(
      'SELECT positions FROM wallet_chain_positions_cache WHERE wallet_id = $1 AND chain_id = $2',
      [walletId, chainId]
    );
    assert.equal(updated.rows[0].positions[0].valueUsd, 75);

    Date.now = () => realNow() + 122_000;
    global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const degraded = await getWalletPositions(walletId, { userId: ownerId });
    assert.equal(degraded.isPartial, true);
    const stillGood = await query(
      'SELECT positions FROM wallet_chain_positions_cache WHERE wallet_id = $1 AND chain_id = $2',
      [walletId, chainId]
    );
    assert.equal(stillGood.rows[0].positions[0].valueUsd, 75);
  } finally {
    Date.now = realNow;
  }
});

test('list mode keeps its no-positions behavior when no persisted result exists', async () => {
  let providerCalls = 0;
  global.fetch = () => {
    providerCalls += 1;
    throw new Error('List mode must not fetch Zerion');
  };
  const list = await request(app)
    .get(`/api/v1/wallets/${emptyWalletId}/portfolio-summary?includePositions=false`)
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.positionsTotalUsd, null);
  assert.equal(list.body.data.reason, 'POSITIONS_NOT_FETCHED_LIST_MODE');
  assert.equal(providerCalls, 0);
});

test('list mode ignores positions older than 24 hours without deleting or refetching them', async () => {
  let providerCalls = 0;
  global.fetch = () => {
    providerCalls += 1;
    throw new Error('List mode must not fetch Zerion');
  };
  const list = await request(app)
    .get(`/api/v1/wallets/${staleWalletId}/portfolio-summary?includePositions=false`)
    .set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.positionsTotalUsd, null);
  assert.equal(list.body.data.reason, 'POSITIONS_NOT_FETCHED_LIST_MODE');
  assert.equal(providerCalls, 0);
  const stored = await query(
    'SELECT captured_at, updated_at FROM wallet_chain_positions_cache WHERE wallet_id = $1',
    [staleWalletId]
  );
  assert.equal(stored.rows.length, 1);
  assert.ok(stored.rows[0].updated_at > stored.rows[0].captured_at);

  await query(
    `UPDATE wallet_chain_positions_cache
     SET captured_at = NOW() - INTERVAL '23 hours 59 minutes 50 seconds'
     WHERE wallet_id = $1`,
    [staleWalletId]
  );
  const nearCutoff = await getCachedWalletPositions(staleWalletId, { userId: ownerId });
  assert.equal(nearCutoff.positions[0].valueUsd, 900);
  const realNow = Date.now;
  Date.now = () => realNow() + 15_000;
  try {
    assert.equal(await getCachedWalletPositions(staleWalletId, { userId: ownerId }), null);
    assert.equal(providerCalls, 0);
  } finally {
    Date.now = realNow;
  }
});

test('positions cache and portfolio summary preserve wallet ownership', async () => {
  await assert.rejects(
    getCachedWalletPositions(walletId, { userId: otherUserId }),
    (error) => error.statusCode === 404 && error.code === 'WALLET_NOT_FOUND'
  );
  const list = await request(app)
    .get(`/api/v1/wallets/${walletId}/portfolio-summary?includePositions=false`)
    .set('Authorization', `Bearer ${otherToken}`);
  assert.equal(list.status, 404);
  assert.equal(list.body.error.code, 'WALLET_NOT_FOUND');
});
