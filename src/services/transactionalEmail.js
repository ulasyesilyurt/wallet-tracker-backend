import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

function safeIdentifier(value, context) {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value) || value.toLowerCase().startsWith('re_')) return null;
  if ([context.config.RESEND_API_KEY, context.code].filter(Boolean).some((secret) => value.includes(secret))) return null;
  return value;
}

function safeProviderMessage(value, { config, code, to }) {
  if (typeof value !== 'string') return null;
  // Provider messages can echo request fields. Keep useful validation text, not
  // addresses, credentials, the challenge code, URLs, or email content.
  if (/<[^>]+>|ChainBell: use|This code expires|If you did not request/i.test(value)) {
    return '[redacted provider message]';
  }
  let message = value;
  for (const secret of [config.RESEND_API_KEY, config.AUTH_EMAIL_FROM, to, code].filter(Boolean)) {
    message = message.replaceAll(secret, '[redacted]');
  }
  return message
    .replace(/authorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, 'authorization: [redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bre_[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b\d{6}\b/g, '[redacted-code]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 300) || null;
}

function responseDiagnostics(response, body, context) {
  const error = body && typeof body === 'object' ? (body.error && typeof body.error === 'object' ? body.error : body) : {};
  const requestId = response.headers?.get?.('x-request-id') ??
    response.headers?.get?.('x-resend-request-id') ??
    response.headers?.get?.('request-id') ??
    error.request_id ?? error.requestId;
  return {
    providerStatus: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null,
    providerErrorCode: safeIdentifier(error.code ?? error.name, context),
    providerErrorType: safeIdentifier(error.type ?? error.name, context),
    providerErrorMessage: safeProviderMessage(error.message, context),
    providerRequestId: safeIdentifier(requestId, context)
  };
}

function deliveryError() {
  const error = new Error('Transactional email delivery failed');
  error.code = 'EMAIL_DELIVERY_FAILED';
  return error;
}

export function createTransactionalEmail(config = env, http = fetch, timeoutMs = 10_000, log = logger) {
  async function send({ to, subject, code, purpose }) {
    // Tests must never contact an external email service, even if a local env file opts in.
    if (config.NODE_ENV === 'test' || config.AUTH_EMAIL_DELIVERY_MODE !== 'resend') {
      const error = new Error('Transactional email delivery is not configured');
      error.code = 'EMAIL_DELIVERY_UNAVAILABLE';
      throw error;
    }
    const action = purpose === 'verification' ? 'verify your email' : 'reset your password';
    const text = `ChainBell: use ${code} to ${action}. This code expires in 10 minutes. If you did not request this, ignore this email.`;
    const html = `<p>Use this code to ${action} for ChainBell:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>This code expires in 10 minutes. If you did not request this, ignore this email.</p>`;
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    let responseFailureLogged = false;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(deliveryError());
        }, timeoutMs);
      });
      const response = await Promise.race([
        http('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ from: config.AUTH_EMAIL_FROM, to: [to], subject, text, html }),
          signal: controller.signal
        }),
        deadline
      ]);
      if (!response.ok) {
        let body;
        try {
          body = await Promise.race([response.json(), deadline]);
        } catch {
          body = null;
        }
        log.error({
          provider: 'resend',
          operation: purpose,
          failureType: timedOut ? 'timeout' : 'response',
          ...responseDiagnostics(response, body, { config, code, to })
        }, 'Resend email delivery failed');
        responseFailureLogged = true;
        throw deliveryError();
      }
    } catch (error) {
      if (!responseFailureLogged) {
        log.error({
          provider: 'resend',
          operation: purpose,
          failureType: timedOut ? 'timeout' : 'transport',
          providerStatus: null,
          providerErrorCode: safeIdentifier(error?.cause?.code ?? error?.code, { config, code }),
          providerErrorType: safeIdentifier(error?.name, { config, code }),
          providerErrorMessage: timedOut ? 'Resend request timed out' : 'Resend request failed before an HTTP response',
          providerRequestId: null
        }, 'Resend email delivery failed');
      }
      // Do not propagate provider bodies, headers, URLs, or credentials into API/log errors.
      throw deliveryError();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    sendVerificationCode(to, code) {
      return send({ to, code, purpose: 'verification', subject: 'Verify your ChainBell email' });
    },
    sendPasswordResetCode(to, code) {
      return send({ to, code, purpose: 'reset', subject: 'Reset your ChainBell password' });
    }
  };
}

export const transactionalEmail = createTransactionalEmail();
