import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, before, after } from 'node:test';
import { spawnSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'dev_jwt_secret_that_is_long_enough_for_local_checks';
process.env.ENABLE_PUSH_NOTIFICATIONS = 'false';
process.env.ENABLE_ETHEREUM_TRACKER = 'false';
process.env.ENABLE_PORTFOLIO_SNAPSHOT_JOB = 'false';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';
process.env.ZERION_API_KEY = '';
process.env.DEFAULT_WALLET_ALERT_MINIMUM_USD = '100';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const migrationsDir = path.join(repoRoot, 'src/db/migrations');

const supertest = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');
const { createAccessToken } = await import('../src/utils/jwt.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { insertWalletEvents } = await import('../src/modules/events/events.repository.js');

const app = createApp();
const request = supertest(app);

const ownerUser = {
  id: randomUUID(),
  email: `owner-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
};
const nonOwnerUser = {
  id: randomUUID(),
  email: `non-owner-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
};
const wallet = {
  id: randomUUID(),
  chainId: 'ethereum-mainnet',
  address: '0x1111111111111111111111111111111111111111',
  label: 'Auth Test Wallet'
};

const ownerToken = await createAccessToken(ownerUser);
const nonOwnerToken = await createAccessToken(nonOwnerUser);

const persistedHoldingsPayload = {
  walletId: wallet.id,
  chainId: wallet.chainId,
  enabledChains: [wallet.chainId],
  totalBalanceUsd: 123.45,
  holdings: [
    {
      chainId: wallet.chainId,
      tokenAddress: null,
      symbol: 'ETH',
      name: 'Ethereum',
      balance: '0.05',
      balanceUsd: 123.45,
      isNative: true,
      isSuspicious: false,
      suspicionReasons: []
    }
  ],
  tokenBalancesAvailable: true,
  tokenBalancesReason: null,
  isPartial: false,
  partialReasons: []
};

async function seedAuthorizationFixtures() {
  await query(
    `
      INSERT INTO app_users (id, email, name, password_hash)
      VALUES
        ($1, LOWER($2), 'Owner', NULL),
        ($3, LOWER($4), 'Non Owner', NULL)
    `,
    [ownerUser.id, ownerUser.email, nonOwnerUser.id, nonOwnerUser.email]
  );

  await query(
    `
      INSERT INTO tracked_wallets (id, user_id, chain_id, address, label, status)
      VALUES ($1, $2, $3, LOWER($4), $5, 'active')
    `,
    [wallet.id, ownerUser.id, wallet.chainId, wallet.address, wallet.label]
  );

  await query(
    `
      INSERT INTO wallet_chains (wallet_id, chain_id, enabled)
      VALUES ($1, $2, TRUE)
      ON CONFLICT (wallet_id, chain_id) DO NOTHING
    `,
    [wallet.id, wallet.chainId]
  );

  await query(
    `
      INSERT INTO wallet_chain_holdings_cache (
        wallet_id,
        wallet_address,
        chain_id,
        payload,
        holdings_count,
        total_balance_usd,
        token_balances_available,
        is_partial,
        captured_at,
        updated_at
      )
      VALUES (
        $1,
        LOWER($2),
        $3,
        $4::jsonb,
        1,
        123.45,
        TRUE,
        FALSE,
        NOW(),
        NOW()
      )
      ON CONFLICT (wallet_id, chain_id) DO UPDATE SET
        wallet_address = EXCLUDED.wallet_address,
        payload = EXCLUDED.payload,
        holdings_count = EXCLUDED.holdings_count,
        total_balance_usd = EXCLUDED.total_balance_usd,
        token_balances_available = EXCLUDED.token_balances_available,
        is_partial = EXCLUDED.is_partial,
        captured_at = EXCLUDED.captured_at,
        updated_at = NOW()
    `,
    [wallet.id, wallet.address, wallet.chainId, JSON.stringify(persistedHoldingsPayload)]
  );
}

async function cleanupAuthorizationFixtures() {
  await query('DELETE FROM wallet_alert_settings WHERE wallet_id = $1', [wallet.id]);
  await query('DELETE FROM wallet_chain_holdings_cache WHERE wallet_id = $1', [wallet.id]);
  await query('DELETE FROM wallet_chains WHERE wallet_id = $1', [wallet.id]);
  await query('DELETE FROM wallet_events WHERE wallet_id = $1', [wallet.id]);
  await query('DELETE FROM wallet_track_preferences WHERE wallet_id = $1', [wallet.id]);
  await query('DELETE FROM tracked_wallets WHERE id = $1', [wallet.id]);
  await query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [[ownerUser.id, nonOwnerUser.id]]);
}

async function clearWalletEventArtifacts() {
  await query('DELETE FROM wallet_alert_settings WHERE wallet_id = $1', [wallet.id]);
  await query('DELETE FROM wallet_events WHERE wallet_id = $1', [wallet.id]);
}

function buildTestWalletEvent(overrides = {}) {
  const transactionHash = overrides.transactionHash ?? `0x${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`;
  const blockNumber = overrides.blockNumber ?? Math.floor(Date.now() / 1000);

  return {
    walletId: wallet.id,
    chainId: overrides.chainId ?? wallet.chainId,
    transactionHash,
    eventType: overrides.eventType ?? 'native_transfer',
    assetType: overrides.assetType ?? 'coin',
    assetSymbol: overrides.assetSymbol ?? 'ETH',
    assetName: overrides.assetName ?? 'Ethereum',
    amount: overrides.amount ?? '1',
    tokenContractAddress: overrides.tokenContractAddress ?? null,
    nftContractAddress: overrides.nftContractAddress ?? null,
    nftTokenId: overrides.nftTokenId ?? null,
    marketplace: overrides.marketplace ?? null,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    explorerUrl: overrides.explorerUrl ?? `https://etherscan.io/tx/${transactionHash}`,
    rawPayload: overrides.rawPayload ?? { source: 'test' },
    blockNumber,
    logIndex: overrides.logIndex ?? 0,
    fromAddress: overrides.fromAddress ?? '0x2222222222222222222222222222222222222222',
    toAddress: overrides.toAddress ?? wallet.address.toLowerCase(),
    amountWei: overrides.amountWei ?? '1000000000000000000',
    direction: overrides.direction ?? 'incoming'
  };
}

async function getWalletEventRowByTransactionHash(transactionHash) {
  const result = await query(
    `
      SELECT
        id,
        wallet_id,
        transaction_hash,
        event_type,
        asset_type,
        amount,
        usd_value,
        usd_value_status,
        usd_value_source,
        usd_value_calculated_at
      FROM wallet_events
      WHERE wallet_id = $1 AND transaction_hash = $2
      LIMIT 1
    `,
    [wallet.id, transactionHash]
  );

  return result.rows[0] ?? null;
}

async function countNotificationOutboxRowsForTransaction(transactionHash) {
  const result = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM notification_outbox no
      INNER JOIN wallet_events we ON we.id = no.wallet_event_id
      WHERE we.wallet_id = $1
        AND we.transaction_hash = $2
    `,
    [wallet.id, transactionHash]
  );

  return result.rows[0]?.count ?? 0;
}

function runMigrationScript() {
  const result = spawnSync('node', ['src/scripts/runMigrations.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      JWT_SECRET: process.env.JWT_SECRET
    },
    encoding: 'utf8'
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  };
}

before(async () => {
  await cleanupAuthorizationFixtures();
  await seedAuthorizationFixtures();
});

after(async () => {
  await cleanupAuthorizationFixtures();
  await pool.end();
});

describe('wallet data authorization', () => {
  const routeExpectations = [
    {
      name: 'holdings',
      path: `/api/v1/wallets/${wallet.id}/holdings`,
      assertBody: (body) => {
        assert.equal(body.data.walletId, wallet.id);
        assert.ok(Array.isArray(body.data.holdings));
      }
    },
    {
      name: 'positions',
      path: `/api/v1/wallets/${wallet.id}/positions`,
      assertBody: (body) => {
        assert.equal(body.data.walletId, wallet.id);
        assert.ok(Array.isArray(body.data.positions));
      }
    },
    {
      name: 'portfolio summary',
      path: `/api/v1/wallets/${wallet.id}/portfolio-summary?includePositions=false`,
      assertBody: (body) => {
        assert.equal(body.data.walletId, wallet.id);
        assert.ok(Object.hasOwn(body.data, 'totalPortfolioUsd'));
      }
    },
    {
      name: 'wallet events',
      path: `/api/v1/wallets/${wallet.id}/events`,
      assertBody: (body) => {
        assert.ok(Array.isArray(body.data));
      }
    }
  ];

  for (const route of routeExpectations) {
    test(`${route.name} returns 401 without a token`, async () => {
      const response = await request.get(route.path);

      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'AUTH_MISSING_TOKEN');
    });

    test(`${route.name} returns 200 for the wallet owner`, async () => {
      const response = await request
        .get(route.path)
        .set('Authorization', `Bearer ${ownerToken}`);

      assert.equal(response.status, 200);
      route.assertBody(response.body);
    });

    test(`${route.name} returns 404 for a different authenticated user`, async () => {
      const response = await request
        .get(route.path)
        .set('Authorization', `Bearer ${nonOwnerToken}`);

      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'WALLET_NOT_FOUND');
    });
  }
});

describe('migration runner', () => {
  test('skips already applied migrations on the second run', async () => {
    const countBefore = await query('SELECT COUNT(*)::int AS count FROM schema_migrations');
    const firstRun = runMigrationScript();
    const countAfterFirstRun = await query('SELECT COUNT(*)::int AS count FROM schema_migrations');
    const secondRun = runMigrationScript();
    const countAfterSecondRun = await query('SELECT COUNT(*)::int AS count FROM schema_migrations');

    assert.equal(firstRun.status, 0, firstRun.output);
    assert.equal(secondRun.status, 0, secondRun.output);
    assert.match(secondRun.output, /Skipping already applied migration/);
    assert.ok(countAfterFirstRun.rows[0].count >= countBefore.rows[0].count);
    assert.equal(countAfterSecondRun.rows[0].count, countAfterFirstRun.rows[0].count);
  });

  test('does not record a failed migration', async () => {
    const filename = `999_test_failure_${Date.now()}.sql`;
    const failingTableName = `tmp_failed_migration_${Date.now()}`;
    const migrationFilePath = path.join(migrationsDir, filename);

    await fs.writeFile(
      migrationFilePath,
      `
        CREATE TABLE ${failingTableName} (id INTEGER PRIMARY KEY);
        SELECT * FROM table_that_does_not_exist_for_test_failure;
      `.trimStart(),
      'utf8'
    );

    try {
      const result = runMigrationScript();
      const migrationRecord = await query(
        'SELECT filename FROM schema_migrations WHERE filename = $1',
        [filename]
      );
      const tableExists = await query(
        'SELECT to_regclass($1) AS table_name',
        [`public.${failingTableName}`]
      );

      assert.notEqual(result.status, 0, result.output);
      assert.equal(migrationRecord.rowCount, 0);
      assert.equal(tableExists.rows[0].table_name, null);
      assert.match(result.output, /Migration failed/);
    } finally {
      await fs.rm(migrationFilePath, { force: true });
      await query(`DROP TABLE IF EXISTS ${failingTableName}`);
      await query('DELETE FROM schema_migrations WHERE filename = $1', [filename]);
    }
  });
});

describe('event usd enrichment and alert filtering', () => {
  test('native ETH above threshold inserts wallet event and creates notification outbox', async () => {
    await clearWalletEventArtifacts();
    const event = buildTestWalletEvent({
      amount: '0.2',
      amountWei: '200000000000000000'
    });

    await insertWalletEvents([event], null, {
      getEthUsdPrice: async () => 3000
    });

    const storedEvent = await getWalletEventRowByTransactionHash(event.transactionHash);
    const outboxCount = await countNotificationOutboxRowsForTransaction(event.transactionHash);

    assert.ok(storedEvent);
    assert.equal(Number(storedEvent.usd_value), 600);
    assert.equal(storedEvent.usd_value_status, 'priced_native_eth');
    assert.equal(storedEvent.usd_value_source, 'eth_usd');
    assert.ok(storedEvent.usd_value_calculated_at);
    assert.equal(outboxCount, 1);
  });

  test('native ETH below threshold inserts wallet event but does not create notification outbox', async () => {
    await clearWalletEventArtifacts();
    const event = buildTestWalletEvent({
      amount: '0.01',
      amountWei: '10000000000000000'
    });

    await insertWalletEvents([event], null, {
      getEthUsdPrice: async () => 3000
    });

    const storedEvent = await getWalletEventRowByTransactionHash(event.transactionHash);
    const outboxCount = await countNotificationOutboxRowsForTransaction(event.transactionHash);

    assert.ok(storedEvent);
    assert.equal(Number(storedEvent.usd_value), 30);
    assert.equal(storedEvent.usd_value_status, 'priced_native_eth');
    assert.equal(outboxCount, 0);
  });

  test('canonical stablecoin above threshold creates notification outbox', async () => {
    await clearWalletEventArtifacts();
    const event = buildTestWalletEvent({
      eventType: 'token_transfer',
      assetType: 'token',
      assetSymbol: 'USDC',
      assetName: 'USD Coin',
      amount: '150',
      amountWei: null,
      tokenContractAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    });

    await insertWalletEvents([event]);

    const storedEvent = await getWalletEventRowByTransactionHash(event.transactionHash);
    const outboxCount = await countNotificationOutboxRowsForTransaction(event.transactionHash);

    assert.ok(storedEvent);
    assert.equal(Number(storedEvent.usd_value), 150);
    assert.equal(storedEvent.usd_value_status, 'priced_canonical_stablecoin');
    assert.equal(storedEvent.usd_value_source, 'canonical_stablecoin_parity');
    assert.equal(outboxCount, 1);
  });

  test('unknown token inserts wallet event but does not create notification outbox', async () => {
    await clearWalletEventArtifacts();
    const event = buildTestWalletEvent({
      eventType: 'token_transfer',
      assetType: 'token',
      assetSymbol: 'MYST',
      assetName: 'Mystery Token',
      amount: '9999',
      amountWei: null,
      tokenContractAddress: '0x9999999999999999999999999999999999999999'
    });

    await insertWalletEvents([event]);

    const storedEvent = await getWalletEventRowByTransactionHash(event.transactionHash);
    const outboxCount = await countNotificationOutboxRowsForTransaction(event.transactionHash);

    assert.ok(storedEvent);
    assert.equal(storedEvent.usd_value, null);
    assert.equal(storedEvent.usd_value_status, 'unknown_token');
    assert.equal(outboxCount, 0);
  });

  test('native ETH pricing failure still inserts wallet event without notification outbox', async () => {
    await clearWalletEventArtifacts();
    const event = buildTestWalletEvent({
      amount: '1',
      amountWei: '1000000000000000000'
    });

    await insertWalletEvents([event], null, {
      getEthUsdPrice: async () => {
        throw new Error('forced pricing failure');
      }
    });

    const storedEvent = await getWalletEventRowByTransactionHash(event.transactionHash);
    const outboxCount = await countNotificationOutboxRowsForTransaction(event.transactionHash);

    assert.ok(storedEvent);
    assert.equal(storedEvent.usd_value, null);
    assert.equal(storedEvent.usd_value_status, 'unpriced');
    assert.equal(storedEvent.usd_value_source, null);
    assert.equal(outboxCount, 0);
  });

  test('NFT event keeps usd value null and respects notify_nft_transfers', async () => {
    await clearWalletEventArtifacts();
    await query(
      `
        INSERT INTO wallet_alert_settings (
          wallet_id,
          notify_nft_transfers,
          notifications_enabled
        )
        VALUES ($1, FALSE, TRUE)
      `,
      [wallet.id]
    );

    const event = buildTestWalletEvent({
      eventType: 'nft_transfer',
      assetType: 'nft',
      assetSymbol: 'NFT',
      assetName: 'Test NFT',
      amount: '1',
      amountWei: null,
      tokenContractAddress: null,
      nftContractAddress: '0x4444444444444444444444444444444444444444',
      nftTokenId: '123'
    });

    await insertWalletEvents([event]);

    const storedEvent = await getWalletEventRowByTransactionHash(event.transactionHash);
    const outboxCount = await countNotificationOutboxRowsForTransaction(event.transactionHash);

    assert.ok(storedEvent);
    assert.equal(storedEvent.usd_value, null);
    assert.equal(storedEvent.usd_value_status, 'unsupported_nft');
    assert.equal(outboxCount, 0);
  });

  test('notifications_enabled false prevents notification outbox creation', async () => {
    await clearWalletEventArtifacts();
    await query(
      `
        INSERT INTO wallet_alert_settings (
          wallet_id,
          notifications_enabled,
          minimum_alert_usd
        )
        VALUES ($1, FALSE, 1)
      `,
      [wallet.id]
    );

    const event = buildTestWalletEvent({
      amount: '1',
      amountWei: '1000000000000000000'
    });

    await insertWalletEvents([event], null, {
      getEthUsdPrice: async () => 3000
    });

    const outboxCount = await countNotificationOutboxRowsForTransaction(event.transactionHash);
    assert.equal(outboxCount, 0);
  });

  test('missing wallet_alert_settings uses defaults', async () => {
    await clearWalletEventArtifacts();
    const event = buildTestWalletEvent({
      amount: '0.04',
      amountWei: '40000000000000000'
    });

    await insertWalletEvents([event], null, {
      getEthUsdPrice: async () => 3000
    });

    const outboxCount = await countNotificationOutboxRowsForTransaction(event.transactionHash);
    assert.equal(outboxCount, 1);
  });

  test('wallet events response shape still works after valued event insertion', async () => {
    await clearWalletEventArtifacts();
    const event = buildTestWalletEvent({
      amount: '0.2',
      amountWei: '200000000000000000'
    });

    await insertWalletEvents([event], null, {
      getEthUsdPrice: async () => 3000
    });

    const response = await request
      .get(`/api/v1/wallets/${wallet.id}/events`)
      .set('Authorization', `Bearer ${ownerToken}`);

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    assert.equal(response.body.data[0].transactionHash, event.transactionHash);
    assert.equal(response.body.data[0].eventType, event.eventType);
  });
});
