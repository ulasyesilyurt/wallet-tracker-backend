import { HttpError } from '../../utils/httpError.js';
import { buildAuthResponse } from './auth.service.js';
import { emailSchema } from './auth.schemas.js';
import { verifyGoogleIdToken } from './google.verifier.js';
import { createRefreshCredential } from './refreshToken.js';
import { identityUniqueConflict } from './identity.repository.js';
import { createGoogleAccountWithSession, createSessionForGoogleSubject } from './google.repository.js';

const EMAIL_UNIQUE_CONSTRAINTS = new Set([
  'app_users_email_key',
  'idx_app_users_email_normalized_unique'
]);

function linkRequired() {
  return new HttpError(409, 'AUTH_LINK_REQUIRED', 'Sign in to your existing account to link Google.');
}

function emailRequired() {
  return new HttpError(422, 'AUTH_EMAIL_REQUIRED', 'A usable email address is required to create an account.');
}

// Google's authority for Gmail is tied to the Gmail address. For Workspace,
// require email_verified and an hd claim matching the email's domain.
export function googleEmailIsTrusted(email, identity) {
  if (!identity.emailVerified) return false;
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return domain === 'gmail.com' ||
    (typeof identity.hostedDomain === 'string' && identity.hostedDomain.toLowerCase() === domain);
}

export function createGoogleSignIn({ verifyToken = verifyGoogleIdToken } = {}) {
  return async function signInGoogle(idToken, { issueRefreshToken = false } = {}) {
    // Verification precedes every database lookup and write.
    const identity = await verifyToken(idToken);
    const refreshCredential = issueRefreshToken ? createRefreshCredential() : null;
    let account = await createSessionForGoogleSubject(identity.subject, refreshCredential);
    if (account) return buildAuthResponse(account.user, account.sessionId, refreshCredential);

    const parsedEmail = emailSchema.safeParse(identity.email);
    if (!parsedEmail.success) throw emailRequired();
    const email = parsedEmail.data.toLowerCase();
    try {
      account = await createGoogleAccountWithSession({
        email,
        subject: identity.subject,
        emailVerified: googleEmailIsTrusted(email, identity),
        refreshCredential
      });
    } catch (error) {
      const emailConflict = error?.code === '23505' && EMAIL_UNIQUE_CONSTRAINTS.has(error.constraint);
      const subjectConflict = identityUniqueConflict(error) === 'subject_taken';
      if (!emailConflict && !subjectConflict) throw error;

      // A concurrent request may have just created this same Google identity.
      // Only that exact subject may be reused; a shared email never links users.
      account = await createSessionForGoogleSubject(identity.subject, refreshCredential);
      if (!account) throw linkRequired();
    }
    return buildAuthResponse(account.user, account.sessionId, refreshCredential);
  };
}
