import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
  JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
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
  ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID: z.string().optional(),
  ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET: z.string().optional(),
  ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET: z.string().optional(),
  ALCHEMY_RECONCILE_WATCHED_ADDRESSES_JSON: z.string().optional(),
  ALCHEMY_RECONCILE_WATCHED_ADDRESSES_FILE: z.string().optional(),
  ALCHEMY_ETHEREUM_RPC_URL: z.string().optional(),
  ALCHEMY_BASE_RPC_URL: z.string().optional(),
  ALCHEMY_WEBHOOK_SIGNING_SECRET: z.string().optional(),
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
});

export const env = envSchema.parse(process.env);
