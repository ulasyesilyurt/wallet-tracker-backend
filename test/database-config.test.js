import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { parseEnvironment } from '../src/config/env.js';
import { createPoolConfig } from '../src/db/poolConfig.js';

const secret = 'never-print-this-database-password';
const databaseUrl = `postgresql://user:${secret}@db.example.test:5432/wallet_tracker`;

function config(overrides = {}) {
  return parseEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    JWT_SECRET: 'test_jwt_secret_that_is_long_enough_for_database_checks',
    ALCHEMY_NOTIFY_API_KEY: 'test-key',
    ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET: 'test-eth-id',
    ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET: 'test-base-id',
    ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET: 'test-eth-secret',
    ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET: 'test-base-secret',
    ...overrides
  });
}

test('local pool uses no TLS and bounded, configurable limits', () => {
  const local = createPoolConfig(config({
    DATABASE_POOL_MAX: '4',
    DATABASE_CONNECTION_TIMEOUT_MS: '2000',
    DATABASE_IDLE_TIMEOUT_MS: '12000',
    DATABASE_STATEMENT_TIMEOUT_MS: '15000'
  }));
  assert.equal(local.ssl, false);
  assert.equal(local.max, 4);
  assert.equal(local.connectionTimeoutMillis, 2000);
  assert.equal(local.idleTimeoutMillis, 12000);
  assert.equal(local.statement_timeout, 15000);
  assert.equal(local.application_name, 'wallet-tracker-backend');
  assert.equal(JSON.stringify(local).includes(secret), false);
});

test('production defaults to verified TLS and accepts a CA file', () => {
  const production = createPoolConfig(config({ NODE_ENV: 'production' }));
  assert.deepEqual(production.ssl, { rejectUnauthorized: true });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-db-ca-'));
  const caFile = path.join(directory, 'root.pem');
  try {
    fs.writeFileSync(caFile, 'sample CA certificate');
    const withCa = createPoolConfig(config({
      NODE_ENV: 'production',
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_SSL_CA_FILE: caFile
    }));
    assert.deepEqual(withCa.ssl, { ca: 'sample CA certificate', rejectUnauthorized: true });
    assert.equal(JSON.stringify(withCa).includes('sample CA certificate'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('URL TLS parameters are left to pg without competing pool TLS settings', () => {
  const fromUrl = createPoolConfig(config({
    NODE_ENV: 'production',
    DATABASE_URL: `${databaseUrl}?sslmode=verify-full`
  }));
  assert.equal(Object.hasOwn(fromUrl, 'ssl'), false);
  const fromBooleanUrl = createPoolConfig(config({
    NODE_ENV: 'production',
    DATABASE_URL: `${databaseUrl}?ssl=true`
  }));
  assert.equal(Object.hasOwn(fromBooleanUrl, 'ssl'), false);
});

test('unsafe or conflicting TLS settings fail without disclosing credentials', () => {
  const cases = [
    () => createPoolConfig(config({ NODE_ENV: 'production', DATABASE_SSL_MODE: 'disable' })),
    () => createPoolConfig(config({ NODE_ENV: 'production', DATABASE_URL: `${databaseUrl}?sslmode=disable` })),
    () => createPoolConfig(config({ NODE_ENV: 'production', DATABASE_URL: `${databaseUrl}?sslmode=no-verify` })),
    () => createPoolConfig(config({ NODE_ENV: 'production', DATABASE_URL: `${databaseUrl}?sslmode=verify-full&ssl=false` })),
    () => createPoolConfig(config({ DATABASE_URL: `${databaseUrl}?sslmode=verify-full`, DATABASE_SSL_MODE: 'verify-full' })),
    () => createPoolConfig(config({ DATABASE_URL: `${databaseUrl}?statement_timeout=0` })),
    () => createPoolConfig(config({ DATABASE_SSL_CA_FILE: '/missing/private-ca.pem' })),
    () => createPoolConfig(config({ NODE_ENV: 'production', DATABASE_SSL_CA_FILE: '/missing/private-ca.pem' })),
    () => createPoolConfig(config({ DATABASE_URL: `not-a-url-${secret}` })),
    () => config({ DATABASE_SSL_MODE: `invalid-${secret}` })
  ];
  for (const run of cases) {
    assert.throws(run, (error) => {
      assert.equal(String(error).includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
  }
});

test('pool configuration JSON omits connection credentials and CA material', async () => {
  const pool = new pg.Pool(createPoolConfig(config()));
  try {
    const serialized = JSON.stringify(pool.options);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(databaseUrl), false);
    assert.match(serialized, /"tlsEnabled":false/);
  } finally {
    await pool.end();
  }
});
