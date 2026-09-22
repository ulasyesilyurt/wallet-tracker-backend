import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_network_checks';
process.env.LOG_LEVEL = 'silent';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '3';
process.env.AUTH_LOGIN_RATE_LIMIT_MAX = '2';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '2';
process.env.ALCHEMY_NOTIFY_API_KEY = 'test-network-notify-key';
process.env.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET = 'wh_network_eth';
process.env.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET = 'wh_network_base';
process.env.ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET = 'network-eth-secret';
process.env.ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET = 'network-base-secret';

const { parseEnvironment } = await import('../src/config/env.js');
const { createTrustProxy } = await import('../src/config/network.js');
const { createApp } = await import('../src/app.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function networkConfig(overrides = {}) {
  return parseEnvironment({ ...process.env, ...overrides });
}

function ipProbe(config) {
  const app = express();
  app.set('trust proxy', createTrustProxy(config));
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  return app;
}

const trustedLoopback = {
  TRUST_PROXY_HOPS: '1',
  TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128'
};

test('direct and untrusted peers cannot spoof client IP with X-Forwarded-For', async () => {
  const direct = ipProbe(networkConfig());
  const directIp = (await request(direct).get('/')).body.ip;
  const spoofed = await request(direct).get('/').set('X-Forwarded-For', '203.0.113.10');
  assert.equal(spoofed.body.ip, directIp);

  const untrusted = ipProbe(networkConfig({
    TRUST_PROXY_HOPS: '1',
    TRUST_PROXY_CIDRS: '10.0.0.0/8'
  }));
  const ignored = await request(untrusted).get('/').set('X-Forwarded-For', '203.0.113.10');
  assert.equal(ignored.body.ip, directIp);
});

test('one trusted proxy hop selects the nearest forwarded client IP', async () => {
  const app = ipProbe(networkConfig(trustedLoopback));
  const response = await request(app).get('/')
    .set('X-Forwarded-For', '198.51.100.55, 203.0.113.10');
  assert.equal(response.body.ip, '203.0.113.10');
});

test('login, registration, and API limits group by resolved client IP', async () => {
  const app = createApp({}, networkConfig(trustedLoopback));
  const forwarded = (client, spoof = '198.51.100.55') => `${spoof}, ${client}`;

  for (const spoof of ['198.51.100.55', '198.51.100.56']) {
    const response = await request(app).post('/api/v1/auth/login')
      .set('X-Forwarded-For', forwarded('203.0.113.10', spoof)).send({});
    assert.equal(response.status, 400);
  }
  const loginLimited = await request(app).post('/api/v1/auth/login')
    .set('X-Forwarded-For', forwarded('203.0.113.10')).send({});
  assert.equal(loginLimited.status, 429);
  assert.equal(loginLimited.body.error.code, 'RATE_LIMITED');
  assert.equal((await request(app).post('/api/v1/auth/login')
    .set('X-Forwarded-For', forwarded('203.0.113.11')).send({})).status, 400);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await request(app).post('/api/v1/auth/register')
      .set('X-Forwarded-For', forwarded('203.0.113.20')).send({})).status, 400);
  }
  assert.equal((await request(app).post('/api/v1/auth/register')
    .set('X-Forwarded-For', forwarded('203.0.113.20')).send({})).status, 429);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await request(app).get('/api/v1/no-such-route')
      .set('X-Forwarded-For', forwarded('203.0.113.30'))).status, 404);
  }
  assert.equal((await request(app).get('/api/v1/no-such-route')
    .set('X-Forwarded-For', forwarded('203.0.113.30'))).status, 429);
  assert.equal((await request(app).get('/api/v1/no-such-route')
    .set('X-Forwarded-For', forwarded('203.0.113.31'))).status, 404);
});

test('production CORS permits only configured HTTPS origins and allowed preflight', async () => {
  const app = createApp({}, networkConfig({
    NODE_ENV: 'production',
    CORS_ALLOWED_ORIGINS: 'https://app.example.test,https://admin.example.test'
  }));

  const allowed = await request(app).get('/api/v1/health').set('Origin', 'https://app.example.test');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://app.example.test');
  assert.equal(allowed.headers['access-control-allow-credentials'], undefined);
  const secondAllowed = await request(app).get('/api/v1/health').set('Origin', 'https://admin.example.test');
  assert.equal(secondAllowed.headers['access-control-allow-origin'], 'https://admin.example.test');

  const denied = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example.test');
  assert.equal(denied.status, 403);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  assert.equal(denied.body.error.code, 'CORS_ORIGIN_DENIED');

  const native = await request(app).get('/api/v1/health');
  assert.equal(native.status, 200);
  assert.equal(native.headers['access-control-allow-origin'], undefined);

  const preflight = await request(app).options('/api/v1/auth/login')
    .set('Origin', 'https://app.example.test')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'authorization,content-type');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://app.example.test');
  assert.match(preflight.headers['access-control-allow-methods'], /POST/);
  assert.equal(preflight.headers['access-control-allow-headers'], 'authorization,content-type');
});

test('origin-less signed Alchemy webhooks still reach their handler', async () => {
  const app = createApp({}, networkConfig({ NODE_ENV: 'production' }));
  const browser = await request(app).get('/api/v1/health').set('Origin', 'https://unlisted.example.test');
  assert.equal(browser.status, 403);
  const body = JSON.stringify({
    webhookId: 'wh_network_eth',
    id: 'evt_network_cors',
    type: 'ADDRESS_ACTIVITY',
    event: { network: 'ETH_MAINNET', activity: [] }
  });
  const signature = crypto.createHmac('sha256', 'network-eth-secret').update(body).digest('hex');
  const response = await request(app).post('/api/v1/webhooks/alchemy')
    .set('Content-Type', 'application/json')
    .set('X-Alchemy-Signature', signature)
    .send(body);
  assert.equal(response.status, 202);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('development CORS remains permissive for local tooling', async () => {
  const app = createApp({}, networkConfig({ NODE_ENV: 'development' }));
  const response = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:19006');
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], '*');
});

test('invalid proxy and production CORS configuration fails validation', () => {
  const invalid = [
    { TRUST_PROXY_HOPS: '-1' },
    { TRUST_PROXY_HOPS: 'true' },
    { TRUST_PROXY_HOPS: '1' },
    { TRUST_PROXY_CIDRS: '127.0.0.1/32' },
    { TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: '0.0.0.0/0' },
    { TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: 'proxy.example.test' },
    { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '*' },
    { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'http://app.example.test' },
    { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.example.test/path' },
    { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.example.test,' }
  ];
  for (const overrides of invalid) {
    assert.throws(() => networkConfig(overrides));
  }
  assert.deepEqual(networkConfig({ NODE_ENV: 'production' }).CORS_ALLOWED_ORIGINS, '');
});

test('invalid proxy trust or production CORS fails startup', () => {
  for (const overrides of [
    { TRUST_PROXY_HOPS: '1', TRUST_PROXY_CIDRS: '' },
    { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '*' }
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/app.js';"], {
      cwd: repoRoot,
      env: { ...process.env, ...overrides },
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0, result.stderr);
  }
});
