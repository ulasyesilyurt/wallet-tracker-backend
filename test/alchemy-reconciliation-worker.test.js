import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

const { pool } = await import('../src/db/pool.js');
const { query } = await import('../src/db/query.js');
const { createWalletWithPreferences, deleteWalletById } = await import('../src/modules/wallets/wallets.repository.js');
const {
  claimAlchemyAddressReconciliationRows,
  markAlchemyAddressPairsDirty
} = await import('../src/modules/webhooks/alchemyAddressReconciliation.repository.js');
const {
  processAlchemyReconciliationBatch,
  reconcileClaimedAlchemyAddress
} = await import('../src/modules/webhooks/alchemyAddressReconciliation.service.js');
const { AlchemyAddressReconciliationWorker } = await import('../src/modules/webhooks/alchemyAddressReconciliation.worker.js');

const ethereum = 'ethereum-mainnet';
const base = 'base-mainnet';
const users = new Set();
const addresses = new Set();

after(async () => {
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

async function wallet(userId, walletAddress, chainId = ethereum) {
  return createWalletWithPreferences({
    userId,
    chainId,
    enabledChains: [chainId],
    address: walletAddress,
    trackTypes: ['native_transfer']
  });
}

async function mark(chainId, walletAddress) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await markAlchemyAddressPairsDirty(client, [{ chainId, address: walletAddress }]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function marker(chainId, walletAddress) {
  const result = await query(
    'SELECT * FROM alchemy_address_reconciliation WHERE chain_id = $1 AND normalized_address = $2',
    [chainId, walletAddress]
  );
  return result.rows[0] ?? null;
}

function provider() {
  const watched = new Map([[ethereum, new Set()], [base, new Set()]]);
  const calls = [];
  return {
    watched,
    calls,
    listWatched: async (chainId) => [...watched.get(chainId)],
    addAddress: async ({ chainId, address: walletAddress }) => {
      calls.push(['add', chainId, walletAddress]);
      watched.get(chainId).add(walletAddress);
    },
    removeAddress: async ({ chainId, address: walletAddress }) => {
      calls.push(['remove', chainId, walletAddress]);
      watched.get(chainId).delete(walletAddress);
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function claimOne(chainId, walletAddress) {
  const [claim] = await claimAlchemyAddressReconciliationRows({
    limit: 1, leaseMs: 30_000, chainId, address: walletAddress
  });
  assert.ok(claim);
  return claim;
}

for (const [desired, observed, operation] of [
  [true, false, 'add'],
  [true, true, null],
  [false, true, 'remove'],
  [false, false, null]
]) {
  test(`desired ${desired} / observed ${observed} converges with ${operation ?? 'no'} PATCH`, async () => {
    const walletAddress = address();
    if (desired) await wallet(await user(), walletAddress);
    else await mark(ethereum, walletAddress);
    const alchemy = provider();
    if (observed) alchemy.watched.get(ethereum).add(walletAddress);

    const claim = await claimOne(ethereum, walletAddress);
    assert.equal(await reconcileClaimedAlchemyAddress(claim, alchemy), 'converged');
    assert.equal(await marker(ethereum, walletAddress), null);
    assert.equal(alchemy.watched.get(ethereum).has(walletAddress), desired);
    assert.deepEqual(alchemy.calls.map((call) => call[0]), operation ? [operation] : []);
  });
}

test('generation advance during provider call preserves the newer marker', async () => {
  const walletAddress = address();
  await wallet(await user(), walletAddress);
  const alchemy = provider();
  const claim = await claimOne(ethereum, walletAddress);
  const initialGeneration = claim.generation;
  const originalAdd = alchemy.addAddress;
  alchemy.addAddress = async (args) => {
    await originalAdd(args);
    await mark(ethereum, walletAddress);
  };

  assert.equal(await reconcileClaimedAlchemyAddress(claim, alchemy), 'superseded');
  assert.equal((await marker(ethereum, walletAddress)).generation, String(Number(initialGeneration) + 1));
  assert.equal((await marker(ethereum, walletAddress)).claim_token, null);
  const newerClaim = await claimOne(ethereum, walletAddress);
  assert.equal(await reconcileClaimedAlchemyAddress(newerClaim, alchemy), 'converged');
  assert.equal(await marker(ethereum, walletAddress), null);
  assert.equal(alchemy.calls.length, 1);
});

test('transient failure schedules retry and a later pass completes', async () => {
  const walletAddress = address();
  await wallet(await user(), walletAddress);
  const alchemy = provider();
  let fail = true;
  const originalList = alchemy.listWatched;
  alchemy.listWatched = async (chainId) => {
    if (fail) throw Object.assign(new Error('provider unavailable'), { status: 503 });
    return originalList(chainId);
  };
  const reconcileClaim = (claim) => reconcileClaimedAlchemyAddress(claim, alchemy);

  const claimRows = ({ limit, leaseMs }) => claimAlchemyAddressReconciliationRows({
    limit, leaseMs, chainId: ethereum, address: walletAddress
  });
  const first = await processAlchemyReconciliationBatch({ limit: 1, claimRows, reconcileClaim, random: () => 0 });
  assert.equal(first.retryScheduledCount, 1);
  const pending = await marker(ethereum, walletAddress);
  assert.equal(pending.attempt_count, 1);
  assert.equal(pending.last_error_code, 'PROVIDER_HTTP_5XX');
  assert.equal(pending.claim_token, null);
  assert.ok(pending.next_attempt_at > new Date());

  fail = false;
  await query('UPDATE alchemy_address_reconciliation SET next_attempt_at = NOW() WHERE chain_id = $1 AND normalized_address = $2',
    [ethereum, walletAddress]);
  const second = await processAlchemyReconciliationBatch({ limit: 1, claimRows, reconcileClaim });
  assert.equal(second.convergedCount, 1);
  assert.equal(await marker(ethereum, walletAddress), null);
});

test('expired claim is reclaimed and stale claimant cannot complete', async () => {
  const walletAddress = address();
  await mark(ethereum, walletAddress);
  const first = await claimOne(ethereum, walletAddress);
  assert.deepEqual(await claimAlchemyAddressReconciliationRows({
    limit: 1, leaseMs: 30_000, chainId: ethereum, address: walletAddress
  }), []);
  await query('UPDATE alchemy_address_reconciliation SET lease_expires_at = NOW() - INTERVAL \'1 second\' WHERE chain_id = $1 AND normalized_address = $2',
    [ethereum, walletAddress]);
  const second = await claimOne(ethereum, walletAddress);
  assert.equal(second.stale, true);
  assert.notEqual(second.claimToken, first.claimToken);
  const alchemy = provider();
  assert.equal(await reconcileClaimedAlchemyAddress(first, alchemy), 'superseded');
  assert.equal(await reconcileClaimedAlchemyAddress(second, alchemy), 'converged');
});

test('claiming is bounded and two instances cannot own one live marker', async () => {
  const firstAddress = address();
  const secondAddress = address();
  await mark(ethereum, firstAddress);
  await mark(base, secondAddress);
  const [first, second] = await Promise.all([
    claimAlchemyAddressReconciliationRows({ limit: 1, leaseMs: 30_000, chainId: ethereum, address: firstAddress }),
    claimAlchemyAddressReconciliationRows({ limit: 1, leaseMs: 30_000, chainId: ethereum, address: firstAddress })
  ]);
  assert.equal(first.length + second.length, 1);
  const firstClaim = first[0] ?? second[0];
  const other = await claimAlchemyAddressReconciliationRows({
    limit: 1, leaseMs: 30_000, chainId: base, address: secondAddress
  });
  assert.equal(other.length, 1);
  assert.deepEqual(await claimAlchemyAddressReconciliationRows({
    limit: 1, leaseMs: 30_000, chainId: ethereum, address: firstAddress
  }), []);
  const alchemy = provider();
  await reconcileClaimedAlchemyAddress(firstClaim, alchemy);
  await reconcileClaimedAlchemyAddress(other[0], alchemy);
});

test('shared address stays watched when one user deletes its wallet', async () => {
  const walletAddress = address();
  const firstUser = await user();
  const secondUser = await user();
  const firstWallet = await wallet(firstUser, walletAddress);
  await wallet(secondUser, walletAddress);
  const alchemy = provider();
  alchemy.watched.get(ethereum).add(walletAddress);
  await deleteWalletById(firstWallet.id, firstUser);

  assert.equal(await reconcileClaimedAlchemyAddress(await claimOne(ethereum, walletAddress), alchemy), 'converged');
  assert.deepEqual(alchemy.calls, []);
  assert.equal(alchemy.watched.get(ethereum).has(walletAddress), true);
});

test('last-tracker delete followed by concurrent add converges to watched', async () => {
  const walletAddress = address();
  const firstUser = await user();
  const secondUser = await user();
  const firstWallet = await wallet(firstUser, walletAddress);
  await deleteWalletById(firstWallet.id, firstUser);
  const alchemy = provider();
  alchemy.watched.get(ethereum).add(walletAddress);
  const entered = deferred();
  const release = deferred();
  const originalList = alchemy.listWatched;
  let firstList = true;
  alchemy.listWatched = async (chainId) => {
    if (firstList) {
      firstList = false;
      entered.resolve();
      await release.promise;
    }
    return originalList(chainId);
  };

  const processing = reconcileClaimedAlchemyAddress(await claimOne(ethereum, walletAddress), alchemy);
  await entered.promise;
  let addCommitted = false;
  const adding = wallet(secondUser, walletAddress).then(() => { addCommitted = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(addCommitted, false);
  release.resolve();
  await processing;
  await adding;
  assert.equal(await reconcileClaimedAlchemyAddress(await claimOne(ethereum, walletAddress), alchemy), 'converged');
  assert.equal(alchemy.watched.get(ethereum).has(walletAddress), true);
  assert.deepEqual(alchemy.calls.map((call) => call[0]), ['remove', 'add']);
});

test('add followed by concurrent delete converges to unwatched', async () => {
  const walletAddress = address();
  const userId = await user();
  const tracked = await wallet(userId, walletAddress);
  const alchemy = provider();
  const entered = deferred();
  const release = deferred();
  const originalList = alchemy.listWatched;
  let firstList = true;
  alchemy.listWatched = async (chainId) => {
    if (firstList) {
      firstList = false;
      entered.resolve();
      await release.promise;
    }
    return originalList(chainId);
  };

  const processing = reconcileClaimedAlchemyAddress(await claimOne(ethereum, walletAddress), alchemy);
  await entered.promise;
  let deleteCommitted = false;
  const deleting = deleteWalletById(tracked.id, userId).then(() => { deleteCommitted = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deleteCommitted, false);
  release.resolve();
  await processing;
  await deleting;
  assert.equal(await reconcileClaimedAlchemyAddress(await claimOne(ethereum, walletAddress), alchemy), 'converged');
  assert.equal(alchemy.watched.get(ethereum).has(walletAddress), false);
  assert.deepEqual(alchemy.calls.map((call) => call[0]), ['add', 'remove']);
});

test('Ethereum and Base observed states are isolated', async () => {
  const walletAddress = address();
  await wallet(await user(), walletAddress, ethereum);
  await wallet(await user(), walletAddress, base);
  const alchemy = provider();
  alchemy.watched.get(ethereum).add(walletAddress);
  const claims = [
    await claimOne(ethereum, walletAddress),
    await claimOne(base, walletAddress)
  ];
  for (const claim of claims) await reconcileClaimedAlchemyAddress(claim, alchemy);
  assert.deepEqual(alchemy.calls, [['add', base, walletAddress]]);
});

test('worker does not overlap cycles and stops polling cleanly', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = new AlchemyAddressReconciliationWorker({
    intervalMs: 10,
    batchSize: 1,
    processBatch: async () => { calls += 1; await gate; }
  });
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  const stopped = worker.stop();
  release();
  await stopped;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
});

test('stopping the worker aborts an in-flight cycle', async () => {
  const entered = deferred();
  let aborted = false;
  const worker = new AlchemyAddressReconciliationWorker({
    intervalMs: 1_000,
    processBatch: async ({ signal }) => {
      entered.resolve();
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      });
    }
  });
  worker.start();
  await entered.promise;
  await worker.stop();
  assert.equal(aborted, true);
});
