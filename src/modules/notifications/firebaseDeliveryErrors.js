const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
]);

const PERMANENT_CODES = new Set([
  'messaging/invalid-argument',
  'messaging/invalid-recipient',
  'messaging/invalid-payload',
  'messaging/invalid-data-payload-key',
  'messaging/payload-size-limit-exceeded',
  'messaging/invalid-options',
  'messaging/mismatched-credential',
  'messaging/third-party-auth-error',
  'messaging/authentication-error'
]);

function describesInvalidRegistrationToken(message) {
  return /\binvalid registration token\b/i.test(message) ||
    /\bregistration token (?:is|was) (?:not a valid|not valid|invalid|expired|unregistered)\b/i.test(message);
}

export function classifyFirebaseDeliveryError(error) {
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';

  if (INVALID_TOKEN_CODES.has(code) ||
      (code === 'messaging/invalid-argument' && describesInvalidRegistrationToken(error?.message ?? ''))) {
    return { kind: 'invalid_token', reason: 'invalid_registration_token' };
  }

  if (PERMANENT_CODES.has(code)) {
    return { kind: 'permanent', reason: code };
  }

  // Network, quota, service, and unknown errors get bounded retries through the outbox.
  return { kind: 'transient', reason: /^[a-z0-9/_-]{1,100}$/.test(code) ? code : 'firebase_send_error' };
}
