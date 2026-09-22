import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');
const MIGRATION_LOCK_NAMESPACE = 48291;
const MIGRATION_LOCK_KEY = 1;

async function listMigrationFiles() {
  return (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

async function ensureSchemaMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function acquireMigrationLock(client) {
  logger.info(
    {
      namespace: MIGRATION_LOCK_NAMESPACE,
      key: MIGRATION_LOCK_KEY
    },
    'Waiting for schema migration advisory lock'
  );

  await client.query('SELECT set_config($1, $2, false)', [
    'statement_timeout',
    String(env.DATABASE_MIGRATION_LOCK_WAIT_TIMEOUT_MS)
  ]);
  await client.query('SELECT pg_advisory_lock($1, $2)', [
    MIGRATION_LOCK_NAMESPACE,
    MIGRATION_LOCK_KEY
  ]);

  await client.query('SELECT set_config($1, $2, false)', [
    'statement_timeout',
    String(env.DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS)
  ]);
  await client.query('SELECT set_config($1, $2, false)', [
    'lock_timeout',
    String(env.DATABASE_MIGRATION_LOCK_TIMEOUT_MS)
  ]);

  logger.info(
    {
      namespace: MIGRATION_LOCK_NAMESPACE,
      key: MIGRATION_LOCK_KEY
    },
    'Acquired schema migration advisory lock'
  );
}

async function releaseMigrationLock(client) {
  await client.query('SELECT pg_advisory_unlock($1, $2)', [
    MIGRATION_LOCK_NAMESPACE,
    MIGRATION_LOCK_KEY
  ]);

  logger.info(
    {
      namespace: MIGRATION_LOCK_NAMESPACE,
      key: MIGRATION_LOCK_KEY
    },
    'Released schema migration advisory lock'
  );
}

async function getAppliedMigrationFilenames(client) {
  const result = await client.query(`
    SELECT filename
    FROM schema_migrations
    ORDER BY filename ASC
  `);

  return new Set(result.rows.map((row) => row.filename));
}

async function run() {
  let client;
  let lockAcquired = false;

  try {
    client = await pool.connect();
    await acquireMigrationLock(client);
    lockAcquired = true;
    await ensureSchemaMigrationsTable(client);

    const files = await listMigrationFiles();
    const appliedMigrations = await getAppliedMigrationFilenames(client);

    for (const file of files) {
      if (appliedMigrations.has(file)) {
        logger.info({ file }, 'Skipping already applied migration');
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');

      logger.info({ file }, 'Applying migration');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `
            INSERT INTO schema_migrations (filename)
            VALUES ($1)
          `,
          [file]
        );
        await client.query('COMMIT');
        appliedMigrations.add(file);
        logger.info({ file }, 'Applied migration successfully');
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error({ errorName: error.name, errorCode: error.code ?? null, file }, 'Migration failed');
        throw error;
      }
    }

    logger.info('Migrations completed successfully');
  } catch (error) {
    logger.error({ errorName: error.name, errorCode: error.code ?? null }, 'Migration run failed');
    process.exitCode = 1;
  } finally {
    if (lockAcquired) {
      try {
        await releaseMigrationLock(client);
      } catch (error) {
        logger.error({ errorName: error.name, errorCode: error.code ?? null }, 'Failed to release schema migration advisory lock');
        process.exitCode = 1;
      }
    }

    client?.release();
    await pool.end();
  }
}

run();
