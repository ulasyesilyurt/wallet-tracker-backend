import { createAccessToken } from '../../utils/jwt.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { HttpError } from '../../utils/httpError.js';
import { createUser, findUserByEmail } from './auth.repository.js';

const EMAIL_UNIQUE_CONSTRAINTS = new Set([
  'app_users_email_key',
  'idx_app_users_email_normalized_unique'
]);

function emailInUseError() {
  return new HttpError(409, 'AUTH_EMAIL_IN_USE', 'An account with that email already exists.');
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

async function buildAuthResponse(user) {
  return {
    user: sanitizeUser(user),
    accessToken: await createAccessToken(user)
  };
}

export async function registerUser({ email, password, name }) {
  const existingUser = await findUserByEmail(email);

  if (existingUser) {
    throw emailInUseError();
  }

  const passwordHash = await hashPassword(password);
  let user;
  try {
    user = await createUser({
      email,
      passwordHash,
      name
    });
  } catch (error) {
    if (error?.code === '23505' && EMAIL_UNIQUE_CONSTRAINTS.has(error.constraint)) {
      throw emailInUseError();
    }
    throw error;
  }

  return buildAuthResponse(user);
}

export async function loginUser({ email, password }) {
  const user = await findUserByEmail(email);

  if (!user?.passwordHash) {
    throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  const isPasswordValid = await verifyPassword(password, user.passwordHash);

  if (!isPasswordValid) {
    throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  return buildAuthResponse(user);
}

export function getCurrentUser(user) {
  return sanitizeUser(user);
}
