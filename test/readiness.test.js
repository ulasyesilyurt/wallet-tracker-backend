import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'dev_jwt_secret_that_is_long_enough_for_local_checks';

const supertest = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');
const { checkDatabaseReadiness, databaseReadinessErrorDetails } =
  await import('../src/db/readiness.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createProductionEnvironment(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    JWT_SECRET: 'test_jwt_secret_that_is_long_enough_for_readiness_checks',
    ENABLE_PUSH_NOTIFICATIONS: 'false',
    ENABLE_ETHEREUM_TRACKER: 'false',
    ENABLE_PORTFOLIO_SNAPSHOT_JOB: 'false',
    ALCHEMY_NOTIFY_API_KEY: 'test-notify-key',
    ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET: 'wh_readiness_ethereum',
    ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET: 'wh_readiness_base',
    ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET: 'test-readiness-ethereum-secret',
    ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET: 'test-readiness-base-secret',
    ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV: 'false',
    AUTH_EMAIL_DELIVERY_MODE: 'resend',
    RESEND_API_KEY: 're_test_readiness_only',
    AUTH_EMAIL_FROM: 'ChainBell <no-reply@example.test>',
    ...overrides
  };
}

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function spawnBackend(environment) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: repoRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return {
    child,
    exited: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    output: () => output
  };
}

test('health remains live and readiness tracks a healthy then unavailable database', async () => {
  let databaseReady = true;
  const request = supertest(createApp({ checkDatabase: async () => databaseReady }));

  const live = await request.get('/api/v1/health');
  const ready = await request.get('/api/v1/ready');
  databaseReady = false;
  const unavailable = await request.get('/api/v1/ready');
  const stillLive = await request.get('/api/v1/health');

  assert.equal(live.status, 200);
  assert.equal(live.body.status, 'ok');
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body, { status: 'ok' });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, { status: 'not_ready' });
  assert.equal(stillLive.status, 200);
});

test('database check is a bounded SELECT 1 and readiness hides raw errors', async () => {
  let queryConfig;
  const healthy = await checkDatabaseReadiness({
    dbPool: { query: async (config) => { queryConfig = config; return { rows: [{ '?column?': 1 }] }; } },
    timeoutMs: 25
  });
  const failed = await checkDatabaseReadiness({
    dbPool: { query: async () => { throw new Error('connection secret should stay private'); } },
    timeoutMs: 25
  });
  const bounded = await checkDatabaseReadiness({
    dbPool: { query: () => new Promise(() => {}) },
    timeoutMs: 10
  });
  const response = await supertest(createApp({
    checkDatabase: async () => { throw new Error('connection secret should stay private'); }
  })).get('/api/v1/ready');

  assert.equal(healthy, true);
  assert.deepEqual(queryConfig, { text: 'SELECT 1', query_timeout: 25 });
  assert.equal(failed, false);
  assert.equal(bounded, false);
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { status: 'not_ready' });
  assert.equal(JSON.stringify(response.body).includes('connection secret'), false);
});

test('readiness diagnostics expose only safe error fields and fixed categories', () => {
  const categories = new Map([
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_certificate_trust'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls_certificate_trust'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_certificate_trust'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_hostname_mismatch'],
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'connection_refused'],
    ['ETIMEDOUT', 'timeout'],
    ['28P01', 'authentication_failed'],
    ['3D000', 'database_not_found']
  ]);
  const secret = 'private-user private-password private-host';
  for (const [code, category] of categories) {
    const error = Object.assign(new Error(secret), { code, connectionString: secret,
      query: 'SELECT private_value', parameters: [secret] });
    assert.deepEqual(databaseReadinessErrorDetails(error), {
      errorName: 'Error', errorCode: code, category
    });
  }
  for (const message of ['Database readiness timeout', 'Query read timeout']) {
    assert.deepEqual(databaseReadinessErrorDetails(new Error(message)), {
      errorName: 'Error', errorCode: null, category: 'timeout'
    });
  }
  assert.deepEqual(databaseReadinessErrorDetails(Object.assign(new Error(secret), {
    name: 'PrivatePasswordError', code: 'PRIVATE_PASSWORD', stack: secret
  })), { errorName: 'Error', errorCode: null, category: 'unknown' });
  assert.deepEqual(databaseReadinessErrorDetails(Object.assign(new Error(secret), {
    name: 'DatabaseError', code: '28P01'
  })), { errorName: 'DatabaseError', errorCode: '28P01', category: 'authentication_failed' });
});

test('readiness warning omits hostname and raw connection details', () => {
  const script = `
    import { checkDatabaseReadiness } from './src/db/readiness.js';
    await checkDatabaseReadiness({ dbPool: { query: async () => {
      const error = new Error('private-user private-password private-host');
      error.code = 'ECONNREFUSED';
      throw error;
    } } });
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'warn' }
  });
  const warning = JSON.parse(output.trim());
  assert.deepEqual(Object.keys(warning).sort(),
    ['level', 'time', 'msg', 'errorName', 'errorCode', 'category'].sort());
  assert.deepEqual([warning.errorName, warning.errorCode, warning.category],
    ['Error', 'ECONNREFUSED', 'connection_refused']);
  assert.equal(output.includes('private-user'), false);
  assert.equal(output.includes('private-password'), false);
  assert.equal(output.includes('private-host'), false);
});

test('readiness reports a worker that has not started or is shutting down', async () => {
  let workerReady = false;
  let shuttingDown = false;
  const request = supertest(createApp({
    checkDatabase: async () => true,
    isWorkerReady: () => workerReady,
    isShuttingDown: () => shuttingDown
  }));

  assert.equal((await request.get('/api/v1/ready')).status, 503);
  workerReady = true;
  assert.equal((await request.get('/api/v1/ready')).status, 200);
  shuttingDown = true;
  assert.equal((await request.get('/api/v1/ready')).status, 503);
});

test('production startup refuses to listen when PostgreSQL is unavailable', async () => {
  const port = await unusedPort();
  const processHandle = spawnBackend(createProductionEnvironment({
    PORT: String(port),
    DATABASE_URL: 'postgresql://127.0.0.1:1/wallet_tracker_unavailable'
  }));

  const result = await Promise.race([
    processHandle.exited,
    delay(7_000, undefined, { ref: false }).then(() => ({ code: null, signal: 'timeout' }))
  ]);
  if (result.signal === 'timeout') {
    processHandle.child.kill('SIGKILL');
  }
  assert.equal(result.code, 1, processHandle.output());
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/v1/health`));
  assert.equal(processHandle.output().includes('wallet_tracker_unavailable'), false);
});

test('SIGTERM closes the HTTP server and database pool before exit', async () => {
  const port = await unusedPort();
  const processHandle = spawnBackend(createProductionEnvironment({ NODE_ENV: 'test', PORT: String(port) }));

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (processHandle.child.exitCode != null) {
        break;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/ready`);
        ready = response.status === 200;
        if (ready) {
          break;
        }
      } catch {
        // The listener is not open yet.
      }
      await delay(50);
    }
    assert.equal(ready, true, processHandle.output());

    processHandle.child.kill('SIGTERM');
    const result = await Promise.race([
      processHandle.exited,
      delay(3_000, undefined, { ref: false }).then(() => ({ code: null, signal: 'timeout' }))
    ]);
    assert.deepEqual(result, { code: 0, signal: null }, processHandle.output());
    const structuredLogs = processHandle.output().trim().split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    const startup = structuredLogs.find((entry) => entry.event === 'process_start');
    const shutdownStarted = structuredLogs.find((entry) => entry.event === 'graceful_shutdown_started');
    const shutdownCompleted = structuredLogs.find((entry) => entry.event === 'graceful_shutdown_completed');
    assert.equal(startup.appVersion, '1.0.0');
    assert.equal(startup.nodeEnv, 'test');
    assert.ok(startup.processStartedAt);
    assert.equal(shutdownStarted.reason, 'SIGTERM');
    assert.equal(shutdownCompleted.reason, 'SIGTERM');
    assert.equal(shutdownCompleted.exitCode, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/v1/health`));
  } finally {
    if (processHandle.child.exitCode == null) {
      processHandle.child.kill('SIGKILL');
    }
  }
});
