import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

const { pool } = await import('../src/db/pool.js');
const { withAlchemyAddressPairLock } = await import('../src/modules/webhooks/alchemyAddressReconciliation.repository.js');

const pair = {
  chainId: 'ethereum-mainnet',
  address: '0x1111111111111111111111111111111111111111'
};

after(async () => { await pool.end(); });

async function withMockClient({ unlockResult = true, unlockError = null } = {}, run) {
  const calls = [];
  const client = {
    async query(sql, params) {
      assert.deepEqual(params, [`alchemy-address:${pair.chainId}:${pair.address}`]);
      if (sql.includes('pg_advisory_unlock(')) {
        calls.push('unlock');
        if (unlockError) throw unlockError;
        return { rows: [{ pg_advisory_unlock: unlockResult }] };
      }
      assert.match(sql, /pg_advisory_lock\(/);
      calls.push('acquire');
      return { rows: [{}] };
    },
    release(discard) { calls.push(`release:${discard}`); }
  };
  const originalConnect = pool.connect;
  pool.connect = async () => {
    calls.push('connect');
    return client;
  };

  try {
    await run({ client, calls });
  } finally {
    pool.connect = originalConnect;
  }
}

test('successful operation acquires, runs, unlocks, then returns the same client normally', async () => {
  await withMockClient({}, async ({ client, calls }) => {
    const result = await withAlchemyAddressPairLock(pair, async (lockedClient) => {
      assert.equal(lockedClient, client);
      calls.push('operation');
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(calls, ['connect', 'acquire', 'operation', 'unlock', 'release:false']);
  });
});

test('provider error still unlocks on the same client before normal release', async () => {
  await withMockClient({}, async ({ client, calls }) => {
    const providerError = new Error('provider failed');
    await assert.rejects(
      withAlchemyAddressPairLock(pair, async (lockedClient) => {
        assert.equal(lockedClient, client);
        calls.push('operation');
        throw providerError;
      }),
      (error) => error === providerError
    );
    assert.deepEqual(calls, ['connect', 'acquire', 'operation', 'unlock', 'release:false']);
  });
});

test('unlock query error discards the connection', async () => {
  const unlockError = new Error('unlock query failed');
  await withMockClient({ unlockError }, async ({ calls }) => {
    await assert.rejects(
      withAlchemyAddressPairLock(pair, async () => { calls.push('operation'); }),
      (error) => error === unlockError
    );
    assert.deepEqual(calls, ['connect', 'acquire', 'operation', 'unlock', 'release:true']);
  });
});

test('unlock returning false discards the connection and surfaces a safe error', async () => {
  await withMockClient({ unlockResult: false }, async ({ calls }) => {
    await assert.rejects(
      withAlchemyAddressPairLock(pair, async () => { calls.push('operation'); }),
      (error) => error.code === 'ALCHEMY_ADVISORY_UNLOCK_UNCONFIRMED'
    );
    assert.deepEqual(calls, ['connect', 'acquire', 'operation', 'unlock', 'release:true']);
  });
});
