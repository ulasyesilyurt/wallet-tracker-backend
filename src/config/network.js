import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';

export function parseProxyCidrs(value = '') {
  if (!value.trim()) {
    return [];
  }

  const entries = value.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    const parts = entry.split('/');
    const family = isIP(parts[0]);
    const maximumPrefix = family === 4 ? 32 : 128;
    if (!family || parts.length > 2 || (parts.length === 2 &&
      (!/^\d+$/.test(parts[1]) || Number(parts[1]) < 1 || Number(parts[1]) > maximumPrefix))) {
      throw new Error('TRUST_PROXY_CIDRS must contain IP addresses or bounded CIDR ranges');
    }
  }
  return entries;
}

export function createTrustProxy(config) {
  if (config.TRUST_PROXY_HOPS === 0) {
    return () => false;
  }
  const trustedAddresses = proxyaddr.compile(parseProxyCidrs(config.TRUST_PROXY_CIDRS));
  return (address, hop) => hop < config.TRUST_PROXY_HOPS && trustedAddresses(address);
}

export function parseAllowedOrigins(value = '', nodeEnv = 'development') {
  if (!value.trim()) {
    return [];
  }

  const origins = value.split(',').map((origin) => origin.trim());
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('CORS_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) ||
        (nodeEnv === 'production' && parsed.protocol !== 'https:') ||
        parsed.origin !== origin || parsed.username || parsed.password ||
        origin.includes('*')) {
      throw new Error('CORS_ALLOWED_ORIGINS must contain exact HTTPS origins in production');
    }
  }

  if (new Set(origins).size !== origins.length) {
    throw new Error('CORS_ALLOWED_ORIGINS contains duplicate origins');
  }
  return origins;
}
