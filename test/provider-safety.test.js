import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_provider_checks';
process.env.LOG_LEVEL = 'silent';
process.env.PROVIDER_REQUEST_TIMEOUT_MS = '100';
process.env.ZERION_MAX_PAGES = '2';
process.env.ALCHEMY_TOKEN_BALANCE_MAX_PAGES = '2';
process.env.ZERION_API_KEY = 'test-zerion-key';
process.env.ALCHEMY_ETHEREUM_RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/test-alchemy-key';
process.env.ETHEREUM_RPC_URL = process.env.ALCHEMY_ETHEREUM_RPC_URL;

const { fetchAllErc20Balances, fetchChainEthUsdPrice } = await import('../src/modules/holdings/holdings.provider.js');
const { fetchWalletPositionsForChain } = await import('../src/modules/positions/positions.provider.js');
const { EthereumWalletActivityTracker } = await import('../src/modules/ethereum/ethereum.tracker.js');
const { createTimedRpcProvider, safeProviderError } = await import('../src/utils/providerRequests.js');
const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { createAccessToken } = await import('../src/utils/jwt.js');
const originalFetch = global.fetch;
let nextWalletId = 1;

after(async () => {
  global.fetch = originalFetch;
  await pool.end();
});

function wallet() {
  const id = nextWalletId++;
  return {
    id: `provider-test-${id}`,
    chainId: 'ethereum-mainnet',
    address: `0x${id.toString(16).padStart(40, '0')}`
  };
}

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data };
}

function waitForAbort(_url, options) {
  return new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
}

test('Alchemy RPC transport and tracker operations have explicit deadlines', async () => {
  const provider = createTimedRpcProvider(process.env.ETHEREUM_RPC_URL, 100);
  assert.equal(provider._getConnection().timeout, 100);
  provider.destroy();

  const tracker = new EthereumWalletActivityTracker({
    provider: { getBlockNumber: () => new Promise(() => {}) },
    logger: { warn() {} }
  });
  await assert.rejects(
    tracker.rpcCall('getBlockNumber', () => tracker.provider.getBlockNumber()),
    (error) => error.code === 'PROVIDER_TIMEOUT'
  );
});

test('Alchemy token balances stop after the page cap and report incomplete data', async () => {
  let calls = 0;
  const provider = {
    send: async () => {
      calls += 1;
      return {
        tokenBalances: [{ contractAddress: `0x${calls.toString(16).padStart(40, '0')}`, tokenBalance: '0x1' }],
        pageKey: `page-${calls}`
      };
    }
  };
  const result = await fetchAllErc20Balances(provider, 'ethereum-mainnet', wallet().address);
  assert.equal(calls, 2);
  assert.equal(result.tokenBalances.length, 2);
  assert.equal(result.tokenBalancesAvailable, false);
  assert.equal(result.tokenBalancesReason, 'TOKEN_BALANCES_PAGE_LIMIT');
});

test('Alchemy token balance timeout is bounded and sanitized', async () => {
  const provider = { send: () => new Promise(() => {}) };
  await assert.rejects(
    fetchAllErc20Balances(provider, 'ethereum-mainnet', wallet().address),
    (error) => error.code === 'PROVIDER_TIMEOUT' && !error.message.includes('test-alchemy-key')
  );
});

test('Alchemy token balance item cap marks an oversized page incomplete', async () => {
  let calls = 0;
  const provider = {
    send: async () => {
      calls += 1;
      return {
        tokenBalances: Array.from({ length: 250 }, (_, index) => ({
          contractAddress: `0x${(index + 1).toString(16).padStart(40, '0')}`,
          tokenBalance: '0x1'
        }))
      };
    }
  };
  const result = await fetchAllErc20Balances(provider, 'ethereum-mainnet', wallet().address);
  assert.equal(calls, 1);
  assert.equal(result.tokenBalances.length, 200);
  assert.equal(result.tokenBalancesAvailable, false);
  assert.equal(result.tokenBalancesReason, 'TOKEN_BALANCES_PAGE_LIMIT');
});

test('Alchemy and CoinGecko pricing time out and preserve unpriced fallback', async () => {
  const requested = [];
  global.fetch = (url, options) => {
    requested.push(String(url).includes('coingecko') ? 'coingecko' : 'alchemy');
    return waitForAbort(url, options);
  };
  const price = await fetchChainEthUsdPrice('ethereum-mainnet');
  assert.equal(price, null);
  assert.deepEqual(requested, ['alchemy', 'coingecko']);
});

test('Alchemy ETH price keeps its last successful value after provider timeouts', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    global.fetch = async () => jsonResponse({
      data: [{ symbol: 'ETH', prices: [{ currency: 'usd', value: '3500' }] }]
    });
    assert.equal(await fetchChainEthUsdPrice('ethereum-mainnet'), 3500);
    now += 5 * 60 * 1000 + 1;
    global.fetch = waitForAbort;
    assert.equal(await fetchChainEthUsdPrice('ethereum-mainnet'), 3500);
  } finally {
    Date.now = realNow;
  }
});

test('Zerion pagination stops at the page cap and caches an explicit partial result', async () => {
  const target = wallet();
  let calls = 0;
  global.fetch = async (url, options) => {
    calls += 1;
    assert.ok(options.signal instanceof AbortSignal);
    const next = new URL(String(url));
    next.searchParams.set('page[after]', String(calls));
    return jsonResponse({
      data: [{ id: `position-${calls}`, attributes: { value: calls, name: 'Asset' } }],
      included: [],
      links: { next: next.href }
    });
  };
  const result = await fetchWalletPositionsForChain(target);
  assert.equal(calls, 2);
  assert.equal(result.positions.length, 2);
  assert.equal(result.isPartial, true);
  assert.deepEqual(result.partialReasons, ['ZERION_PAGE_LIMIT:ethereum-mainnet']);
  await fetchWalletPositionsForChain(target);
  assert.equal(calls, 2);
});

test('Zerion timeout returns partial data and reuses last known good cache', async () => {
  const target = wallet();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    global.fetch = async () => jsonResponse({
      data: [{ id: 'position-good', attributes: { value: 42, name: 'Asset' } }],
      included: [],
      links: {}
    });
    const good = await fetchWalletPositionsForChain(target);
    assert.equal(good.positions.length, 1);
    assert.equal(good.isPartial, false);

    now += 61_000;
    global.fetch = waitForAbort;
    const fallback = await fetchWalletPositionsForChain(target);
    assert.equal(fallback.positions.length, 1);
    assert.equal(fallback.isPartial, true);
    assert.deepEqual(fallback.partialReasons, ['ZERION_TIMEOUT:ethereum-mainnet']);
  } finally {
    Date.now = realNow;
  }
});

test('Zerion item cap prevents retaining an oversized page as complete', async () => {
  const target = wallet();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({
      data: Array.from({ length: 250 }, (_, index) => ({
        id: `position-${index}`,
        attributes: { value: 1, name: 'Asset' }
      })),
      included: [],
      links: {}
    });
  };
  const result = await fetchWalletPositionsForChain(target);
  assert.equal(calls, 1);
  assert.equal(result.positions.length, 200);
  assert.equal(result.isPartial, true);
});

test('Zerion never forwards credentials to a cross-origin pagination link', async () => {
  const target = wallet();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ data: [], included: [], links: { next: 'https://attacker.example/steal' } });
  };
  const result = await fetchWalletPositionsForChain(target);
  assert.equal(calls, 1);
  assert.equal(result.isPartial, true);
  assert.deepEqual(result.partialReasons, ['FETCH_FAILED:ethereum-mainnet']);
});

test('positions API returns a partial response when Zerion times out', async () => {
  const userId = randomUUID();
  const walletId = randomUUID();
  const address = wallet().address;
  global.fetch = waitForAbort;
  await query('INSERT INTO app_users (id, email) VALUES ($1, $2)', [userId, `provider-${userId}@example.test`]);
  try {
    await query(
      'INSERT INTO tracked_wallets (id, user_id, chain_id, address, status) VALUES ($1, $2, $3, $4, $5)',
      [walletId, userId, 'ethereum-mainnet', address, 'active']
    );
    const token = await createAccessToken({ id: userId });
    const response = await request(createApp())
      .get(`/api/v1/wallets/${walletId}/positions`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.isPartial, true);
    assert.deepEqual(response.body.data.partialReasons, ['ZERION_TIMEOUT:ethereum-mainnet']);
  } finally {
    await query('DELETE FROM tracked_wallets WHERE id = $1', [walletId]);
    await query('DELETE FROM app_users WHERE id = $1', [userId]);
  }
});

test('Zerion rate-limit cooldown avoids another provider request', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, json: async () => ({ error: 'rate limited' }) };
  };
  const limited = await fetchWalletPositionsForChain(wallet());
  assert.equal(limited.isPartial, true);
  assert.deepEqual(limited.partialReasons, ['ZERION_RATE_LIMITED:ethereum-mainnet']);
  const cooldown = await fetchWalletPositionsForChain(wallet());
  assert.equal(cooldown.isPartial, true);
  assert.deepEqual(cooldown.partialReasons, ['ZERION_COOLDOWN_ACTIVE:ethereum-mainnet']);
  assert.equal(calls, 1);
});

test('provider error diagnostics omit credential-bearing messages', () => {
  const failure = new Error('https://api.example/v2/test-alchemy-key failed');
  failure.code = 'test-alchemy-key';
  failure.name = 'test-alchemy-key';
  const diagnostic = safeProviderError('alchemy', 'token_metadata', failure);
  assert.equal(diagnostic.errorCode, null);
  assert.equal(diagnostic.errorName, 'Error');
  assert.equal(JSON.stringify(diagnostic).includes('test-alchemy-key'), false);
});
