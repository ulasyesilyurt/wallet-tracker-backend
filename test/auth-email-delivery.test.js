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

  const failing = createTransactionalEmail(testConfig, async () => { throw new Error('re_test_private_key raw provider URL'); });
  await assert.rejects(failing.sendVerificationCode('recipient@example.test', '001234'), (error) => {
    assert.equal(error.code, 'EMAIL_DELIVERY_FAILED');
    assert.equal(JSON.stringify(error).includes(testConfig.RESEND_API_KEY), false);
    assert.equal(error.message.includes(testConfig.RESEND_API_KEY), false);
    return true;
  });
  const hanging = createTransactionalEmail(testConfig, () => new Promise(() => {}), 10);
  await assert.rejects(hanging.sendVerificationCode('recipient@example.test', '001234'),
    (error) => error.code === 'EMAIL_DELIVERY_FAILED');
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
