import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnvironment } from '../src/config/env.js';
import { createTransactionalEmail } from '../src/services/transactionalEmail.js';

const testConfig = {
  NODE_ENV: 'development',
  AUTH_EMAIL_DELIVERY_MODE: 'resend',
  RESEND_API_KEY: 're_test_private_key',
  AUTH_EMAIL_FROM: 'ChainBell <no-reply@example.test>'
};

test('Resend adapter sends minimal transactional content and hides provider failures', async () => {
  const calls = [];
  const logs = [];
  const log = { error(fields, message) { logs.push({ fields, message }); } };
  const adapter = createTransactionalEmail(testConfig, async (url, options) => {
    calls.push({ url, options });
    return { ok: true };
  });
  await adapter.sendVerificationCode('recipient@example.test', '001234');
  await adapter.sendPasswordResetCode('recipient@example.test', '987654');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${testConfig.RESEND_API_KEY}`);
  assert.deepEqual(JSON.parse(calls[0].options.body).to, ['recipient@example.test']);
  assert.match(JSON.parse(calls[0].options.body).text, /001234.*10 minutes.*ignore this email/);
  assert.match(JSON.parse(calls[1].options.body).subject, /Reset/);

  const failing = createTransactionalEmail(testConfig, async () => { throw new Error('re_test_private_key raw provider URL'); }, 10_000, log);
  await assert.rejects(failing.sendVerificationCode('recipient@example.test', '001234'), (error) => {
    assert.equal(error.code, 'EMAIL_DELIVERY_FAILED');
    assert.equal(JSON.stringify(error).includes(testConfig.RESEND_API_KEY), false);
    assert.equal(error.message.includes(testConfig.RESEND_API_KEY), false);
    return true;
  });
  assert.equal(logs[0].fields.failureType, 'transport');
  assert.equal(logs[0].fields.providerStatus, null);
  assert.equal(JSON.stringify(logs[0]).includes(testConfig.RESEND_API_KEY), false);

  const hanging = createTransactionalEmail(testConfig, () => new Promise(() => {}), 10, log);
  await assert.rejects(hanging.sendVerificationCode('recipient@example.test', '001234'),
    (error) => error.code === 'EMAIL_DELIVERY_FAILED');
  assert.equal(logs[1].fields.failureType, 'timeout');
});

test('Resend HTTP errors log selected provider fields while keeping the thrown error generic', async () => {
  const logs = [];
  const log = { error(fields, message) { logs.push({ fields, message }); } };
  const adapter = createTransactionalEmail(testConfig, async () => ({
    ok: false,
    status: 403,
    headers: { get(name) { return name === 'x-request-id' ? 'req_safe_123' : null; } },
    async json() {
      return {
        name: 'validation_error',
        message: 'You can only send testing emails to your own email address (recipient@example.test).'
      };
    }
  }), 10_000, log);
  await assert.rejects(adapter.sendVerificationCode('recipient@example.test', '001234'),
    (error) => error.code === 'EMAIL_DELIVERY_FAILED' && error.message === 'Transactional email delivery failed');
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].fields, {
    provider: 'resend',
    operation: 'verification',
    failureType: 'response',
    providerStatus: 403,
    providerErrorCode: 'validation_error',
    providerErrorType: 'validation_error',
    providerErrorMessage: 'You can only send testing emails to your own email address ([redacted]).',
    providerRequestId: 'req_safe_123'
  });
});

test('provider diagnostics cannot echo API keys, auth codes, email body, or headers', async () => {
  const logs = [];
  const log = { error(fields) { logs.push(fields); } };
  const adapter = createTransactionalEmail(testConfig, async () => ({
    ok: false,
    status: 422,
    headers: { get(name) { return name === 'x-request-id' ? testConfig.RESEND_API_KEY : null; } },
    async json() {
      return {
        code: testConfig.RESEND_API_KEY,
        type: 'validation_error',
        message: `Authorization: Bearer ${testConfig.RESEND_API_KEY}; code 001234; recipient@example.test; https://example.test/private; ChainBell: use 001234 to verify your email.`,
        request_id: 'req_safe_456'
      };
    }
  }), 10_000, log);
  await assert.rejects(adapter.sendVerificationCode('recipient@example.test', '001234'),
    (error) => error.code === 'EMAIL_DELIVERY_FAILED');
  assert.equal(logs[0].providerErrorCode, null);
  assert.equal(logs[0].providerErrorType, 'validation_error');
  assert.equal(logs[0].providerErrorMessage, '[redacted provider message]');
  assert.equal(logs[0].providerRequestId, null);
  const serialized = JSON.stringify(logs);
  for (const sensitive of [testConfig.RESEND_API_KEY, '001234', 'recipient@example.test', 'https://example.test/private', 'Authorization: Bearer']) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

test('provider message redaction preserves useful text and accepts a safe body request id', async () => {
  const logs = [];
  const log = { error(fields) { logs.push(fields); } };
  const adapter = createTransactionalEmail(testConfig, async () => ({
    ok: false,
    status: 400,
    headers: { get() { return null; } },
    async json() {
      return {
        code: 'validation_error',
        request_id: 'req_body_789',
        message: `Invalid sender for recipient@example.test; key ${testConfig.RESEND_API_KEY}; code 001234; see https://example.test/private`
      };
    }
  }), 10_000, log);
  await assert.rejects(adapter.sendVerificationCode('recipient@example.test', '001234'));
  assert.equal(logs[0].providerRequestId, 'req_body_789');
  assert.match(logs[0].providerErrorMessage, /^Invalid sender for/);
  for (const sensitive of [testConfig.RESEND_API_KEY, '001234', 'recipient@example.test', 'https://example.test/private']) {
    assert.equal(JSON.stringify(logs).includes(sensitive), false);
  }
});

test('test mode does not send even with Resend configured', async () => {
  let called = false;
  const adapter = createTransactionalEmail({ ...testConfig, NODE_ENV: 'test' }, async () => { called = true; });
  await assert.rejects(adapter.sendVerificationCode('recipient@example.test', '123456'),
    (error) => error.code === 'EMAIL_DELIVERY_UNAVAILABLE');
  assert.equal(called, false);
});

test('Resend configuration is validated in development and required in production', () => {
  const base = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://localhost:5432/test',
    JWT_SECRET: 'test_jwt_secret_that_is_long_enough_for_email_checks',
    AUTH_EMAIL_DELIVERY_MODE: 'disabled'
  };
  assert.equal(parseEnvironment(base).AUTH_EMAIL_DELIVERY_MODE, 'disabled');
  assert.throws(() => parseEnvironment({ ...base, AUTH_EMAIL_DELIVERY_MODE: 'resend' }));
  assert.throws(() => parseEnvironment({ ...base, ...testConfig, AUTH_EMAIL_FROM: 'bad\r\nheader' }));
  assert.throws(() => parseEnvironment({ ...base, NODE_ENV: 'production' }));
});
