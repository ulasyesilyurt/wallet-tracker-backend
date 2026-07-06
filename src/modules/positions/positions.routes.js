import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { validate } from '../../middlewares/validate.js';
import { getPositions } from './positions.controller.js';
import { walletPositionsParamsSchema } from './positions.schemas.js';

const router = Router();

router.get('/wallets/:walletId/positions', authenticate, validate(walletPositionsParamsSchema), getPositions);

export const positionsRouter = router;
