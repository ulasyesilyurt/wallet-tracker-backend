import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { login, me, register } from './auth.controller.js';
import { loginSchema, registerSchema } from './auth.schemas.js';

const router = Router();

router.post('/auth/register', validate(registerSchema), register);
router.post('/auth/login', validate(loginSchema), login);
router.get('/auth/me', authenticate, me);

export const authRouter = router;
