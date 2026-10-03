import { logger } from '../../config/logger.js';
import { HttpError } from '../../utils/httpError.js';
import { deleteAccountWithAuthorization } from './accountDeletion.repository.js';

export async function deleteAccount(auth, { deletionAuthorization }) {
  const sessionId = auth.payload.sid;
  if (!sessionId) {
    throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'A session-backed access token is required.');
  }

  const { affectedAlchemyPairCount } = await deleteAccountWithAuthorization({
    userId: auth.user.id,
    sessionId,
    authorization: deletionAuthorization
  });

  try {
    logger.info({ affectedAlchemyPairCount }, 'Account permanently deleted');
  } catch {
    // The database commit is final even when post-commit logging fails.
  }
  return { deleted: true };
}
