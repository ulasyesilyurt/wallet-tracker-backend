import { query } from '../../db/query.js';

function mapUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createUser({ email, passwordHash, name }) {
  const result = await query(
    `
      INSERT INTO app_users (email, password_hash, name)
      VALUES (LOWER($1), $2, $3)
      RETURNING id, email, name, password_hash, created_at, updated_at
    `,
    [email, passwordHash, name ?? null]
  );

  return mapUser(result.rows[0]);
}

export async function findUserByEmail(email) {
  const result = await query(
    `
      SELECT id, email, name, password_hash, created_at, updated_at
      FROM app_users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `,
    [email]
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserById(userId) {
  const result = await query(
    `
      SELECT id, email, name, password_hash, created_at, updated_at
      FROM app_users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}
