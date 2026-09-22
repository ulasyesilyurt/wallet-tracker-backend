import { FetchRequest, JsonRpcProvider } from 'ethers';

const SAFE_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'AbortError',
  'ProviderTimeoutError', 'ProviderRequestError'
]);
const SAFE_ERROR_CODES = new Set([
  'PROVIDER_TIMEOUT', 'PROVIDER_PAGE_LIMIT', 'PROVIDER_INVALID_RESPONSE',
  'PROVIDER_INVALID_PAGINATION', 'PROVIDER_REQUEST_FAILED', 'TIMEOUT',
  'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'SERVER_ERROR',
  'NETWORK_ERROR', 'BAD_DATA', 'CALL_EXCEPTION', '429', '-32000'
]);

export function createTimedRpcProvider(url, timeoutMs) {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  return new JsonRpcProvider(request);
}

export async function withProviderTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Provider request timed out');
          error.code = 'PROVIDER_TIMEOUT';
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function fetchWithTimeout(url, options = {}, timeoutMs) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

export function safeProviderError(provider, operation, error) {
  const name = SAFE_ERROR_NAMES.has(error?.name) ? error.name : 'Error';
  const rawCode = error?.code == null ? null : String(error.code);
  const code = SAFE_ERROR_CODES.has(rawCode) ? rawCode : null;
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? error.status
    : null;
  return {
    provider,
    operation,
    errorName: name,
    errorCode: code,
    status,
    isTimeout: ['PROVIDER_TIMEOUT', 'TIMEOUT', 'ETIMEDOUT'].includes(code) ||
      name === 'TimeoutError' || name === 'AbortError'
  };
}

export function toSafeProviderError(provider, operation, error) {
  const details = safeProviderError(provider, operation, error);
  const safeError = new Error(`${provider} ${operation} request failed`);
  safeError.name = details.isTimeout ? 'ProviderTimeoutError' : 'ProviderRequestError';
  safeError.code = details.isTimeout ? 'PROVIDER_TIMEOUT' : details.errorCode ?? 'PROVIDER_REQUEST_FAILED';
  safeError.status = details.status;
  return safeError;
}
