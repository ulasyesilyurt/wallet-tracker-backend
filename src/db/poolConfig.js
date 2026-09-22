import fs from 'node:fs';

const SSL_URL_PARAMETERS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

export function createPoolConfig(config) {
  let url;
  try {
    url = new URL(config.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error('Unsupported database URL protocol');
    }
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }

  const urlHasSsl = SSL_URL_PARAMETERS.some((parameter) => url.searchParams.has(parameter));
  if (['statement_timeout', 'query_timeout', 'connectionTimeoutMillis', 'idleTimeoutMillis', 'application_name', 'options']
    .some((parameter) => url.searchParams.has(parameter))) {
    throw new Error('Configure database pool timeouts and application name outside DATABASE_URL');
  }
  const sslMode = config.DATABASE_SSL_MODE ?? (config.NODE_ENV === 'production' ? 'verify-full' : 'disable');
  const caFile = config.DATABASE_SSL_CA_FILE?.trim();

  if (urlHasSsl && (config.DATABASE_SSL_MODE || caFile)) {
    throw new Error('Configure database TLS in either DATABASE_URL or DATABASE_SSL_MODE/DATABASE_SSL_CA_FILE');
  }
  if (caFile && sslMode !== 'verify-full') {
    throw new Error('DATABASE_SSL_CA_FILE requires DATABASE_SSL_MODE=verify-full');
  }
  if (config.NODE_ENV === 'production') {
    const urlSslMode = url.searchParams.get('sslmode');
    const urlSsl = url.searchParams.get('ssl');
    if (urlSsl && !['true', '1'].includes(urlSsl)) {
      throw new Error('Production DATABASE_URL cannot disable TLS');
    }
    if (urlHasSsl && (urlSslMode ? urlSslMode !== 'verify-full' : !['true', '1'].includes(urlSsl))) {
      throw new Error('Production DATABASE_URL must use sslmode=verify-full or ssl=true');
    }
    if (!urlHasSsl && sslMode !== 'verify-full') {
      throw new Error('Production database TLS must use verify-full');
    }
  }

  const poolConfig = {
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: config.DATABASE_IDLE_TIMEOUT_MS,
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: 'wallet-tracker-backend'
  };

  if (!urlHasSsl) {
    if (sslMode === 'disable') {
      poolConfig.ssl = false;
    } else if (caFile) {
      try {
        poolConfig.ssl = { ca: fs.readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
      } catch {
        throw new Error('DATABASE_SSL_CA_FILE could not be read');
      }
    } else {
      poolConfig.ssl = { rejectUnauthorized: true };
    }
  }

  // pg-pool copies enumerable options; keep JSON diagnostics free of URL and CA material.
  poolConfig.toJSON = () => ({
    max: poolConfig.max,
    connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
    idleTimeoutMillis: poolConfig.idleTimeoutMillis,
    statement_timeout: poolConfig.statement_timeout,
    application_name: poolConfig.application_name,
    tlsEnabled: urlHasSsl
      ? url.searchParams.get('sslmode') !== 'disable' && !['0', 'false'].includes(url.searchParams.get('ssl'))
      : sslMode === 'verify-full'
  });

  return poolConfig;
}
