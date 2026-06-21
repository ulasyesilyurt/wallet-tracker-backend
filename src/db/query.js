import { pool } from './pool.js';

export async function query(text, params) {
  return pool.query(text, params);
}
