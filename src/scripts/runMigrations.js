import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../config/logger.js';
import { pool } from '../db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');

async function run() {
  const client = await pool.connect();

  try {
    const files = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      logger.info({ file }, 'Running migration');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    }

    logger.info('Migrations completed successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ err: error }, 'Migration failed');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
