import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFirebaseDeliveryError } from '../src/modules/notifications/firebaseDeliveryErrors.js';

test('only confirmed invalid registration tokens are classified for cleanup', () => {
  assert.equal(classifyFirebaseDeliveryError({
    code: 'messaging/registration-token-not-registered'
  }).kind, 'invalid_token');
  assert.equal(classifyFirebaseDeliveryError({
    code: 'messaging/invalid-registration-token'
  }).kind, 'invalid_token');
  assert.equal(classifyFirebaseDeliveryError({
    code: 'messaging/invalid-argument',
    message: 'The registration token is not a valid FCM registration token.'
  }).kind, 'invalid_token');
  assert.equal(classifyFirebaseDeliveryError({
    code: 'messaging/invalid-argument',
    message: 'Invalid data payload'
  }).kind, 'permanent');
});

test('transient Firebase failures remain retryable without persisting raw messages', () => {
  assert.deepEqual(classifyFirebaseDeliveryError({
    code: 'messaging/server-unavailable',
    message: 'sensitive provider details'
  }), { kind: 'transient', reason: 'messaging/server-unavailable' });
  assert.deepEqual(classifyFirebaseDeliveryError({
    code: 'messaging/invalid-payload',
    message: 'bad payload'
  }), { kind: 'permanent', reason: 'messaging/invalid-payload' });
});
