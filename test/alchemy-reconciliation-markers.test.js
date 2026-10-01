import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const {
  countActiveWalletsByChainIdAndAddress,
  createWalletWithPreferences,
  deleteWalletById,
  findWalletById,
  updateWalletById
} = await import('../src/modules/wallets/wallets.repository.js');
const { markAlchemyAddressPairsDirty } = await import('../src/modules/webhooks/alchemyAddressReconciliation.repository.js');

const ethereum = 'ethereum-mainnet';
const base = 'base-mainnet';
const users = new Set();
const addresses = new Set();
const originalFetch = global.fetch;

after(async () => {
  global.fetch = originalFetch;
  try {
    await query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [[...users]]);
    await query('DELETE FROM alchemy_address_reconciliation WHERE normalized_address = ANY($1::text[])', [[...addresses]]);
  } finally {
    await pool.end();
  }
});

function address() {
  const value = `0x${randomBytes(20).toString('hex')}`;
  addresses.add(value);
  return value;
}

async function user() {
  const id = randomUUID();
  users.add(id);
  await query('INSERT INTO app_users (id) VALUES ($1)', [id]);
  return id;
}

async function markers(value) {
  const result = await query(
    `SELECT chain_id, normalized_address, generation, attempt_count, claim_token,
            lease_expires_at, last_error_code
     FROM alchemy_address_reconciliation
     WHERE normalized_address = $1
     ORDER BY chain_id`,
    [value.toLowerCase()]
  );
  return result.rows;
}

async function createWallet(userId, walletAddress, enabledChains = [ethereum]) {
  return createWalletWithPreferences({
    userId,
    chainId: enabledChains[0],
    address: walletAddress,
    label: null,
    trackTypes: ['native_transfer'],
    enabledChains
  });
}

test('create commits the wallet and one marker per enabled chain', async () => {
  const userId = await user();
  const walletAddress = address();
  const wallet = await createWallet(userId, walletAddress.toUpperCase().replace('0X', '0x'), [ethereum, base]);
  assert.equal(wallet.address, walletAddress);
  assert.deepEqual(wallet.enabledChains.sort(), [base, ethereum].sort());
  assert.deepEqual((await markers(walletAddress)).map((row) => [row.chain_id, row.generation]), [
    [base, '1'], [ethereum, '1']
  ]);
});

test('create rolls back wallet and chains if marker upsert fails', async () => {
  const userId = await user();
  const walletAddress = address();
  await query(
    'INSERT INTO alchemy_address_reconciliation (chain_id, normalized_address, generation) VALUES ($1, $2, $3)',
    [ethereum, walletAddress, '9223372036854775807']
  );

  await assert.rejects(createWallet(userId, walletAddress), (error) => error.code === '22003');
  assert.equal((await query('SELECT id FROM tracked_wallets WHERE user_id = $1', [userId])).rowCount, 0);
  assert.equal((await markers(walletAddress))[0].generation, '9223372036854775807');
});

test('update marks old and new desired pairs; label update does not mark', async () => {
  const userId = await user();
  const oldAddress = address();
  const newAddress = address();
  const wallet = await createWallet(userId, oldAddress);

  await updateWalletById(wallet.id, userId, { enabledChains: [ethereum, base] });
  assert.deepEqual((await markers(oldAddress)).map((row) => [row.chain_id, row.generation]), [
    [base, '1'], [ethereum, '2']
  ]);

  await updateWalletById(wallet.id, userId, { enabledChains: [base] });
  assert.deepEqual((await markers(oldAddress)).map((row) => [row.chain_id, row.generation]), [
    [base, '2'], [ethereum, '3']
  ]);

  await updateWalletById(wallet.id, userId, { address: newAddress });
  assert.deepEqual((await markers(oldAddress)).map((row) => [row.chain_id, row.generation]), [
    [base, '3'], [ethereum, '3']
  ]);
  assert.deepEqual((await markers(newAddress)).map((row) => [row.chain_id, row.generation]), [[base, '1']]);

  await updateWalletById(wallet.id, userId, { label: 'Changed label' });
  assert.equal((await markers(newAddress))[0].generation, '1');
});

test('delete commits wallet removal and marks every old desired pair', async () => {
  const userId = await user();
  const walletAddress = address();
  const wallet = await createWallet(userId, walletAddress, [ethereum, base]);

  await deleteWalletById(wallet.id, userId);
  assert.equal((await query('SELECT id FROM tracked_wallets WHERE id = $1', [wallet.id])).rowCount, 0);
  assert.deepEqual((await markers(walletAddress)).map((row) => [row.chain_id, row.generation]), [
    [base, '2'], [ethereum, '2']
  ]);
});

test('update rolls back wallet and chain changes if marker upsert fails', async () => {
  const userId = await user();
  const walletAddress = address();
  const wallet = await createWallet(userId, walletAddress);
  await query(
    'UPDATE alchemy_address_reconciliation SET generation = $3 WHERE chain_id = $1 AND normalized_address = $2',
    [ethereum, walletAddress, '9223372036854775807']
  );

  await assert.rejects(
    updateWalletById(wallet.id, userId, { enabledChains: [ethereum, base] }),
    (error) => error.code === '22003'
  );
  assert.deepEqual((await findWalletById(wallet.id, userId)).enabledChains, [ethereum]);
  assert.deepEqual((await markers(walletAddress)).map((row) => [row.chain_id, row.generation]), [
    [ethereum, '9223372036854775807']
  ]);
});

test('delete rolls back when marker upsert fails', async () => {
  const userId = await user();
  const walletAddress = address();
  const wallet = await createWallet(userId, walletAddress);
  await query(
    'UPDATE alchemy_address_reconciliation SET generation = $3 WHERE chain_id = $1 AND normalized_address = $2',
    [ethereum, walletAddress, '9223372036854775807']
  );

  await assert.rejects(deleteWalletById(wallet.id, userId), (error) => error.code === '22003');
  assert.equal((await query('SELECT id FROM tracked_wallets WHERE id = $1', [wallet.id])).rowCount, 1);
  assert.equal((await markers(walletAddress))[0].generation, '9223372036854775807');
});

test('shared addresses keep one marker and repeated marks advance generation', async () => {
  const firstUser = await user();
  const secondUser = await user();
  const walletAddress = address();
  await createWallet(firstUser, walletAddress);
  await createWallet(secondUser, walletAddress);

  assert.deepEqual((await markers(walletAddress)).map((row) => [row.chain_id, row.generation]), [[ethereum, '2']]);
  await query(
    `UPDATE alchemy_address_reconciliation
     SET attempt_count = 3,
         next_attempt_at = NOW() + INTERVAL '1 day',
         claim_token = $3,
         lease_expires_at = NOW() + INTERVAL '1 minute',
         last_error_code = 'PROVIDER_TIMEOUT'
     WHERE chain_id = $1 AND normalized_address = $2`,
    [ethereum, walletAddress, randomUUID()]
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await markAlchemyAddressPairsDirty(client, [
      { chainId: ethereum, address: walletAddress },
      { chainId: ethereum, address: walletAddress.toUpperCase().replace('0X', '0x') }
    ]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const [marker] = await markers(walletAddress);
  assert.equal(marker.generation, '3');
  assert.equal(marker.attempt_count, 0);
  assert.equal(marker.claim_token, null);
  assert.equal(marker.lease_expires_at, null);
  assert.equal(marker.last_error_code, null);
  assert.equal((await query(
    'SELECT next_attempt_at <= NOW() AS due FROM alchemy_address_reconciliation WHERE chain_id = $1 AND normalized_address = $2',
    [ethereum, walletAddress]
  )).rows[0].due, true);
});

test('no wallet_chains row means no desired watch or enabled-chain fallback', async () => {
  const userId = await user();
  const walletAddress = address();
  const walletId = randomUUID();
  await query(
    'INSERT INTO tracked_wallets (id, user_id, chain_id, address) VALUES ($1, $2, $3, $4)',
    [walletId, userId, ethereum, walletAddress]
  );

  const wallet = await findWalletById(walletId, userId);
  assert.deepEqual(wallet.enabledChains, []);
  assert.equal(await countActiveWalletsByChainIdAndAddress(ethereum, walletAddress), 0);
  assert.deepEqual(await markers(walletAddress), []);
});
