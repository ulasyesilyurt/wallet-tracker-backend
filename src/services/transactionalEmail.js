import { env } from '../config/env.js';

function deliveryError() {
  const error = new Error('Transactional email delivery failed');
  error.code = 'EMAIL_DELIVERY_FAILED';
  return error;
}

export function createTransactionalEmail(config = env, http = fetch, timeoutMs = 10_000) {
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
    try {
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
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(deliveryError());
          }, timeoutMs);
        })
      ]);
      if (!response.ok) throw deliveryError();
    } catch {
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
