import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL_MODE: z.string().refine(
    (value) => ['disable', 'verify-full'].includes(value),
    'DATABASE_SSL_MODE must be disable or verify-full'
  ).optional(),
  DATABASE_SSL_CA_FILE: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1).default(5_000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  DATABASE_MIGRATION_LOCK_WAIT_TIMEOUT_MS: z.coerce.number().int().min(1).default(10_000),
  DATABASE_MIGRATION_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(5_000),
  DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1).default(300_000),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
  JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GLOBAL_API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  GLOBAL_API_RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(300),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  AUTH_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_REGISTER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  DEFAULT_WALLET_ALERT_MINIMUM_USD: z.coerce.number().positive().default(100),
  ENABLE_PUSH_NOTIFICATIONS: z.preprocess((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      return value === 'true';
    }

    return false;
  }, z.boolean()),
  ENABLE_ETHEREUM_TRACKER: z.preprocess((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      return value === 'true';
    }

    return false;
  }, z.boolean()),
  ENABLE_PORTFOLIO_SNAPSHOT_JOB: z.preprocess((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      return value === 'true';
    }

    return true;
  }, z.boolean()),
  PORTFOLIO_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  ALCHEMY_NOTIFY_API_KEY: z.string().optional(),
  ALCHEMY_NOTIFY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID: z.string().optional(),
  ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET: z.string().optional(),
  ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET: z.string().optional(),
  ALCHEMY_RECONCILE_WATCHED_ADDRESSES_JSON: z.string().optional(),
  ALCHEMY_RECONCILE_WATCHED_ADDRESSES_FILE: z.string().optional(),
  ALCHEMY_ETHEREUM_RPC_URL: z.string().optional(),
  ALCHEMY_BASE_RPC_URL: z.string().optional(),
  ALCHEMY_WEBHOOK_SIGNING_SECRET: z.string().optional(),
  ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET: z.string().optional(),
  ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET: z.string().optional(),
  ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV: z.preprocess(
    (value) => value === 'true' || value === true,
    z.boolean()
  ),
  ETHEREUM_RPC_URL: z.string().optional(),
  ETHEREUM_CONFIRMATIONS: z.coerce.number().int().min(0).default(6),
  ETHEREUM_BATCH_SIZE: z.coerce.number().int().positive().max(2_000).default(250),
  ETHEREUM_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  ETHEREUM_START_BLOCK: z.coerce.number().int().min(0).default(0),
  ETHEREUM_RPC_REQUEST_DELAY_MS: z.coerce.number().int().min(500).default(1_000),
  ETHEREUM_RPC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(5),
  ETHEREUM_RPC_BACKOFF_BASE_MS: z.coerce.number().int().min(500).default(1_000),
  ETHEREUM_RESET_SYNC_CURSOR: z.preprocess((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      return value === 'true';
    }

    return false;
  }, z.boolean()),
  FIREBASE_DRY_RUN: z.preprocess((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      return value === 'true';
    }

    return false;
  }, z.boolean()),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FIREBASE_ANDROID_NOTIFICATION_CHANNEL_ID: z.string().default('fcm_fallback_notification_channel'),
  DEBANK_ACCESS_KEY: z.string().optional(),
  ZERION_API_KEY: z.string().optional(),
  ETHEREUM_TRACE_FROM_ADDRESS: z.string().optional(),
  ETHEREUM_TRACE_TO_ADDRESS: z.string().optional(),
  ETHEREUM_TRACE_TX_HASH: z.string().optional()
}).superRefine((config, context) => {
  if (config.NODE_ENV !== 'production') {
    return;
  }

  for (const key of [
    'ALCHEMY_NOTIFY_API_KEY',
    'ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET',
    'ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET',
    'ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET',
    'ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET'
  ]) {
    if (!config[key]?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required in production`
      });
    }
  }

  if (config.ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV'],
      message: 'Unsigned Alchemy webhooks are not allowed in production'
    });
  }

  if (
    config.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET &&
    config.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET === config.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET'],
      message: 'Ethereum and Base webhook IDs must be different'
    });
  }

  if (
    config.ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET &&
    config.ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET === config.ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET'],
      message: 'Ethereum and Base webhook signing secrets must be different'
    });
  }
});

export function parseEnvironment(values) {
  return envSchema.parse(values);
}

export const env = parseEnvironment(process.env);
