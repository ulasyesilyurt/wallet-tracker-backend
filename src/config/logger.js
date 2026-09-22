import pino from 'pino';
import { env } from './env.js';

const sensitiveHeaders = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-operations-token',
  'x-alchemy-token',
  'x-alchemy-signature'
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req', 'res'].flatMap((key) =>
      sensitiveHeaders.map((header) => `${key}.headers["${header}"]`)
    )
  }
});
