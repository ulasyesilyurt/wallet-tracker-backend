import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authLoginRateLimiter, authRegisterRateLimiter } from '../../middlewares/rateLimit.js';
import { login, me, register } from './auth.controller.js';
import { loginSchema, registerSchema } from './auth.schemas.js';

const router = Router();

router.post('/auth/register', authRegisterRateLimiter, validate(registerSchema), register);
router.post('/auth/login', authLoginRateLimiter, validate(loginSchema), login);
router.get('/auth/me', authenticate, me);

export const authRouter = router;
