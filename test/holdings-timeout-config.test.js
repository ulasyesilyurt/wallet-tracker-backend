import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnvironment } from '../src/config/env.js';

const baseEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/wallet_tracker_test',
  JWT_SECRET: 'test_jwt_secret_that_is_long_enough_for_holdings_checks'
};

test('holdings chain timeout defaults to 30 seconds and accepts an override', () => {
  assert.equal(parseEnvironment(baseEnvironment).HOLDINGS_CHAIN_TIMEOUT_MS, 30_000);
  assert.equal(parseEnvironment({
    ...baseEnvironment,
    HOLDINGS_CHAIN_TIMEOUT_MS: '45000'
  }).HOLDINGS_CHAIN_TIMEOUT_MS, 45_000);
});
