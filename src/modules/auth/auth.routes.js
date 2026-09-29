import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, authenticateAllowUnverified, authenticateForLogout } from '../../middlewares/authenticate.js';
import {
  authCodeRequestRateLimiter, authCodeVerifyRateLimiter,
  authAppleRateLimiter,
  authGoogleRateLimiter, authIdentityManagementRateLimiter,
  authLoginRateLimiter, authRefreshRateLimiter, authRegisterRateLimiter
} from '../../middlewares/rateLimit.js';
import {
  createAppleSignInController, createGoogleSignInController,
  createIdentityLinkController, createIdentityUnlinkController,
  login, me, refresh, register
} from './auth.controller.js';
import {
  appleSignInSchema, forgotPasswordSchema, googleSignInSchema,
  linkIdentitySchema, loginSchema, registerSchema, resetPasswordSchema,
  unlinkIdentitySchema, verifyEmailSchema
} from './auth.schemas.js';
import { transactionalEmail } from '../../services/transactionalEmail.js';
import { getCurrentUser, logoutUser } from './auth.service.js';
import { requestEmailVerification, requestPasswordReset, resetPassword, verifyEmailCode } from './challenge.service.js';
import { createGoogleSignIn } from './google.service.js';
import { verifyGoogleIdToken } from './google.verifier.js';
import { createAppleSignIn } from './apple.service.js';
import { verifyAppleIdToken } from './apple.verifier.js';
import { createIdentityManagement } from './identityManagement.service.js';

export function createAuthRouter(emailService = transactionalEmail, {
  googleVerifier = verifyGoogleIdToken,
  appleVerifier = verifyAppleIdToken
} = {}) {
  const router = Router();
  const identityManagement = createIdentityManagement({ googleVerifier, appleVerifier });

  router.post('/auth/register', authRegisterRateLimiter, validate(registerSchema), register);
  router.post('/auth/login', authLoginRateLimiter, validate(loginSchema), login);
  router.post('/auth/google', authGoogleRateLimiter, validate(googleSignInSchema),
    createGoogleSignInController(createGoogleSignIn({ verifyToken: googleVerifier })));
  router.post('/auth/apple', authAppleRateLimiter, validate(appleSignInSchema),
    createAppleSignInController(createAppleSignIn({ verifyToken: appleVerifier })));
  router.post('/auth/identities/link', authIdentityManagementRateLimiter, authenticate,
    validate(linkIdentitySchema), createIdentityLinkController(identityManagement));
  router.delete('/auth/identities/:provider', authIdentityManagementRateLimiter, authenticate,
    validate(unlinkIdentitySchema), createIdentityUnlinkController(identityManagement));
  router.post('/auth/refresh', authRefreshRateLimiter, refresh);
  router.post('/auth/logout', authenticateForLogout, async (req, res) => {
    res.status(200).json({ data: await logoutUser(req.auth) });
  });
  router.get('/auth/me', authenticateAllowUnverified, me);
  router.post('/auth/email-verification/request', authCodeRequestRateLimiter, authenticateAllowUnverified, async (req, res) => {
    res.status(202).json({ data: await requestEmailVerification(req.auth.user, emailService) });
  });
  router.post('/auth/email-verification/verify', authCodeVerifyRateLimiter, authenticateAllowUnverified, validate(verifyEmailSchema), async (req, res) => {
    const user = await verifyEmailCode(req.auth.user, req.validated.body.code);
    res.status(200).json({ data: { user: getCurrentUser(user) } });
  });
  router.post('/auth/forgot-password', authCodeRequestRateLimiter, validate(forgotPasswordSchema), async (req, res) => {
    res.status(202).json({ data: await requestPasswordReset(req.validated.body.email, emailService) });
  });
  router.post('/auth/reset-password', authCodeVerifyRateLimiter, validate(resetPasswordSchema), async (req, res) => {
    res.status(200).json({ data: await resetPassword(req.validated.body) });
  });

  return router;
}
