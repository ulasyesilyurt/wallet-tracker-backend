import pino from 'pino';
import { env } from '../config/env.js';
import { pool } from './pool.js';
import { safeErrorDetails } from '../utils/safeError.js';

export const DATABASE_READINESS_TIMEOUT_MS = 3_000;
const readinessLogger = pino({ level: env.LOG_LEVEL, base: null });

const DATABASE_ERROR_CATEGORIES = new Map([
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
const DATABASE_ERROR_NAMES = new Set(['Error', 'DatabaseError', 'TypeError', 'AggregateError']);

export function databaseReadinessErrorDetails(error) {
  const safe = safeErrorDetails(error);
  const errorName = DATABASE_ERROR_NAMES.has(safe.errorName) ? safe.errorName : 'Error';
  const errorCode = DATABASE_ERROR_CATEGORIES.has(safe.errorCode) ? safe.errorCode : null;
  const category = DATABASE_ERROR_CATEGORIES.get(errorCode) ??
    (error?.message === 'Database readiness timeout' || error?.message === 'Query read timeout'
      ? 'timeout' : 'unknown');
  return { errorName, errorCode, category };
}

export async function checkDatabaseReadiness({
  dbPool = pool,
  timeoutMs = DATABASE_READINESS_TIMEOUT_MS
} = {}) {
  let timeout;

  try {
    await Promise.race([
      dbPool.query({ text: 'SELECT 1', query_timeout: timeoutMs }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Database readiness timeout')), timeoutMs);
      })
    ]);
    return true;
  } catch (error) {
    readinessLogger.warn(
      databaseReadinessErrorDetails(error),
      'PostgreSQL readiness check failed'
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
