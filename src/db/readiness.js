import { pool } from './pool.js';

export const DATABASE_READINESS_TIMEOUT_MS = 3_000;

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
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
