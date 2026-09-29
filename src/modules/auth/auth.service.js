import { createAccessToken } from '../../utils/jwt.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { HttpError } from '../../utils/httpError.js';
import { createUserWithSession, findUserByEmail } from './auth.repository.js';
import { createSessionForPassword, revokeLegacyAccess, revokeSession, rotateRefreshToken } from './session.repository.js';
import { createRefreshCredential } from './refreshToken.js';

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
    emailVerified: Boolean(user.emailVerifiedAt),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

async function buildAuthResponse(user, sessionId, refreshCredential) {
  return {
    user: sanitizeUser(user),
    accessToken: await createAccessToken(user, sessionId),
    ...(refreshCredential ? { refreshToken: refreshCredential.token } : {})
  };
}

export async function registerUser({ email, password, name }, { issueRefreshToken = false } = {}) {
  const existingUser = await findUserByEmail(email);

  if (existingUser) {
    throw emailInUseError();
  }

  const passwordHash = await hashPassword(password);
  const refreshCredential = issueRefreshToken ? createRefreshCredential() : null;
  let account;
  try {
    account = await createUserWithSession({
      email,
      passwordHash,
      name,
      refreshCredential
    });
  } catch (error) {
    if (error?.code === '23505' && EMAIL_UNIQUE_CONSTRAINTS.has(error.constraint)) {
      throw emailInUseError();
    }
    throw error;
  }

  return buildAuthResponse(account.user, account.sessionId, refreshCredential);
}

export async function loginUser({ email, password }, { issueRefreshToken = false } = {}) {
  const user = await findUserByEmail(email);

  if (!user?.passwordHash) {
    throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  const isPasswordValid = await verifyPassword(password, user.passwordHash);

  if (!isPasswordValid) {
    throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  const refreshCredential = issueRefreshToken ? createRefreshCredential() : null;
  const sessionId = await createSessionForPassword(user.id, user.passwordHash, refreshCredential);
  if (!sessionId) {
    throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid email or password.');
  }
  return buildAuthResponse(user, sessionId, refreshCredential);
}

export async function refreshUser(refreshToken) {
  const refreshed = await rotateRefreshToken(refreshToken);
  return {
    user: sanitizeUser(refreshed.user),
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken
  };
}

export async function logoutUser({ user, payload }) {
  if (payload.sid) {
    await revokeSession(payload.sid, user.id);
  } else {
    await revokeLegacyAccess(user.id, payload.iat);
  }
  return { message: 'Logged out.' };
}

export function getCurrentUser(user) {
  return sanitizeUser(user);
}
