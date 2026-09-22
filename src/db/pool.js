import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createPoolConfig } from './poolConfig.js';

const { Pool } = pg;

export const pool = new Pool(createPoolConfig(env));

pool.on('error', (error) => {
  logger.error({
    errorName: error.name,
    errorCode: error.code ?? null
  }, 'PostgreSQL idle client error');
});
