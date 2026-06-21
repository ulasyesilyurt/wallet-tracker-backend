import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { addDeviceToken, deleteDeviceToken } from './deviceTokens.controller.js';
import { createDeviceTokenSchema, deleteDeviceTokenSchema } from './deviceTokens.schemas.js';

const router = Router();

router.post('/users/:userId/device-tokens', authenticate, validate(createDeviceTokenSchema), addDeviceToken);
router.delete('/users/:userId/device-tokens', authenticate, validate(deleteDeviceTokenSchema), deleteDeviceToken);

export const deviceTokensRouter = router;
